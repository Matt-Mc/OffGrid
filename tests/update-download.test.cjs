'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdateDownload } = require('../electron/update-download.cjs');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = Buffer.alloc(1024, 42);
  data.write('koly', data.length - 512, 'ascii');
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  const name = 'Offgrid-0.4.0-arm64.dmg';
  const checksums = `${digest}  ${name}\n`;
  const root = 'https://github.com/Matt-Mc/OffGrid/releases';
  const release = {
    version: '0.4.0', tag: 'v0.4.0', url: `${root}/tag/v0.4.0`,
    asset: { name, url: `${root}/download/v0.4.0/${name}`, size: data.length, digest: `sha256:${digest}` },
    checksums: { name: 'SHA256SUMS', url: `${root}/download/v0.4.0/SHA256SUMS`, size: Buffer.byteLength(checksums) },
  };
  const requests = [];
  const opened = [];
  const states = [];
  const download = createUpdateDownload({
    platform: 'darwin', arch: 'arm64',
    directory,
    fetch: async (url, opts) => {
      requests.push({ url, opts });
      return new Response(url.endsWith('SHA256SUMS') ? checksums : data);
    },
    openPath: async file => { opened.push({ file, data: await fs.readFile(file) }); return ''; },
    onChange: state => states.push(state),
    freeBytes: async () => 3 * 1024 ** 3,
    ...options,
  });
  t.after(() => download.dispose());
  return { directory, data, digest, checksums, release, requests, opened, states, download };
}

test('downloads and verifies the exact release before opening a privately created installer', async t => {
  const f = await fixture(t);
  const state = await f.download.download(f.release);
  assert.equal(state.state, 'ready');
  assert.equal(state.progress, 1);
  assert.equal(state.downloadedBytes, f.data.length);
  assert.equal(f.opened.length, 1);
  assert.deepEqual(f.opened[0].data, f.data);
  assert.equal(path.basename(f.opened[0].file), f.release.asset.name);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.opened[0].file)).mode & 0o777, 0o600);
  assert.equal(f.requests.length, 2);
  for (const { opts } of f.requests) {
    assert.equal(opts.redirect, 'manual');
    assert.equal(opts.credentials, 'omit');
    assert.equal(opts.headers.Authorization, undefined);
  }
  assert.equal((await f.download.download(f.release)).state, 'ready');
  assert.equal(f.opened.length, 2);
  assert.equal(f.requests.length, 2, 'reopening the verified cache does not use the network');
});

test('rejects manipulated release URLs, versions, filenames, digests and oversized downloads before any request', async t => {
  const f = await fixture(t);
  const invalid = [
    { version: '../0.4.0' }, { tag: 'v0.5.0' }, { url: f.release.url + '?token=secret' },
    { asset: { ...f.release.asset, name: '../../something.dmg' } },
    { asset: { ...f.release.asset, url: 'https://evil.test/installer.dmg' } },
    { asset: { ...f.release.asset, size: 1024 ** 3 } },
    { asset: { ...f.release.asset, size: -1 } },
    { asset: { ...f.release.asset, digest: 'sha1:secret' } },
    { checksums: { ...f.release.checksums, url: f.release.checksums.url.replace('Matt-Mc', 'other') } },
    { checksums: { ...f.release.checksums, size: 65537 } },
  ];
  for (const change of invalid) await assert.rejects(f.download.download({ ...f.release, ...change }), /update information is invalid/);
  assert.equal(f.requests.length, 0);
});

test('follows a bounded HTTPS GitHub asset redirect without forwarding credentials', async t => {
  let f;
  const urls = [];
  f = await fixture(t, { fetch: async (url, opts) => {
    urls.push(url);
    assert.equal(opts.headers.Authorization, undefined);
    if (url.endsWith('SHA256SUMS')) return new Response(f.checksums);
    if (url.startsWith('https://github.com/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/123/file?signature=opaque' } });
    return new Response(f.data);
  } });
  assert.equal((await f.download.download(f.release)).state, 'ready');
  assert.equal(urls.length, 3);
});

