'use strict';

const fs = require('node:fs');

const CHECKPOINT_INTERVAL = 1024 * 1024;
const OPEN_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

class RangeTransferError extends Error {
  constructor(message, code = 'TRANSFER_ERROR', { retryable = false } = {}) {
    super(message);
    this.name = 'RangeTransferError';
    this.code = code;
    this.retryable = retryable;
  }
}

function strongEtag(value) {
  return typeof value === 'string' && value.length <= 1024 && !/^W\//i.test(value) && /^"[^"\r\n]*"$/.test(value)
    ? value : null;
}

function validateResumeState(state, totalBytes) {
  if (!state || typeof state !== 'object') return null;
  const offset = Number(state.offset);
  const total = Number(state.totalBytes);
  const etag = strongEtag(state.etag);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= totalBytes || total !== totalBytes || !etag) return null;
  return { offset, totalBytes, etag };
}

function parseContentRange(value) {
  const match = typeof value === 'string' && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const [, startText, endText, totalText] = match;
  const start = Number(startText), end = Number(endText), total = Number(totalText);
  return [start, end, total].every(Number.isSafeInteger) && start >= 0 && end >= start && total > end
    ? { start, end, total } : null;
}

function transient(error) {
  if (error?.retryable === true) return true;
  if (error?.code === 'ABORT_ERR') return true;
  return ['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error?.code);
}

function transferError(message, code, retryable = false) {
  return new RangeTransferError(message, code, { retryable });
}

async function safeCheckpoint(callback, value) {
  if (!callback) return;
  await callback(value);
}

async function verifiedFile(file, destination, errorPrefix) {
  const [descriptorStat, pathStat] = await Promise.all([file.stat(), fs.promises.lstat(destination)]);
  if (!descriptorStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile()
    || descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
    throw transferError(`${errorPrefix} partial file is not a regular file.`, 'UNSAFE_DESTINATION');
  }
  return descriptorStat;
}

/**
 * Transfer a validated local-server original. `request(headers)` must use a
 * fixed provider route and return an HTTP response without following redirects.
 * Range responses are accepted only when their validator and byte range match.
 */
async function rangeTransfer({
  request,
  destination,
  totalBytes,
  signal,
  onProgress,
  resumeState,
  onCheckpoint,
  retainOnError = false,
  revalidate,
  errorPrefix = 'Media server',
  isProviderError = () => false,
  mapError,
}) {
  if (typeof request !== 'function') throw new TypeError('request is required');
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw transferError(`${errorPrefix} did not provide the original file size.`, 'INVALID_SIZE');
  const hasResumeState = resumeState !== undefined && resumeState !== null;
  const resumable = hasResumeState || typeof onCheckpoint === 'function' || retainOnError;
  let checkpoint = validateResumeState(resumeState, totalBytes);
  let file;
  let response;
  let responseError;
  let offset = 0;
  let resumedBytes = 0;
  let validator = null;
  let opened = false;
  let shouldDelete = true;
  let lastCheckpoint = 0;

  const write = async (buffer, position) => {
    let written = 0;
    while (written < buffer.length) {
      const result = await file.write(buffer, written, buffer.length - written, position + written);
      if (!result.bytesWritten) throw transferError(`${errorPrefix} download could not be written to disk.`, 'FILE_WRITE');
      written += result.bytesWritten;
    }
  };

  const persist = async (force = false) => {
    if (!resumable || !validator || offset <= 0 || (!force && offset - lastCheckpoint < CHECKPOINT_INTERVAL)) return;
    await file.sync();
    await safeCheckpoint(onCheckpoint, { offset, totalBytes, etag: validator });
    lastCheckpoint = offset;
  };

  const clearPartial = async () => {
    if (file) await file.truncate(0);
    offset = 0;
    resumedBytes = 0;
    validator = null;
    checkpoint = null;
    lastCheckpoint = 0;
    await safeCheckpoint(onCheckpoint, null);
  };

  try {
    if (signal?.aborted) throw transferError(`${errorPrefix} download cancelled.`, 'ABORT_ERR', true);
    if (checkpoint) {
      try {
        file = await fs.promises.open(destination, fs.constants.O_RDWR | OPEN_NOFOLLOW, 0o600);
        const stat = await verifiedFile(file, destination, errorPrefix);
        opened = true;
        if (stat.size < checkpoint.offset) {
          // Keep the descriptor pinned to the verified regular file and restart
          // from zero; never unlink a path that may have changed after open.
          await file.truncate(0);
          checkpoint = null;
        } else {
          await file.truncate(checkpoint.offset);
          offset = checkpoint.offset;
          resumedBytes = offset;
          validator = checkpoint.etag;
          lastCheckpoint = offset;
        }
      } catch (error) {
        if (file) { await file.close().catch(() => {}); file = null; }
        if (error.code !== 'ENOENT') throw error;
        checkpoint = null;
      }
    }
    if (!file) {
      if (hasResumeState) {
        // An explicitly supplied but invalid checkpoint owns this job path.
        try { file = await fs.promises.open(destination, fs.constants.O_RDWR | OPEN_NOFOLLOW, 0o600); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (file) {
          await verifiedFile(file, destination, errorPrefix);
          await file.truncate(0);
        } else file = await fs.promises.open(destination, 'wx+', 0o600);
      } else {
        file = await fs.promises.open(destination, 'wx+', 0o600);
      }
      opened = true;
    }

    const fetch = async useRange => {
      const headers = useRange ? { Range: `bytes=${offset}-`, 'If-Range': validator } : {};
      return request(headers);
    };

    if (checkpoint && typeof revalidate === 'function') {
      const valid = await revalidate();
      if (!valid) throw transferError(`${errorPrefix} source changed. Restart the download.`, 'SOURCE_CHANGED');
    }

    response = await fetch(Boolean(checkpoint));
    response.on?.('error', error => { responseError = error; });

    if (response.statusCode === 416 && checkpoint) {
      response.destroy?.();
      responseError = undefined;
      const valid = typeof revalidate === 'function' ? await revalidate() : false;
      if (!valid) throw transferError(`${errorPrefix} source changed. Restart the download.`, 'SOURCE_CHANGED');
      await clearPartial();
      response = await fetch(false);
      response.on?.('error', error => { responseError = error; });
    }

    if (response.statusCode === 200) {
      // A server that ignores If-Range supplies a fresh representation. Never
      // append it to the retained prefix.
      if (checkpoint) await clearPartial();
      const contentLength = response.headers?.['content-length'];
      if (contentLength !== undefined && Number(contentLength) !== totalBytes) {
        response.destroy?.();
        throw transferError(`${errorPrefix} file size changed. Refresh the library and try again.`, 'SIZE_CHANGED');
      }
      validator = strongEtag(response.headers?.etag);
      offset = 0;
      resumedBytes = 0;
    } else if (response.statusCode === 206 && checkpoint) {
      const range = parseContentRange(response.headers?.['content-range']);
      const responseEtag = strongEtag(response.headers?.etag);
      const contentLength = response.headers?.['content-length'];
      if (!range || range.start !== checkpoint.offset || range.end !== totalBytes - 1 || range.total !== totalBytes
        || responseEtag !== checkpoint.etag
        || (contentLength !== undefined && Number(contentLength) !== totalBytes - checkpoint.offset)) {
        response.destroy?.();
        responseError = undefined;
        const valid = typeof revalidate === 'function' ? await revalidate() : false;
        if (!valid) throw transferError(`${errorPrefix} source changed. Restart the download.`, 'SOURCE_CHANGED');
        await clearPartial();
        response = await fetch(false);
        response.on?.('error', error => { responseError = error; });
        if (response.statusCode !== 200) {
          response.destroy?.();
          throw transferError(`${errorPrefix} returned an invalid range. Restart the download.`, 'INVALID_RANGE');
        }
        const fullLength = response.headers?.['content-length'];
        if (fullLength !== undefined && Number(fullLength) !== totalBytes) {
          response.destroy?.();
          throw transferError(`${errorPrefix} file size changed. Refresh the library and try again.`, 'SIZE_CHANGED');
        }
        validator = strongEtag(response.headers?.etag);
        offset = 0;
        resumedBytes = 0;
      } else {
        offset = checkpoint.offset;
        resumedBytes = checkpoint.offset;
        validator = checkpoint.etag;
      }
    } else {
      response.destroy?.();
      throw transferError(`${errorPrefix} returned an unsupported download response.`, 'INVALID_RANGE');
    }

    for await (const rawChunk of response) {
      if (signal?.aborted) throw transferError(`${errorPrefix} download cancelled.`, 'ABORT_ERR', true);
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (offset + chunk.length > totalBytes) throw transferError(`${errorPrefix} sent more data than the original file size.`, 'EXCESS_BODY');
      await write(chunk, offset);
      offset += chunk.length;
      try {
        onProgress?.({ downloadedBytes: offset, totalBytes,
          progress: Math.min(100, offset / totalBytes * 100), ...(resumable ? { resumedBytes } : {}) });
      } catch { throw transferError(`${errorPrefix} download progress could not be recorded.`, 'PROGRESS_CALLBACK'); }
      await persist();
    }
    if (responseError) throw responseError;
    if (offset !== totalBytes) throw transferError(`${errorPrefix} download was incomplete. Please retry.`, 'INCOMPLETE_BODY', true);
    await file.sync();
    await safeCheckpoint(onCheckpoint, null);
    shouldDelete = false;
    return resumable ? { sizeBytes: offset, resumedBytes } : { sizeBytes: offset };
  } catch (caught) {
    response?.destroy?.();
    let error = caught;
    if (responseError && !isProviderError(caught)) error = responseError;
    const keep = retainOnError && transient(error) && Boolean(validator) && offset > 0 && offset < totalBytes && file;
    if (keep) {
      try {
        await file.sync();
        await safeCheckpoint(onCheckpoint, { offset, totalBytes, etag: validator });
        shouldDelete = false;
      } catch (checkpointError) {
        error = checkpointError;
      }
    }
    if (!keep || error !== caught && error?.code !== caught?.code) {
      shouldDelete = true;
      await safeCheckpoint(onCheckpoint, null).catch(() => {});
    }
    if (error?.code === 'EEXIST') throw transferError('A file already exists at this download destination.', 'EEXIST');
    if (error?.code === 'ABORT_ERR' || signal?.aborted) {
      error = error?.name === 'RangeTransferError' ? error : transferError(`${errorPrefix} download cancelled.`, 'ABORT_ERR', true);
    } else if (error?.name !== 'RangeTransferError' && !isProviderError(error)) {
      if (mapError && transient(error)) error = mapError(error);
      else {
        const retryable = transient(error);
        error = transferError(`${errorPrefix} download failed or was interrupted. Please retry.`, error?.code || 'TRANSFER_ERROR', retryable);
      }
    }
    throw error;
  } finally {
    if (file) {
      await file.close().catch(() => {});
      if (shouldDelete && opened) await fs.promises.unlink(destination).catch(() => {});
    }
  }
}

module.exports = { rangeTransfer, RangeTransferError, strongEtag, validateResumeState, parseContentRange };
