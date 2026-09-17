'use strict';

// Jellyfin's token stays in the main process and in request headers. No redirects,
// arbitrary API paths, or public network destinations are accepted here.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const fs = require('node:fs');
const { rangeTransfer, RangeTransferError } = require('./range-transfer.cjs');

const PAGE_SIZE = 100;
const METADATA_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT = 15_000;
const DOWNLOAD_IDLE_TIMEOUT = 30_000;
const SUBTITLE_LIMIT = 5 * 1024 * 1024;
const EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'wmv', 'flv', 'vob', 'ogv', '3gp']);

class JellyfinError extends Error {
  constructor(message, code = 'JELLYFIN_ERROR', { retryable = false } = {}) { super(message); this.name = 'JellyfinError'; this.code = code; this.retryable = retryable; }
}
function cancelled() { return new JellyfinError('Jellyfin download cancelled.', 'ABORT_ERR'); }
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
function networkError(error, { platform = process.platform, fallback = 'Could not connect to the local Jellyfin server. Check the server address and network connection.' } = {}) {
  if (error instanceof JellyfinError) return error;
  // Only fixed, allowlisted diagnostics cross IPC. Native messages can contain
  // request URLs, response content, file paths, or credentials.
  const code = typeof error?.code === 'string' ? error.code : '';
  const type = NETWORK_ERROR_TYPES.get(code);
  const messages = {
    unreachable: platform === 'darwin'
      ? 'Could not reach Jellyfin. In macOS System Settings > Privacy & Security > Local Network, enable Offgrid, then retry. Also check that this Mac and Jellyfin are on the same network and the server address is correct.'
      : 'Could not reach Jellyfin. Check that this device and Jellyfin are on the same network, the server address is correct, and the firewall allows the connection.',
    refused: 'Jellyfin refused the connection. Check that Jellyfin Media Server is running and the server address and port are correct (the default port is 8096).',
    dns: 'Could not find the Jellyfin server. Check its hostname or use its local IP address, and make sure this device is on the same network.',
    timeout: 'Jellyfin connection timed out. Check the server address and network connection, then retry.',
    interrupted: 'The Jellyfin connection was interrupted. Check the network connection and retry.',
    tls: 'Could not establish a secure connection to Jellyfin. Check the HTTPS address and the server certificate; certificate verification must succeed.'
  };
  return type ? new JellyfinError(`${messages[type]} (${code})`, code, { retryable: ['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code) }) : new JellyfinError(fallback);
}
function transientStatus(status) { return status === 408 || status === 429 || status >= 500; }
function providerStatusError(status) {
  const code = `HTTP_${status}`;
  const message = status === 401 || status === 403 ? 'Jellyfin authentication failed or access was denied. Check your login and account download permissions.'
    : status >= 300 && status < 400 ? 'Jellyfin redirects are not supported. Use the local server address.'
      : 'Jellyfin could not provide the requested media.';
  return new JellyfinError(message, code, { retryable: transientStatus(status) });
}
function positiveSize(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; }
function nonNegativeInteger(value) {
  if (!(typeof value === 'number' && Number.isFinite(value)) && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function cleanText(value, fallback = '') { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500) : fallback; }
function validateId(value) {
  const id = String(value ?? '');
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(id)) throw new JellyfinError('Invalid Jellyfin library item.');
  return id.replaceAll('-', '').toLowerCase();
}
const { isLocalAddress } = require('./plex-client.cjs');
function normalizeServerUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#%]/.test(value) || !/^https?:\/\/[^/]+(?:\/[A-Za-z0-9_-]+)*\/?$/i.test(value)) throw new JellyfinError('Enter a local Jellyfin server URL, such as http://192.168.1.10:8096.');
  let url;
  try { url = new URL(value); } catch { throw new JellyfinError('Invalid Jellyfin server URL.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password || !hostname || url.port === '0' || (net.isIP(hostname) && !isLocalAddress(hostname))) throw new JellyfinError('Jellyfin connections must use a local network address without credentials.');
  return url.origin + url.pathname.replace(/\/$/, '');
}
function mediaFile(row) {
  const sources = Array.isArray(row.MediaSources) ? row.MediaSources : [];
  if (sources.length !== 1 || Number(row.PartCount || 1) !== 1) return null;
  const source = sources[0];
  if (!source || typeof source !== 'object') return null;
  // Download uses item.Path, not a selected media source. Never reserve bytes for
  // another version or stream. Paths are compared internally and never returned.
  if (source.Protocol !== 'File' || source.IsRemote || source.IsInfiniteStream || source.RequiresOpening || source.RequiresClosing || (row.VideoType && row.VideoType !== 'VideoFile') || (source.VideoType && source.VideoType !== 'VideoFile')) return null;
  if (typeof row.Path !== 'string' || !row.Path || source.Path !== row.Path) return null;
  const extension = String(source.Container || row.Container || '').toLowerCase();
  const sizeBytes = positiveSize(source.Size);
  const mediaSourceId = source.Id === undefined ? null : validateId(source.Id);
  return sizeBytes && EXTENSIONS.has(extension) ? { extension, sizeBytes, mediaSourceId } : null;
}
function normalizeItem(row) {
  if (!row || typeof row !== 'object') return null;
  const type = new Map([['Movie', 'movie'], ['Series', 'show'], ['Season', 'season'], ['Episode', 'episode']]).get(row.Type);
  if (!type) return null;
  const id = validateId(row.Id);
  const file = mediaFile(row);
  const duration = Number(row.RunTimeTicks);
  const channel = cleanText(row.SeriesName, 'Jellyfin');
  const subtitle = type === 'movie' ? (row.ProductionYear ? String(row.ProductionYear).slice(0, 4) : '')
    : type === 'episode' ? `${channel} · S${Number(row.ParentIndexNumber) || 0} E${Number(row.IndexNumber) || 0}`
      : type === 'season' ? channel : '';
  const seasonNumber = type === 'episode' ? nonNegativeInteger(row.ParentIndexNumber) : null;
  const episodeNumber = type === 'episode' ? nonNegativeInteger(row.IndexNumber) : null;
  return { id, type, title: cleanText(row.Name, 'Untitled'), subtitle, channel, seasonNumber, episodeNumber,
    duration: Number.isFinite(duration) && duration >= 0 ? Math.floor(duration / 10_000_000) : 0,
    sizeBytes: file?.sizeBytes || null, downloadable: ['movie', 'episode'].includes(type) && row.CanDownload === true && Boolean(file) };
}
function subtitleFormat(stream) {
  const codec = String(stream?.Codec || '').toLowerCase();
  if (codec === 'srt' || codec === 'subrip') return 'srt';
  if (codec === 'vtt' || codec === 'webvtt') return 'vtt';
  return null;
}
function externalSubtitleTracks(row, itemId) {
  const sources = Array.isArray(row?.MediaSources) ? row.MediaSources : [];
  if (sources.length !== 1) return [];
  const source = sources[0];
  if (!source || typeof source !== 'object' || source.Protocol !== 'File' || source.IsRemote || source.IsInfiniteStream || source.RequiresOpening || source.RequiresClosing) return [];
  let mediaSourceId;
  try { mediaSourceId = validateId(source.Id); } catch { return []; }
  const streams = Array.isArray(source.MediaStreams) ? source.MediaStreams : (Array.isArray(row.MediaStreams) ? row.MediaStreams : []);
  return streams.filter(stream => stream?.Type === 'Subtitle' && stream.IsExternal === true && stream.IsExternalUrl !== true)
    .map(stream => {
      const index = Number(stream.Index);
      const format = subtitleFormat(stream);
      if (!Number.isSafeInteger(index) || index < 0 || index > 9999 || !format) return null;
      const language = cleanText(stream.Language || stream.LanguageCode, 'und').slice(0, 32) || 'und';
      return { id: `${itemId}.${mediaSourceId}.${index}`, language, format, origin: 'external' };
    }).filter(Boolean).slice(0, 100);
}

class JellyfinClient {
  #token;
  constructor({ baseUrl, token, userId, deviceId = 'offgrid-local' } = {}) {
    this.baseUrl = normalizeServerUrl(baseUrl);
    if (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(token))) throw new JellyfinError('Jellyfin returned an invalid access token.');
    if ((token === undefined) !== (userId === undefined)) throw new JellyfinError('Reconnect to your Jellyfin server.');
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new JellyfinError('Invalid Jellyfin device identity.');
    this.deviceId = deviceId;
    this.#token = token;
    this.userId = userId === undefined ? undefined : validateId(userId);
  }
  async authenticate({ username, password, signal } = {}) {
    if (typeof username !== 'string' || !username.trim() || username.length > 256 || /[\u0000-\u001f\u007f]/.test(username) || typeof password !== 'string' || password.length > 4096) throw new JellyfinError('Enter your Jellyfin username and password.');
    const data = await this._json('/Users/AuthenticateByName', { signal, method: 'POST', body: { Username: username.trim(), Pw: password } });
    const userId = validateId(data.User?.Id);
    if (typeof data.AccessToken !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(data.AccessToken)) throw new JellyfinError('Jellyfin returned an invalid access token.');
    const serverId = data.ServerId;
    if (serverId !== undefined && (typeof serverId !== 'string' || !/^[\w-]{1,128}$/.test(serverId))) throw new JellyfinError('Jellyfin returned an invalid server identity.');
    return { token: data.AccessToken, userId, ...(serverId === undefined ? {} : { serverId }) };
  }
  _requireUser() {
    if (!this.#token || !this.userId) throw new JellyfinError('Connect to your Jellyfin server first.');
    return this.userId;
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
          timer = setTimeout(() => reject(new JellyfinError('Jellyfin server lookup timed out.', 'ETIMEDOUT', { retryable: true })), REQUEST_TIMEOUT);
          abort = () => reject(cancelled());
          signal?.addEventListener('abort', abort, { once: true });
        })
      ]);
      if (!results.length || results.some(result => !isLocalAddress(result.address))) throw new JellyfinError('Jellyfin connections must stay on the local network.');
      return results[0];
    } catch (error) {
      if (error instanceof JellyfinError) throw error;
      throw networkError(error, { fallback: 'Could not find the local Jellyfin server. Check its hostname or use its local IP address.' });
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }

  async _request(path, { signal, download = false, method = 'GET', body, headers = {}, allowRangeResponses = false } = {}) {
    if (allowRangeResponses) {
      if (!download || typeof path !== 'string' || !/^\/Items\/[a-f0-9]{32}\/Download$/i.test(path)) throw new JellyfinError('Range responses are restricted to original media downloads.');
      validateId(path.split('/')[2]);
    }
    if (path !== '/Users/AuthenticateByName') this._requireUser();
    const address = await this._resolve(signal);
    if (signal?.aborted) throw cancelled();
    const url = new URL(this.baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const protocol = url.protocol === 'https:' ? https : http;
      let deadline;
      const abort = () => request.destroy(cancelled());
      const request = protocol.request({
        protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
        path: url.pathname.replace(/\/$/, '') + path, method, agent: false,
        // Pin the verified answer to this connection, including DNS names that rebind.
        lookup: (_hostname, options, callback) => callback(null, options.all ? [address] : address.address, address.family),
        headers: { ...headers, Accept: download ? 'application/octet-stream' : 'application/json', 'Accept-Encoding': 'identity',
          Authorization: `MediaBrowser Client="Offgrid", Device="Offgrid", DeviceId="${this.deviceId}", Version="1.0"${this.#token ? `, Token="${this.#token}"` : ''}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) }
      }, response => {
        response.on('error', () => {});
        if (response.statusCode !== 200 && !(allowRangeResponses && [206, 416].includes(response.statusCode))) {
          response.destroy();
          reject(providerStatusError(response.statusCode));
        } else if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(new JellyfinError('Jellyfin returned an unsupported encoded response.'));
        } else resolve(response);
      });
      request.on('error', error => reject(networkError(error)));
      request.setTimeout(download ? DOWNLOAD_IDLE_TIMEOUT : REQUEST_TIMEOUT, () => request.destroy(new JellyfinError('Jellyfin connection timed out.', 'ETIMEDOUT', { retryable: true })));
      if (!download) deadline = setTimeout(() => request.destroy(new JellyfinError('Jellyfin request timed out.', 'ETIMEDOUT', { retryable: true })), REQUEST_TIMEOUT);
      request.on('close', () => { clearTimeout(deadline); signal?.removeEventListener('abort', abort); });
      signal?.addEventListener('abort', abort, { once: true });
      request.end(payload);
    });
  }

  async _json(path, { signal, ...options } = {}) {
    try {
      const response = await this._request(path, { ...options, signal });
      if (Number(response.headers['content-length']) > METADATA_LIMIT) { response.destroy(); throw new JellyfinError('Jellyfin library response is too large. Narrow your search.'); }
      let size = 0;
      const chunks = [];
      for await (const chunk of response) {
        size += chunk.length;
        if (size > METADATA_LIMIT) { response.destroy(); throw new JellyfinError('Jellyfin library response is too large. Narrow your search.'); }
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new JellyfinError('Jellyfin returned invalid library data.');
      return result;
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof JellyfinError) throw error;
      throw networkError(error, { fallback: 'Jellyfin returned incomplete or invalid library data.' });
    }
  }

  async identity({ signal } = {}) {
    const data = await this._json('/System/Info/Public', { signal });
    const serverId = cleanText(data.Id);
    if (!/^[\w-]{1,128}$/.test(serverId)) throw new JellyfinError('Jellyfin returned an invalid server identity.');
    return { serverId, name: cleanText(data.ServerName, 'Local Jellyfin server') };
  }
  async sections({ signal } = {}) {
    const data = await this._json(`/Users/${this._requireUser()}/Views`, { signal });
    if (!Array.isArray(data.Items)) throw new JellyfinError('Jellyfin returned invalid library data.');
    return data.Items.filter(row => row && ['movies', 'tvshows'].includes(row.CollectionType)).slice(0, 1000)
      .map(row => ({ id: validateId(row.Id), title: cleanText(row.Name, 'Library'), type: row.CollectionType === 'movies' ? 'movie' : 'show' }));
  }
  async browse({ sectionId, parentId, start = 0, query = '', signal } = {}) {
    if (!Number.isSafeInteger(start) || start < 0 || start > 10_000_000 || typeof query !== 'string' || query.length > 200) throw new JellyfinError('Invalid Jellyfin browsing options.');
    const params = new URLSearchParams({ ParentId: validateId(parentId ?? sectionId), StartIndex: String(start), Limit: String(PAGE_SIZE),
      Fields: 'MediaSources,Path,CanDownload', EnableImages: 'false', EnableUserData: 'false', SortBy: 'SortName', SortOrder: 'Ascending' });
    if (query.trim()) { params.set('SearchTerm', query.trim()); params.set('Recursive', 'true'); params.set('IncludeItemTypes', 'Movie,Series,Episode'); }
    const data = await this._json(`/Users/${this._requireUser()}/Items?${params}`, { signal });
    if (!Array.isArray(data.Items)) throw new JellyfinError('Jellyfin returned invalid library data.');
    const items = data.Items.slice(0, PAGE_SIZE).map(normalizeItem).filter(Boolean);
    const total = Number(data.TotalRecordCount);
    return { items, total: Number.isSafeInteger(total) && total >= 0 ? total : items.length, start };
  }
  async metadata(id, { signal } = {}) {
    id = validateId(id);
    const row = await this._json(`/Users/${this._requireUser()}/Items/${id}`, { signal });
    if (!row.Id || validateId(row.Id) !== id) throw new JellyfinError('Jellyfin media was not found.');
    const item = normalizeItem(row);
    if (!item || !['movie', 'episode'].includes(item.type)) throw new JellyfinError('Choose a movie or an episode to download.');
    if (row.CanDownload !== true) throw new JellyfinError('Your Jellyfin account cannot download this item. Ask the server administrator to allow downloads.');
    if (row.MediaSources?.length > 1 || Number(row.PartCount || 1) !== 1) throw new JellyfinError('Multiple-version and multi-part Jellyfin media is not supported yet.');
    const file = mediaFile(row);
    if (!file) throw new JellyfinError('The original Jellyfin media file is unavailable or uses an unsupported format.');
    return { ...item, ...file, downloadId: id, subtitleTracks: externalSubtitleTracks(row, id) };
  }

  async subtitleTracks(id, { signal } = {}) {
    return (await this.metadata(id, { signal })).subtitleTracks;
  }

  async download(metadata, destination, { signal, onProgress, resumeState, onCheckpoint, retainOnError = false } = {}) {
    const downloadId = validateId(metadata?.downloadId);
    const expected = positiveSize(metadata?.sizeBytes);
    if (!expected) throw new JellyfinError('Jellyfin did not provide the original file size.');
    if (signal?.aborted) throw cancelled();
    const revalidate = async () => {
      if (!metadata?.id) return false;
      const fresh = await this.metadata(metadata.id, { signal });
      return fresh.downloadId === downloadId && fresh.sizeBytes === expected && fresh.extension === metadata.extension
        && fresh.mediaSourceId === (metadata.mediaSourceId ?? null);
    };
    try {
      return await rangeTransfer({
        request: headers => this._request(`/Items/${downloadId}/Download`, { signal, download: true, headers, allowRangeResponses: true }),
        destination, totalBytes: expected, signal, onProgress, resumeState, onCheckpoint, retainOnError,
        revalidate: resumeState === undefined ? undefined : revalidate, errorPrefix: 'Jellyfin',
        isProviderError: error => error instanceof JellyfinError,
        mapError: error => networkError(error, { fallback: 'Jellyfin download failed or was interrupted. Please retry.' })
      });
    } catch (error) {
      if (signal?.aborted || error.code === 'ABORT_ERR') throw cancelled();
      if (error instanceof RangeTransferError) throw new JellyfinError(error.message, error.code, { retryable: error.retryable });
      if (error instanceof JellyfinError) throw error;
      throw new JellyfinError('Jellyfin download failed or was interrupted. Please retry.', error?.code || 'JELLYFIN_ERROR', { retryable: error?.retryable === true });
    }
  }

  async downloadSubtitle(track, destination, { signal } = {}) {
    const id = String(track?.id ?? '');
    const format = String(track?.format ?? '').toLowerCase();
    if (!/^[a-f0-9]{32}\.[a-f0-9]{32}\.\d{1,4}$/i.test(id) || !['vtt', 'srt'].includes(format)) throw new JellyfinError('Invalid Jellyfin subtitle selection.');
    const [itemId, mediaSourceId, indexText] = id.split('.');
    const index = Number(indexText);
    const metadata = await this.metadata(itemId, { signal });
    if (!metadata.subtitleTracks.some(candidate => candidate.id === `${itemId}.${mediaSourceId}.${index}` && candidate.format === format)) throw new JellyfinError('The selected Jellyfin subtitle is no longer available.');
    const response = await this._request(`/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/Stream.${format}`, { signal, download: true });
    try {
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type && !['text/vtt', 'text/plain', 'application/x-subrip', 'application/octet-stream'].includes(type)) throw new JellyfinError('Jellyfin returned an unsupported subtitle format.');
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > SUBTITLE_LIMIT)) throw new JellyfinError('Jellyfin subtitle is too large.');
      const chunks = []; let sizeBytes = 0;
      for await (const chunk of response) {
        if (signal?.aborted) throw cancelled();
        sizeBytes += chunk.length;
        if (sizeBytes > SUBTITLE_LIMIT) throw new JellyfinError('Jellyfin subtitle is too large.');
        chunks.push(chunk);
      }
      const contents = Buffer.concat(chunks);
      if (!sizeBytes) throw new JellyfinError('Jellyfin returned an empty subtitle.');
      if (length !== undefined && sizeBytes !== Number(length)) throw new JellyfinError('Jellyfin subtitle download was incomplete.');
      const text = contents.toString('utf8');
      if (text.includes('\u0000') || text.includes('\ufffd')) throw new JellyfinError('Jellyfin returned invalid subtitle text.');
      if (signal?.aborted) throw cancelled();
      await fs.promises.writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
      return { sizeBytes, format };
    } catch (error) { response.destroy(); if (signal?.aborted) throw cancelled(); if (error instanceof JellyfinError) throw error; throw networkError(error, { fallback: 'Jellyfin subtitle download failed. Please retry.' }); }
  }
}

module.exports = { JellyfinClient, JellyfinError, normalizeServerUrl, isLocalAddress, validateId, networkError };
