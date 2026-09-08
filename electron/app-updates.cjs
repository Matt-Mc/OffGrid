'use strict';

const RELEASE_API = 'https://api.github.com/repos/Matt-Mc/OffGrid/releases/latest';
const REPOSITORY_URL = 'https://github.com/Matt-Mc/OffGrid';
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS = 8000;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 100 || !STABLE_VERSION.test(value)) return null;
  return value.split('.').map(BigInt);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Expected stable release versions.');
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function validateRelease(data, currentVersion, { requireRuntimeManifest = false } = {}) {
  if (!data || data.draft !== false || data.prerelease !== false || typeof data.tag_name !== 'string') {
    throw new Error('Invalid release metadata.');
  }
  const version = data.tag_name.startsWith('v') ? data.tag_name.slice(1) : '';
  if (!parseVersion(version)) throw new Error('Invalid release version.');
  const url = `${REPOSITORY_URL}/releases/tag/v${version}`;
  if (data.html_url !== url) throw new Error('Unexpected release URL.');
  if (compareVersions(version, currentVersion) <= 0) return null;
  if (!Array.isArray(data.assets)) throw new Error('Missing release assets.');
  const asset = (name, maxSize, minSize = 1) => {
    const matches = data.assets.filter(item => item && item.name === name);
    if (matches.length !== 1) throw new Error('Missing or duplicate release asset.');
    const item = matches[0];
    const expectedUrl = `${REPOSITORY_URL}/releases/download/v${version}/${name}`;
    if (item.state !== 'uploaded' || item.browser_download_url !== expectedUrl
      || !Number.isSafeInteger(item.size) || item.size < minSize || item.size > maxSize) {
      throw new Error('Invalid release asset.');
    }
    const result = { name, url: expectedUrl, size: item.size };
    if (item.digest != null) {
      if (typeof item.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(item.digest)) {
        throw new Error('Invalid release asset digest.');
      }
      result.digest = item.digest.toLowerCase();
    }
    return result;
  };
  const release = {
    version, tag: `v${version}`, url,
    asset: asset(`Offgrid-${version}-arm64.dmg`, 1024 ** 3 - 1, 512),
    checksums: asset('SHA256SUMS', 64 * 1024),
  };
  if (requireRuntimeManifest) release.runtimeManifest = asset('mpv-runtime-manifest.json', MAX_METADATA_BYTES);
  return release;
}

async function readMetadata(response, signal, expectedUrl = RELEASE_API) {
  if (response.status !== 200 || (response.url && response.url !== expectedUrl)) {
    throw new Error('Release information unavailable.');
  }
  const declaredSize = response.headers.get('content-length');
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_METADATA_BYTES)) {
    throw new Error('Release metadata too large.');
  }
  if (!response.body) throw new Error('Missing release metadata.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('Release check cancelled.');
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) throw new Error('Release metadata too large.');
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw new Error('Release check cancelled.');
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', abort);
    // Cancel unread bytes on malformed or oversized responses as well.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function osVersion(value) {
  if (typeof value !== 'string' || !/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(value)) return null;
  return value.split('.').concat(value.split('.').length === 2 ? ['0'] : []).map(part => String(Number(part))).join('.');
}

async function readRuntimeManifest(fetchRelease, url, signal) {
  const initial = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchRelease(url, {
      method: 'GET', redirect: 'manual', signal,
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Offgrid-Update-Check' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      const next = new URL(response.headers.get('location'), url);
      if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash
        || !['github.com', 'release-assets.githubusercontent.com'].includes(next.hostname)
        || (next.hostname === 'github.com' && next.href !== initial)) {
        throw new Error('Unexpected release asset redirect.');
      }
      url = next.href;
      continue;
    }
    return readMetadata(response, signal, url);
  }
  throw new Error('Too many release asset redirects.');
}

function createAppUpdates(options = {}) {
  const currentVersion = options.currentVersion;
  const supported = (options.platform || process.platform) === 'darwin'
    && (options.arch || process.arch) === 'arm64' && Boolean(parseVersion(currentVersion));
  const fetchRelease = options.fetch || globalThis.fetch;
  const now = options.now || Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, MAX_TIMEOUT_MS) : 5000;
  let value = { state: supported ? 'idle' : 'unsupported', currentVersion };
  let lastCheck = -Infinity;
  let pending;
  let controller;
  let disposed = false;

  const status = () => structuredClone(value);
  const update = next => {
    if (disposed) return;
    value = { currentVersion, ...next };
    try { options.onChange?.(status()); } catch { /* A UI observer must not break a check. */ }
  };
  function check({ force = false } = {}) {
    if (pending) return pending;
    if (disposed || !supported || now() - lastCheck < (force ? 1000 : 60_000)) {
      return Promise.resolve(status());
    }
    lastCheck = now();
    const previousAvailable = value.state === 'available' ? status() : null;
    controller = new AbortController();
    const signal = controller.signal;
    update({ state: 'checking' });
    let timer;
    let abort;
    const deadline = new Promise((resolve, reject) => {
      abort = () => reject(new Error('Release check cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller?.abort(), timeoutMs);
    });
    const request = (async () => {
      const response = await fetchRelease(RELEASE_API, {
        method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Offgrid-Update-Check' },
      });
      if (signal.aborted) throw new Error('Release check cancelled.');
      const release = validateRelease(await readMetadata(response, signal), currentVersion, {
        requireRuntimeManifest: options.systemVersion !== undefined,
      });
      if (release && options.systemVersion !== undefined) {
        const manifest = await readRuntimeManifest(fetchRelease, release.runtimeManifest.url, signal);
        const minimum = osVersion(manifest.minimumMacOS);
        const system = osVersion(options.systemVersion);
        if (manifest.platform !== 'darwin' || manifest.architecture !== 'arm64' || !minimum || !system) {
          throw new Error('Invalid release compatibility information.');
        }
        if (compareVersions(system, minimum) < 0) {
          return { incompatible: true, version: release.version, minimumMacOS: manifest.minimumMacOS };
        }
        release.minimumMacOS = manifest.minimumMacOS;
      }
      return release;
    })();
    pending = Promise.race([request, deadline])
      .then(release => update(release?.incompatible ? {
        state: 'unsupported', version: release.version,
        message: `Offgrid ${release.version} requires macOS ${release.minimumMacOS} or later.`,
      } : release ? { state: 'available', release } : { state: 'up-to-date' }))
      .catch(() => update(previousAvailable || { state: 'unavailable' }))
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        controller = undefined;
        pending = undefined;
      })
      .then(status);
    return pending;
  }

  function dispose() {
    disposed = true;
    controller?.abort();
  }
  return { status, check, dispose };
}

module.exports = { createAppUpdates, compareVersions, validateRelease, RELEASE_API, REPOSITORY_URL, MAX_METADATA_BYTES };
