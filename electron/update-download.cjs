'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { releaseTarget } = require('./release-target.cjs');

const MAX_INSTALLER_BYTES = 1024 ** 3;
const MAX_CHECKSUM_BYTES = 64 * 1024;
const FREE_RESERVE_BYTES = 2 * 1024 ** 3;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const RELEASE_ROOT = 'https://github.com/Matt-Mc/OffGrid/releases';

function failure(code) {
  const messages = {
    invalid: 'The update information is invalid. Check for updates again.',
    network: 'The update could not be downloaded. Check your connection and try again.',
    checksum: 'The update could not be verified. Please try downloading it again.',
    space: 'There is not enough free space to download the update and keep 2 GB available.',
    open: 'The update downloaded, but the installer could not be opened. Please try again.',
    timeout: 'The update download timed out. Check your connection and try again.',
    cancelled: 'Update download cancelled.',
  };
  return Object.assign(new Error(messages[code] || messages.network), { updateCode: code });
}

function validURL(value, expected) {
  if (typeof value !== 'string' || value !== expected) throw failure('invalid');
  return value;
}

function normalizeRelease(release, platform = process.platform, arch = process.arch) {
  const target = releaseTarget(platform, arch);
  if (!target) throw failure('invalid');
  if (!release || typeof release.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(release.version)) throw failure('invalid');
  const version = release.version;
  const tag = `v${version}`;
  const name = `Offgrid-${version}-${target.suffix}`;
  if (release.tag !== tag || release.asset?.name !== name || release.checksums?.name !== target.checksums) throw failure('invalid');
  const size = release.asset.size;
  if (!Number.isSafeInteger(size) || size < 512 || size >= MAX_INSTALLER_BYTES) throw failure('invalid');
  const checksumSize = release.checksums.size;
  if (!Number.isSafeInteger(checksumSize) || checksumSize <= 0 || checksumSize > MAX_CHECKSUM_BYTES) throw failure('invalid');
  const digest = release.asset.digest;
  if (digest != null && !/^sha256:[a-f\d]{64}$/i.test(digest)) throw failure('invalid');
  return {
    version, tag,
    url: validURL(release.url, `${RELEASE_ROOT}/tag/${tag}`),
    asset: { name, size, digest: digest?.toLowerCase(), url: validURL(release.asset.url, `${RELEASE_ROOT}/download/${tag}/${name}`) },
    checksums: { name: target.checksums, size: checksumSize, url: validURL(release.checksums.url, `${RELEASE_ROOT}/download/${tag}/${target.checksums}`) },
  };
}

function allowedRedirect(value, initial) {
  let url;
  try { url = new URL(value); } catch { throw failure('network'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw failure('network');
  if (url.hostname === 'github.com') {
    // GitHub itself must retain the exact repository, tag and asset path.
    if (url.origin + url.pathname !== initial || url.search) throw failure('network');
  } else if (url.hostname !== 'release-assets.githubusercontent.com') throw failure('network');
  return url.href;
}

function aborted(signal) {
  if (signal.aborted) throw signal.reason || failure('cancelled');
}

function withAbort(work, signal) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason || failure('cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

async function request(fetch, initial, signal) {
  let url = initial;
  for (let redirects = 0; redirects <= 5; redirects++) {
    aborted(signal);
    const pending = Promise.resolve().then(() => fetch(url, {
      redirect: 'manual', signal, credentials: 'omit',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Offgrid-Update-Download' },
    }));
    // Also close a late response from a transport that ignores AbortSignal.
    pending.then(response => {
      if (signal.aborted) Promise.resolve(response.body?.cancel()).catch(() => {});
    }, () => {});
    const response = await withAbort(pending, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      Promise.resolve(response.body?.cancel()).catch(() => {});
      if (!location || redirects === 5) throw failure('network');
      url = allowedRedirect(new URL(location, url).href, initial);
      continue;
    }
    if (response.status !== 200 || !response.body || /text\/html|application\/xhtml/i.test(response.headers.get('content-type') || '')) {
      Promise.resolve(response.body?.cancel()).catch(() => {});
      throw failure('network');
    }
    return response;
  }
  throw failure('network');
}

async function readBody(response, { signal, limit, consume }) {
  const reader = response.body.getReader();
  let count = 0;
  const abort = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      aborted(signal);
      const { value, done } = await withAbort(reader.read(), signal);
      aborted(signal);
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw failure('checksum');
      await consume(Buffer.from(value));
    }
    return count;
  } finally {
    signal.removeEventListener('abort', abort);
    Promise.resolve(reader.cancel()).catch(() => {});
  }
}

function checksumFor(text, name) {
  let hash;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f\d]{64}) [ *]([^\r\n]+)$/i.exec(line);
    if (!match) throw failure('checksum');
    if (match[2] === name) {
      if (hash) throw failure('checksum');
      hash = match[1].toLowerCase();
    }
  }
  if (!hash) throw failure('checksum');
  return hash;
}


