'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppUpdates, compareVersions, RELEASE_API, MAX_METADATA_BYTES } = require('../electron/app-updates.cjs');

function release(version = '0.4.0') {
  const base = 'https://github.com/Matt-Mc/OffGrid/releases';
  return {
    tag_name: `v${version}`, draft: false, prerelease: false, html_url: `${base}/tag/v${version}`,
    assets: [`Offgrid-${version}-arm64.dmg`, 'SHA256SUMS', 'mpv-runtime-manifest.json'].map(name => ({
      name, state: 'uploaded', browser_download_url: `${base}/download/v${version}/${name}`, size: 1024,
      digest: `sha256:${'a'.repeat(64)}`,
    })),
  };
}

const json = value => new Response(JSON.stringify(value), { status: 200 });
const checker = options => createAppUpdates({ currentVersion: '0.3.0', platform: 'darwin', arch: 'arm64', ...options });

test('stable semantic versions compare numerically and reject prereleases and malformed versions', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.1', '1.1.0'), -1);
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  for (const version of ['v1.0.0', '1.0', '01.0.0', '1.0.0-beta', '1.0.0+build', '', null]) {
    assert.throws(() => compareVersions(version, '1.0.0'));
  }
});

test('discovery uses only the fixed unauthenticated GitHub endpoint and returns vetted asset metadata', async () => {
  const events = [];
  const updates = checker({
    onChange: state => events.push(state.state),
    fetch: async (url, options) => {
      assert.equal(url, RELEASE_API);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
      return json(release());
    },
  });
  assert.equal(updates.status().state, 'idle');
  const result = await updates.check();
  assert.equal(result.state, 'available');
  assert.equal(result.release.version, '0.4.0');
  assert.equal(result.release.asset.name, 'Offgrid-0.4.0-arm64.dmg');
  assert.equal(result.release.asset.digest, `sha256:${'a'.repeat(64)}`);
  assert.deepEqual(events, ['checking', 'available']);
  result.release.asset.url = 'https://evil.example';
  assert.match(updates.status().release.asset.url, /^https:\/\/github.com\/Matt-Mc\/OffGrid\//);
});

test('equal and older versions are never offered', async () => {
  for (const version of ['0.3.0', '0.2.99']) {
    const result = await checker({ fetch: async () => json(release(version)) }).check();
    assert.equal(result.state, 'up-to-date');
    assert.equal(result.release, undefined);
  }
});

test('invalid, prerelease, foreign-repository, duplicate, and incomplete releases are not offered', async () => {
  const changes = [
    data => { data.draft = true; }, data => { data.prerelease = true; },
    data => { delete data.prerelease; }, data => { data.tag_name = 'v0.4.0-rc1'; },
    data => { data.tag_name = '0.4.0'; }, data => { data.html_url += '?other=1'; },
    data => { data.html_url = 'https://github.com/Other/OffGrid/releases/tag/v0.4.0'; },
    data => { data.assets[0].browser_download_url = 'https://evil.example/Offgrid.dmg'; },
    data => { data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('v0.4.0', 'v0.3.0'); },
    data => { data.assets[0].name = 'Offgrid-0.4.0-x64.dmg'; },
    data => { data.assets[0].state = 'new'; }, data => { data.assets[0].size = 0; },
    data => { data.assets[0].size = 2_000_000_001; }, data => { data.assets[0].digest = 'sha256:bad'; },
    data => { data.assets.push({ ...data.assets[0] }); }, data => { data.assets.splice(1, 1); },
    data => { data.assets = null; },
  ];
  for (const change of changes) {
    const data = release();
    change(data);
    const result = await checker({ fetch: async () => json(data) }).check();
    assert.equal(result.state, 'unavailable', change.toString());
    assert.equal(result.release, undefined);
  }
});

test('network, malformed JSON, HTTP and oversized responses remain quiet and credential-free', async () => {
  const responses = [
    async () => { throw new Error('secret network details'); },
    async () => new Response('bad JSON', { status: 200 }),
    async () => new Response('secret', { status: 403 }),
    async () => new Response('', { status: 404 }),
    async () => new Response('{}', { status: 200, headers: { 'content-length': `${MAX_METADATA_BYTES + 1}` } }),
    async () => new Response(' '.repeat(MAX_METADATA_BYTES + 1), { status: 200 }),
  ];
  for (const fetch of responses) {
    const result = await checker({ fetch }).check();
    assert.deepEqual(result, { state: 'unavailable', currentVersion: '0.3.0' });
  }
});

test('timeout bounds even a request that ignores AbortSignal, and prevents late writes', async () => {
  let finish;
  let signal;
  const updates = checker({ timeoutMs: 15, fetch: async (url, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal((await updates.check()).state, 'unavailable');
  assert.equal(signal.aborted, true);
  finish(json(release()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.status().state, 'unavailable');
});

test('a failed offline recheck preserves an already validated update offer', async () => {
  let time = 100_000;
  let calls = 0;
  const updates = checker({ now: () => time, fetch: async () => {
    if (++calls === 1) return json(release());
    throw new Error('Network is offline.');
  } });
  const available = await updates.check();
  time += 60_000;
  assert.deepEqual(await updates.check(), available);
});

test('timeout also bounds response body streaming and cancels the body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const updates = checker({ timeoutMs: 15, fetch: async () => response });
  assert.equal((await updates.check()).state, 'unavailable');
  assert.equal(cancelled, true);
});

test('checks are single flight and online retries obey cooldown, including a minimum manual delay', async () => {
  let calls = 0;
  let time = 100_000;
  let finish;
  const updates = checker({ now: () => time, fetch: () => {
    calls++;
    return new Promise(resolve => { finish = () => resolve(json(release())); });
  } });
  const a = updates.check();
  assert.equal(updates.check({ force: true }), a);
  finish();
  await a;
  time += 999;
  await updates.check({ force: true });
  assert.equal(calls, 1);
  time++;
  const b = updates.check({ force: true });
  finish(); await b;
  assert.equal(calls, 2);
  time += 59_999;
  await updates.check();
  assert.equal(calls, 2);
  time++;
  const c = updates.check();
  finish(); await c;
  assert.equal(calls, 3);
});

test('unsupported platforms and disposal never start new requests or emit late results', async () => {
  let calls = 0;
  for (const options of [{ platform: 'win32' }, { platform: 'linux' }, { arch: 'x64' }, { currentVersion: '0.4.0-beta' }]) {
    const updates = checker({ ...options, fetch: async () => { calls++; return json(release()); } });
    assert.equal((await updates.check()).state, 'unsupported');
  }
  assert.equal(calls, 0);
  const events = [];
  let signal;
  const updates = checker({ onChange: value => events.push(value.state), fetch: async (url, options) => {
    calls++;
    signal = options.signal;
    return new Promise(() => {});
  } });
  const pending = updates.check();
  updates.dispose();
  await pending;
  assert.equal(signal.aborted, true);
  await updates.check({ force: true });
  assert.equal(calls, 1);
  assert.deepEqual(events, ['checking']);
});

test('a packaged compatibility check requires the same-tag manifest and permits compatible macOS', async () => {
  const requests = [];
  const updates = checker({ systemVersion: '15.6.1', fetch: async (url, options) => {
    requests.push(url);
    if (url === RELEASE_API) return json(release());
    assert.equal(options.redirect, 'manual');
    return json({ platform: 'darwin', architecture: 'arm64', minimumMacOS: '15.0' });
  } });
  const result = await updates.check();
  assert.equal(result.state, 'available');
  assert.equal(result.release.minimumMacOS, '15.0');
  assert.deepEqual(requests, [RELEASE_API, 'https://github.com/Matt-Mc/OffGrid/releases/download/v0.4.0/mpv-runtime-manifest.json']);
});

test('a newer macOS requirement suppresses the download offer and explains the required version', async () => {
  const result = await checker({ systemVersion: '15.6.1', fetch: async url => url === RELEASE_API
    ? json(release()) : json({ platform: 'darwin', architecture: 'arm64', minimumMacOS: '26.0' }),
  }).check();
  assert.equal(result.state, 'unsupported');
  assert.equal(result.release, undefined);
  assert.match(result.message, /0\.4\.0 requires macOS 26\.0/);
});

test('missing or malformed runtime compatibility information is not offered', async () => {
  for (const manifest of [{}, { platform: 'linux', architecture: 'arm64', minimumMacOS: '15.0' },
    { platform: 'darwin', architecture: 'x64', minimumMacOS: '15.0' },
    { platform: 'darwin', architecture: 'arm64', minimumMacOS: '15' }]) {
    assert.equal((await checker({ systemVersion: '15.6', fetch: async url => url === RELEASE_API
      ? json(release()) : json(manifest),
    }).check()).state, 'unavailable');
  }
  const data = release(); data.assets.pop();
  assert.equal((await checker({ systemVersion: '15.6', fetch: async () => json(data) }).check()).state, 'unavailable');
});

test('runtime manifest follows only bounded HTTPS GitHub asset redirects', async () => {
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/manifest';
  const result = await checker({ systemVersion: '15.6', fetch: async url => {
    if (url === RELEASE_API) return json(release());
    if (url === cdn) return json({ platform: 'darwin', architecture: 'arm64', minimumMacOS: '15.0' });
    return new Response(null, { status: 302, headers: { location: cdn } });
  } }).check();
  assert.equal(result.state, 'available');
  for (const location of ['http://release-assets.githubusercontent.com/bad', 'https://evil.example/manifest',
    'https://user:secret@github.com/bad', 'https://github.com:8443/bad']) {
    let calls = 0;
    const status = await checker({ systemVersion: '15.6', fetch: async url => {
      calls++;
      return url === RELEASE_API ? json(release()) : new Response(null, { status: 302, headers: { location } });
    } }).check();
    assert.equal(status.state, 'unavailable');
    assert.equal(calls, 2);
  }
});
