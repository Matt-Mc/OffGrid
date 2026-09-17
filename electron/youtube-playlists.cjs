'use strict';
const { spawn } = require('node:child_process');
const { parseYouTubeUrl } = require('./youtube-links.cjs');

function runYtdlpJson(command, args, { signal, spawnProcess = spawn, timeoutMs = 60_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Preview canceled.'), { code: 'ABORT_ERR' }));
    const child = spawnProcess(command, ['--ignore-config', ...args]);
    let stdout = '', stderr = '', bytes = 0, failure;
    const stop = error => { failure ||= error; child.kill('SIGKILL'); };
    const abort = () => stop(Object.assign(new Error('Preview canceled.'), { code: 'ABORT_ERR' }));
    const timer = setTimeout(() => stop(new Error('Reading video details timed out. Try a smaller selection.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new Error('Video details are too large. Try a smaller selection.'));
      else stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { finish(); reject(error); });
    child.on('close', code => {
      finish();
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(stderr.trim() || 'Could not read video details.'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('The downloader returned invalid video details.')); }
    });
  });
}

async function readPlaylist(command, url, { start = 0, signal, spawnProcess } = {}) {
  if (!Number.isSafeInteger(start) || start < 0 || start > 100_000) throw new Error('Invalid playlist page.');
  const parsed = parseYouTubeUrl(url, 'playlist');
  if (!parsed.playlistUrl) throw new Error('Choose a YouTube playlist.');
  const feed = await runYtdlpJson(command, ['--dump-single-json', '--flat-playlist', '--skip-download', '--ignore-errors', '--socket-timeout', '20', '--retries', '1', '--playlist-start', String(start + 1), '--playlist-end', String(start + 101), '--', parsed.playlistUrl], { signal, spawnProcess });
  if (!feed || !Array.isArray(feed.entries)) throw new Error('The playlist could not be read.');
  const entries = feed.entries;
  const items = entries.slice(0, 100).map((entry, index) => {
    const id = typeof entry?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(entry.id) ? entry.id : null;
    const available = Boolean(id && !['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(entry.availability) && !/^\[(?:Deleted|Private) video\]$/i.test(entry.title || ''));
    return { id: id || `unavailable-${start + index}`, url: id ? `https://www.youtube.com/watch?v=${id}` : null,
      title: String(entry?.title || 'Unavailable video').slice(0, 500), duration: Number.isFinite(entry?.duration) ? entry.duration : 0,
      available, reason: available ? null : 'This video is unavailable.', expectedBytes: null };
  });
  const declared = Number(feed.playlist_count ?? feed.n_entries);
  const hasMore = entries.length > 100 || Number.isSafeInteger(declared) && declared > start + 100;
  const knownTotal = Number.isSafeInteger(declared) && declared >= start + items.length;
  return { items, start, nextStart:start + 100, total: knownTotal ? declared : start + items.length + (hasMore ? 1 : 0), hasMore,
    complete: !hasMore && (knownTotal || entries.length < 101), warning: !knownTotal ? 'Playlist size could not be confirmed; unavailable entries may be omitted.' : null };
}

async function mapBounded(items, callback, { concurrency = 3, signal } = {}) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw Object.assign(new Error('Preview canceled.'), { code: 'ABORT_ERR' });
      const index = next++;
      results[index] = await callback(items[index], index);
    }
  }));
  return results;
}

module.exports = { runYtdlpJson, readPlaylist, mapBounded };