async function verifyCached(cached, signal) {
  let file;
  try {
    // Refuse a replaced cache directory or a symlink in place of the installer.
    if (await fs.realpath(cached.directory) !== cached.directory) throw failure('checksum');
    if (!(await fs.lstat(cached.path)).isFile() || await fs.realpath(cached.path) !== cached.path) throw failure('checksum');
    file = await fs.open(cached.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== cached.size) throw failure('checksum');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < cached.size) {
      aborted(signal);
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, cached.size - position), position);
      if (!bytesRead) throw failure('checksum');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== cached.size || after.mtimeMs !== stat.mtimeMs || hash.digest('hex') !== cached.hash) throw failure('checksum');
    await verifyFormat(file, cached.format, cached.size);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw failure('checksum');
  } finally {
    await file?.close().catch(() => {});
  }
}

async function verifyFormat(file, format, size) {
  if (format === 'dmg') {
    const trailer = Buffer.alloc(4);
    await file.read(trailer, 0, 4, size - 512);
    if (trailer.toString('ascii') !== 'koly') throw failure('checksum');
  } else {
    const header = Buffer.alloc(64);
    await file.read(header, 0, 64, 0);
    const offset = header.readUInt32LE(60);
    if (header.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset > size - 6) throw failure('checksum');
    const signature = Buffer.alloc(6);
    await file.read(signature, 0, 6, offset);
    // NSIS installers use an x86 launcher, including for x64 applications.
    if (signature.readUInt32LE(0) !== 0x4550 || ![0x14c, 0x8664].includes(signature.readUInt16LE(4))) throw failure('checksum');
  }
}

