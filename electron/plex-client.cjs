'use strict';

// Plex's token stays in the main process and in request headers. No redirects,
// arbitrary API paths, or public network destinations are accepted here.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const PAGE_SIZE = 100;
const METADATA_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT = 15_000;
const DOWNLOAD_IDLE_TIMEOUT = 30_000;
const EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'wmv', 'flv', 'vob', 'ogv', '3gp']);

class PlexError extends Error {
  constructor(message, code = 'PLEX_ERROR') { super(message); this.name = 'PlexError'; this.code = code; }
}
function cancelled() { return new PlexError('Plex download cancelled.', 'ABORT_ERR'); }
const NETWORK_ERROR_TYPES = new Map([
  ...['EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM'].map(code => [code, 'unreachable']),
  ['ECONNREFUSED', 'refused'],
  ...['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].map(code => [code, 'dns']),
  ['ETIMEDOUT', 'timeout'],
  ...['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].map(code => [code, 'interrupted']),
  ...['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO'].map(code => [code, 'tls'])
]);
function networkError(error, { platform = process.platform, fallback = 'Could not connect to the local Plex server. Check the server address and network connection.' } = {}) {
  if (error instanceof PlexError) return error;
  // Only fixed, allowlisted diagnostics cross IPC. Native messages can contain
  // request URLs, response content, file paths, or credentials.
  const code = typeof error?.code === 'string' ? error.code : '';
  const type = NETWORK_ERROR_TYPES.get(code);
  const messages = {
    unreachable: platform === 'darwin'
      ? 'Could not reach Plex. In macOS System Settings > Privacy & Security > Local Network, enable Offgrid, then retry. Also check that this Mac and Plex are on the same network and the server address is correct.'
      : 'Could not reach Plex. Check that this device and Plex are on the same network, the server address is correct, and the firewall allows the connection.',
    refused: 'Plex refused the connection. Check that Plex Media Server is running and the server address and port are correct (the default port is 32400).',
    dns: 'Could not find the Plex server. Check its hostname or use its local IP address, and make sure this device is on the same network.',
    timeout: 'Plex connection timed out. Check the server address and network connection, then retry.',
    interrupted: 'The Plex connection was interrupted. Check the network connection and retry.',
    tls: 'Could not establish a secure connection to Plex. Check the HTTPS address and the server certificate; certificate verification must succeed.'
  };
  return type ? new PlexError(`${messages[type]} (${code})`, code) : new PlexError(fallback);
}
function positiveSize(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; }
function cleanText(value, fallback = '') { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500) : fallback; }
function validateId(value) {
  const id = String(value ?? '');
  if (!/^\d{1,20}$/.test(id)) throw new PlexError('Invalid Plex library item.');
  return id;
}
function isLocalAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIP(address) === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    if (normalized === '::1' || /^(fc|fd)[\da-f]{2}:/.test(normalized)) return true;
    const mapped = normalized.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/);
    if (mapped) {
      const first = parseInt(mapped[1], 16), second = parseInt(mapped[2], 16);
      return isLocalAddress(`${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
    }
  }
  return false;
}
function normalizeServerUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value) || !/^https?:\/\/[^/?#]+\/?$/i.test(value)) throw new PlexError('Enter a local Plex server URL, such as http://192.168.1.10:32400.');
  let url;
  try { url = new URL(value); } catch { throw new PlexError('Invalid Plex server URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new PlexError('Use only the local Plex server address and port, without credentials or a path.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || (net.isIP(hostname) && !isLocalAddress(hostname))) throw new PlexError('Plex connections must stay on the local network.');
  return url.origin;
}
function validatePartKey(key) {
  // Plex originals have a numeric part id, revision timestamp, and one filename.
  // Reject encoded separators, traversal, query strings, and indirect URLs.
  if (typeof key !== 'string' || key.length > 2048 || !/^\/library\/parts\/\d{1,20}\/\d{1,20}\/[^/?#\\]+$/.test(key)) {
    throw new PlexError('Plex returned an unsupported media file path.');
  }
  let filename;
  try { filename = decodeURIComponent(key.split('/').at(-1)); } catch { throw new PlexError('Plex returned an unsupported media file path.'); }
  if (!filename || filename === '.' || filename === '..' || /[\/\\%\u0000-\u001f\u007f]/.test(filename)) throw new PlexError('Plex returned an unsupported media file path.');
  return key;
}
function normalizeItem(item) {
  const id = validateId(item.ratingKey);
  const type = item.type;
  if (!['movie', 'show', 'season', 'episode'].includes(type)) return null;
  const media = Array.isArray(item.Media) ? item.Media[0] : null;
  const parts = Array.isArray(media?.Part) ? media.Part : [];
  const part = parts.length === 1 ? parts[0] : null;
  const sizeBytes = positiveSize(part?.size);
  const duration = Number(item.duration);
  const title = cleanText(item.title, 'Untitled');
  const channel = cleanText(item.grandparentTitle || (type === 'season' ? item.parentTitle : '') || item.librarySectionTitle, 'Plex');
  const subtitle = type === 'movie' ? (item.year ? String(item.year).slice(0, 4) : '')
    : type === 'episode' ? `${channel} · S${Number(item.parentIndex) || 0} E${Number(item.index) || 0}`
      : type === 'season' ? channel : (Number.isSafeInteger(Number(item.leafCount)) ? `${Number(item.leafCount)} episodes` : '');
  return { id, type, title, subtitle, channel, duration: Number.isFinite(duration) && duration >= 0 ? Math.floor(duration / 1000) : 0,
    sizeBytes, downloadable: (type === 'movie' || type === 'episode') && Boolean(part && sizeBytes) };
}

class PlexClient {
  #token;
  constructor({ baseUrl, token }) {
    this.baseUrl = normalizeServerUrl(baseUrl);
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(token)) throw new PlexError('Enter a valid Plex token.');
    this.#token = token;
  }

  async _resolve(signal) {
    if (signal?.aborted) throw cancelled();
    const hostname = new URL(this.baseUrl).hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname)) return { address: hostname, family: net.isIP(hostname) };
    let timer, abort;
    try {
      const results = await Promise.race([
        dns.lookup(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new PlexError('Plex server lookup timed out.')), REQUEST_TIMEOUT);
          abort = () => reject(cancelled());
          signal?.addEventListener('abort', abort, { once: true });
        })
      ]);
      if (!results.length || results.some(result => !isLocalAddress(result.address))) throw new PlexError('Plex connections must stay on the local network.');
      return results[0];
    } catch (error) {
      if (error instanceof PlexError) throw error;
      throw networkError(error, { fallback: 'Could not find the local Plex server. Check its hostname or use its local IP address.' });
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }

  async _request(path, { signal, download = false, headers = {} } = {}) {
    const address = await this._resolve(signal);
    if (signal?.aborted) throw cancelled();
    const url = new URL(this.baseUrl);
    return new Promise((resolve, reject) => {
      const protocol = url.protocol === 'https:' ? https : http;
      let deadline;
      const abort = () => request.destroy(cancelled());
      const request = protocol.request({
        protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
        path, method: 'GET', agent: false,
        // Pin the verified answer to this connection, including DNS names that rebind.
        lookup: (_hostname, options, callback) => callback(null, options.all ? [address] : address.address, address.family),
        headers: { Accept: download ? 'application/octet-stream' : 'application/json', 'Accept-Encoding': 'identity',
          'X-Plex-Token': this.#token, 'X-Plex-Product': 'Offgrid', 'X-Plex-Client-Identifier': 'offgrid-local', ...headers }
      }, response => {
        response.on('error', () => {});
        if (response.statusCode !== 200) {
          response.destroy();
          const message = response.statusCode === 401 || response.statusCode === 403 ? 'Plex authentication failed. Check the token and library access.'
            : response.statusCode >= 300 && response.statusCode < 400 ? 'Plex redirects are not supported. Use the local server address.'
              : 'Plex could not provide the requested media.';
          reject(new PlexError(message));
        } else if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(new PlexError('Plex returned an unsupported encoded response.'));
        } else resolve(response);
      });
      request.on('error', error => reject(networkError(error)));
      request.setTimeout(download ? DOWNLOAD_IDLE_TIMEOUT : REQUEST_TIMEOUT, () => request.destroy(new PlexError('Plex connection timed out.')));
      if (!download) deadline = setTimeout(() => request.destroy(new PlexError('Plex request timed out.')), REQUEST_TIMEOUT);
      request.on('close', () => { clearTimeout(deadline); signal?.removeEventListener('abort', abort); });
      signal?.addEventListener('abort', abort, { once: true });
      request.end();
    });
  }

  async _json(path, headers, signal) {
    try {
      const response = await this._request(path, { headers, signal });
      if (Number(response.headers['content-length']) > METADATA_LIMIT) { response.destroy(); throw new PlexError('Plex library response is too large. Narrow your search.'); }
      let size = 0;
      const chunks = [];
      for await (const chunk of response) {
        size += chunk.length;
        if (size > METADATA_LIMIT) { response.destroy(); throw new PlexError('Plex library response is too large. Narrow your search.'); }
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result?.MediaContainer || typeof result.MediaContainer !== 'object') throw new PlexError('Plex returned invalid library data.');
      return result.MediaContainer;
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof PlexError) throw error;
      throw networkError(error, { fallback: 'Plex returned incomplete or invalid library data.' });
    }
  }

  async identity({ signal } = {}) {
    const data = await this._json('/', undefined, signal);
    const serverId = cleanText(data.machineIdentifier);
    if (!/^[\w-]{1,128}$/.test(serverId)) throw new PlexError('Plex returned an invalid server identity.');
    return { serverId, name: cleanText(data.friendlyName, 'Local Plex server') };
  }

  async sections({ signal } = {}) {
    const data = await this._json('/library/sections', undefined, signal);
    return (Array.isArray(data.Directory) ? data.Directory : []).filter(item => item.type === 'movie' || item.type === 'show')
      .slice(0, 1000).map(item => ({ id: validateId(item.key), title: cleanText(item.title, 'Library'), type: item.type }));
  }

  async browse({ sectionId, parentId, start = 0, query = '', signal } = {}) {
    if (!Number.isSafeInteger(start) || start < 0 || start > 10_000_000 || typeof query !== 'string' || query.length > 200) throw new PlexError('Invalid Plex browsing options.');
    let path = parentId !== undefined && parentId !== null ? `/library/metadata/${validateId(parentId)}/children` : `/library/sections/${validateId(sectionId)}/all`;
    if (query.trim()) path += `?title=${encodeURIComponent(query.trim())}`;
    const data = await this._json(path, { 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(PAGE_SIZE) }, signal);
    const rows = Array.isArray(data.Metadata) ? data.Metadata : [];
    const items = rows.slice(0, PAGE_SIZE).map(normalizeItem).filter(Boolean);
    const total = Number(data.totalSize ?? data.size ?? rows.length);
    return { items, total: Number.isSafeInteger(total) && total >= 0 ? total : items.length, start };
  }

  async metadata(id, { signal } = {}) {
    id = validateId(id);
    const data = await this._json(`/library/metadata/${id}`, undefined, signal);
    const row = Array.isArray(data.Metadata) ? data.Metadata.find(item => String(item.ratingKey) === id) : null;
    if (!row) throw new PlexError('Plex media was not found.');
    const item = normalizeItem(row);
    if (!item || !['movie', 'episode'].includes(item.type)) throw new PlexError('Choose a movie or an episode to download.');
    const media = Array.isArray(row.Media) ? row.Media[0] : null;
    const parts = Array.isArray(media?.Part) ? media.Part : [];
    if (parts.length > 1) throw new PlexError('Multi-part Plex media is not supported yet.');
    if (parts.length !== 1 || !item.sizeBytes || parts[0].exists === false || parts[0].accessible === false) throw new PlexError('The original Plex media file is unavailable.');
    const partKey = validatePartKey(parts[0].key);
    const extension = String(parts[0].container || media.container || '').toLowerCase();
    if (!EXTENSIONS.has(extension)) throw new PlexError('This Plex media container is not supported yet.');
    return { ...item, partKey, extension };
  }

  async download(metadata, destination, { signal, onProgress } = {}) {
    const partKey = validatePartKey(metadata?.partKey);
    const expected = positiveSize(metadata?.sizeBytes);
    if (!expected) throw new PlexError('Plex did not provide the original file size.');
    if (signal?.aborted) throw cancelled();
    let file, response, responseError, downloadedBytes = 0;
    try {
      // Create exclusively so a failed transfer never removes an existing file.
      file = await fs.promises.open(destination, 'wx', 0o600);
      response = await this._request(`${partKey}?download=1`, { signal, download: true });
      response.on('error', error => { responseError = error; });
      const contentLength = response.headers['content-length'];
      if (contentLength !== undefined && positiveSize(contentLength) !== expected) throw new PlexError('Plex file size changed. Refresh the library and try again.');
      const progress = new Transform({ transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > expected) return callback(new PlexError('Plex sent more data than the original file size.'));
        try { onProgress?.({ downloadedBytes, totalBytes: expected, progress: Math.min(100, downloadedBytes / expected * 100) }); }
        catch { return callback(new PlexError('Plex download progress could not be recorded.')); }
        callback(null, chunk);
      } });
      await pipeline(response, progress, file.createWriteStream(), { signal });
      if (downloadedBytes !== expected) throw new PlexError('Plex download was incomplete. Please retry.');
      return { sizeBytes: downloadedBytes };
    } catch (error) {
      response?.destroy();
      if (file) { await file.close().catch(() => {}); await fs.promises.unlink(destination).catch(() => {}); }
      if (signal?.aborted || error.code === 'ABORT_ERR') throw cancelled();
      if (error instanceof PlexError) throw error;
      if (error.code === 'EEXIST') throw new PlexError('A file already exists at this download destination.');
      if (responseError) throw networkError(responseError, { fallback: 'Plex download failed or was interrupted. Please retry.' });
      throw new PlexError('Plex download failed or was interrupted. Please retry.');
    } finally { if (file) await file.close().catch(() => {}); }
  }
}

module.exports = { PlexClient, PlexError, normalizeServerUrl, isLocalAddress, validatePartKey, networkError };