test('blocks untrusted, credential-bearing, downgraded and looping redirects', async t => {
  for (const redirect of ['https://evil.test/file', 'http://release-assets.githubusercontent.com/file', 'https://user:secret@release-assets.githubusercontent.com/file', 'https://github.com/other/repo/file', 'https://release-assets.githubusercontent.com/file']) {
    const f = await fixture(t, { fetch: async () => new Response(null, { status: 302, headers: { location: redirect } }) });
    const result = await f.download.download(f.release);
    assert.equal(result.state, 'error');
    assert.doesNotMatch(result.message, /secret|evil|https:/);
    assert.equal(f.opened.length, 0);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test('corrupt, truncated, oversized, HTML and non-DMG bodies never open and remove partial files', async t => {
  for (const type of ['corrupt', 'truncated', 'oversized', 'html', 'not-dmg', 'length']) {
    let f;
    f = await fixture(t, { fetch: async url => {
      let data = Buffer.from(f.data);
      if (type === 'not-dmg') data.fill(0);
      if (url.endsWith('SHA256SUMS')) {
        if (type !== 'not-dmg') return new Response(f.checksums);
        const digest = crypto.createHash('sha256').update(data).digest('hex');
        return new Response(`${digest}  ${f.release.asset.name}\n`);
      }
      if (type === 'corrupt') data[0] ^= 1;
      if (type === 'truncated') data = data.subarray(0, -1);
      if (type === 'oversized') data = Buffer.concat([data, Buffer.from('x')]);
      return new Response(type === 'html' ? '<html>secret</html>' : data, {
        headers: type === 'html' ? { 'content-type': 'text/html' } : type === 'length' ? { 'content-length': '999' } : {},
      });
    } });
    if (type === 'not-dmg') delete f.release.asset.digest;
    assert.equal((await f.download.download(f.release)).state, 'error', type);
    assert.equal(f.opened.length, 0, type);
    assert.deepEqual(await fs.readdir(f.directory), [], type);
  }
});

test('checksum files must contain one exact filename and agree with the optional release digest', async t => {
  for (const type of ['duplicate', 'missing', 'malformed', 'digest', 'huge', 'truncated']) {
    let f;
    f = await fixture(t, { fetch: async () => {
      const bodies = {
        duplicate: f.checksums + f.checksums,
        missing: f.checksums.replace(f.release.asset.name, `./${f.release.asset.name}`),
        malformed: 'not a checksum\n', digest: f.checksums.replace(f.digest, '0'.repeat(64)),
        huge: 'x'.repeat(65537), truncated: f.checksums.slice(0, -2),
      };
      return new Response(bodies[type]);
    } });
    if (type === 'duplicate') f.release.checksums.size *= 2;
    if (type === 'missing') f.release.checksums.size += 2;
    if (type === 'malformed') f.release.checksums.size = 15;
    assert.equal((await f.download.download(f.release)).state, 'error', type);
    assert.equal(f.opened.length, 0);
  }
});

test('preserves a 2 GB free-space reserve before network requests', async t => {
  const f = await fixture(t, { freeBytes: async () => 2 * 1024 ** 3 });
  const state = await f.download.download(f.release);
  assert.equal(state.state, 'error');
  assert.match(state.message, /free space/);
  assert.equal(f.requests.length, 0);
});

test('reuses an active operation and cancellation settles a stalled response with no late installer opening', async t => {
  let f;
  let start;
  const started = new Promise(resolve => { start = resolve; });
  f = await fixture(t, { fetch: async url => {
    if (url.endsWith('SHA256SUMS')) return new Response(f.checksums);
    start();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(f.data.subarray(0, 100)); } }));
  } });
  const first = f.download.download(f.release);
  assert.equal(f.download.download(f.release), first);
  await started;
  await f.download.cancel();
  assert.equal((await first).state, 'idle');
  assert.match(f.download.status().message, /cancelled/);
  assert.equal(f.opened.length, 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('timeouts and network errors are sanitized, including fetch implementations that ignore abort', async t => {
  const f = await fixture(t, { timeoutMs: 10, fetch: () => new Promise(() => {}) });
  const state = await f.download.download(f.release);
  assert.equal(state.state, 'error');
  assert.match(state.message, /timed out/);
  const g = await fixture(t, { fetch: async () => { throw new Error('https://secret-token@private-server'); } });
  assert.doesNotMatch((await g.download.download(g.release)).message, /secret|private/);
});

test('failed installer opening reports an error and cleans its private download; dispose prevents future downloads', async t => {
  const f = await fixture(t, { openPath: async () => 'OS error containing private details' });
  const state = await f.download.download(f.release);
  assert.equal(state.state, 'error');
  assert.match(state.message, /could not be opened/);
  assert.deepEqual(await fs.readdir(f.directory), []);
  await f.download.dispose();
  await assert.rejects(f.download.download(f.release), /cancelled/);
});

test('cancelling after verified installer handoff waits for the OS and retains the opened image', async t => {
  let started;
  let finish;
  const handoff = new Promise(resolve => { started = resolve; });
  const completion = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { openPath: async () => { started(); return completion; } });
  const result = f.download.download(f.release);
  await handoff;
  const cancellation = f.download.cancel();
  finish('');
  assert.equal((await result).state, 'ready');
  await cancellation;
  assert.equal((await fs.readdir(f.directory)).length, 1);
});

test('all emitted snapshots use the UI state contract and reopening refuses a modified cached installer', async t => {
  const f = await fixture(t);
  assert.equal(f.download.status().state, 'idle');
  await f.download.download(f.release);
  assert.equal(f.download.status().state, 'ready');
  assert.ok(f.states.some(snapshot => snapshot.state === 'downloading'));
  assert.ok(f.states.every(snapshot => typeof snapshot.state === 'string' && !('status' in snapshot)));
  const altered = Buffer.from(f.data);
  altered[0] ^= 1;
  await fs.writeFile(f.opened[0].file, altered);
  const result = await f.download.download(f.release);
  assert.equal(result.state, 'error');
  assert.match(result.message, /could not be verified/);
  assert.equal(f.opened.length, 1, 'a modified installer must not be opened again');
  assert.equal(f.requests.length, 2, 'cache verification does not download anything');
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('reopening refuses a cached installer replaced with a symlink even when the target bytes match', async t => {
  const f = await fixture(t);
  await f.download.download(f.release);
  const target = path.join(f.directory, 'external.dmg');
  await fs.writeFile(target, f.data);
  await fs.unlink(f.opened[0].file);
  try { await fs.symlink(target, f.opened[0].file); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('File symlinks require Windows Developer Mode.'); throw error; }
  assert.equal((await f.download.download(f.release)).state, 'error');
  assert.equal(f.opened.length, 1);
  assert.deepEqual(await fs.readFile(target), f.data);
});

test('reopens verified installers when the supplied cache root has a legitimate ancestor symlink', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-cache-alias-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  await fs.mkdir(actual);
  await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const f = await fixture(t, { directory: path.join(alias, 'updates') });
  assert.equal((await f.download.download(f.release)).state, 'ready');
  assert.equal((await f.download.download(f.release)).state, 'ready');
  assert.equal(f.opened.length, 2);
  assert.equal(f.requests.length, 2);
  assert.ok(f.opened[0].file.startsWith(await fs.realpath(actual)));
});