function createUpdateDownload({ directory, fetch = globalThis.fetch, openPath, onChange = () => {}, freeBytes, timeoutMs = MAX_TIMEOUT_MS, platform = process.platform, arch = process.arch } = {}) {
  const target = releaseTarget(platform, arch);
  const openedMessage = platform === 'win32' ? 'Installer opened. Follow the setup prompts to finish updating Offgrid.' : 'Installer opened. Drag Offgrid into Applications to finish updating.';
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof fetch !== 'function' || typeof openPath !== 'function') throw new TypeError('An update directory, fetch and installer opener are required.');
  let state = { state: 'idle', version: null, downloadedBytes: 0, totalBytes: 0, progress: 0, message: '' };
  let active;
  let cached;
  let disposed = false;
  const status = () => ({ ...state });
  const change = patch => {
    state = { ...state, ...patch };
    if (!disposed) { try { onChange(status()); } catch {} }
  };

  function download(input) {
    if (disposed) return Promise.reject(failure('cancelled'));
    let release;
    try { release = normalizeRelease(input, platform, arch); } catch { return Promise.reject(failure('invalid')); }
    if (active) return active.promise;
    const reusable = state.state === 'ready' && state.version === release.version ? cached : null;
    const controller = new AbortController();
    const operation = { controller, promise: null };
    active = operation;
    change({ state: 'downloading', version: release.version, downloadedBytes: 0, totalBytes: release.asset.size, progress: 0, message: reusable ? 'Verifying the downloaded installer…' : 'Downloading the latest update…' });
    operation.promise = (async () => {
      let workingDirectory;
      let file;
      let opened = false;
      const signal = controller.signal;
      const deadline = setTimeout(() => controller.abort(failure('timeout')), Math.min(Math.max(Number(timeoutMs) || MAX_TIMEOUT_MS, 1), MAX_TIMEOUT_MS));
      try {
        if (reusable) {
          workingDirectory = reusable.directory;
          if (release.asset.size !== reusable.size || (release.asset.digest && release.asset.digest !== `sha256:${reusable.hash}`)) throw failure('checksum');
          await verifyCached(reusable, signal);
          aborted(signal);
          operation.opening = true;
          clearTimeout(deadline);
          if (await openPath(reusable.path)) throw failure('open');
          opened = true;
          change({ state: 'ready', downloadedBytes: release.asset.size, progress: 1, message: openedMessage });
          return status();
        }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        aborted(signal);
        if (freeBytes) {
          const available = await withAbort(freeBytes(directory), signal);
          if (!Number.isFinite(available) || available < release.asset.size + FREE_RESERVE_BYTES) throw failure('space');
        }
        const checksums = await request(fetch, release.checksums.url, signal);
        const chunks = [];
        const checksumBytes = await readBody(checksums, { signal, limit: MAX_CHECKSUM_BYTES, consume: chunk => { chunks.push(chunk); } });
        if (checksumBytes !== release.checksums.size) throw failure('checksum');
        const expected = checksumFor(Buffer.concat(chunks).toString('utf8'), release.asset.name);
        if (release.asset.digest && release.asset.digest !== `sha256:${expected}`) throw failure('checksum');
        workingDirectory = await fs.realpath(await fs.mkdtemp(path.join(directory, 'offgrid-update-')));
        aborted(signal);
        const partialPath = path.join(workingDirectory, `${release.asset.name}.partial`);
        file = await fs.open(partialPath, 'wx+', 0o600);
        const response = await request(fetch, release.asset.url, signal);
        const lengthHeader = response.headers.get('content-length');
        if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) !== release.asset.size)) {
          Promise.resolve(response.body.cancel()).catch(() => {});
          throw failure('checksum');
        }
        const hash = crypto.createHash('sha256');
        let downloadedBytes = 0;
        await readBody(response, { signal, limit: release.asset.size, consume: async chunk => {
          hash.update(chunk);
          let written = 0;
          while (written < chunk.length) {
            aborted(signal);
            const result = await file.write(chunk, written, chunk.length - written);
            if (!result.bytesWritten) throw failure('network');
            written += result.bytesWritten;
          }
          downloadedBytes += chunk.length;
          change({ downloadedBytes, progress: downloadedBytes / release.asset.size });
        } });
        if (downloadedBytes !== release.asset.size || hash.digest('hex') !== expected) throw failure('checksum');
        await verifyFormat(file, target.format, release.asset.size);
        await file.sync();
        await file.close();
        file = null;
        aborted(signal);
        const installerPath = path.join(workingDirectory, release.asset.name);
        await fs.rename(partialPath, installerPath);
        aborted(signal);
        // This path is constructed here and only opened after complete verification.
        // Once handed to the OS, cancellation cannot undo opening a disk image.
        // Let that operation settle before deciding whether its file can be removed.
        operation.opening = true;
        clearTimeout(deadline);
        const error = await openPath(installerPath);
        if (error) throw failure('open');
        opened = true;
        cached = { path: installerPath, directory: workingDirectory, hash: expected, size: release.asset.size, format: target.format };
        change({ state: 'ready', progress: 1, message: openedMessage });
      } catch (error) {
        cached = null;
        const code = signal.aborted ? signal.reason?.updateCode : error?.updateCode;
        change({ state: code === 'cancelled' ? 'idle' : 'error', message: failure(code || 'network').message });
      } finally {
        clearTimeout(deadline);
        await file?.close().catch(() => {});
        if (workingDirectory && !opened) await fs.rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
        if (active === operation) active = null;
      }
      return status();
    })();
    return operation.promise;
  }

  async function cancel() {
    if (active) {
      if (!active.opening) active.controller.abort(failure('cancelled'));
      await active.promise;
    }
    return status();
  }
  async function dispose() { disposed = true; await cancel(); }
  return { download, status, cancel, dispose };
}

module.exports = { createUpdateDownload, normalizeRelease, checksumFor };
