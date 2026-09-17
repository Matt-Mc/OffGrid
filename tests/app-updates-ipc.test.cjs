'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createHarness, eventually } = require('./backend-harness.cjs');
const { createUpdateDownload } = require('../electron/update-download.cjs');

function updateFixtures() {
  let checkState = { state: 'idle', currentVersion: '0.3.0' };
  let downloadState = { state: 'idle' };
  let checkOptions;
  let downloadOptions;
  const checkCalls = [];
  const downloads = [];
  let checksDisposed = 0;
  let downloadsDisposed = 0;
  let cancelCalls = 0;
  return {
    checkCalls, downloads,
    get checkOptions() { return checkOptions; },
    get downloadOptions() { return downloadOptions; },
    get disposed() { return [checksDisposed, downloadsDisposed]; },
    get cancelCalls() { return cancelCalls; },
    setCheck(value) { checkState = structuredClone(value); checkOptions.onChange(checkState); },
    setDownload(value) { downloadState = structuredClone(value); downloadOptions.onChange(downloadState); },
    updatesFactory(options) {
      checkOptions = options;
      return { status: () => structuredClone(checkState), check: async options => {
        checkCalls.push(options); return structuredClone(checkState);
      }, dispose() { checksDisposed++; } };
    },
    updateDownloadFactory(options) {
      downloadOptions = options;
      return { status: () => structuredClone(downloadState), download: async release => {
        downloads.push(structuredClone(release)); return structuredClone(downloadState);
      }, cancel: async () => { cancelCalls++; }, dispose: async () => { downloadsDisposed++; } };
    },
  };
}

async function fixture(t, options = {}) {
  // Main-process HTTPS and spawned tools are harness fixtures. These factories
  // additionally isolate the updater modules, which use native fetch directly.
  const updates = updateFixtures();
  const harness = await createHarness({ ...updates, appVersion: '0.3.0', ...options });
  t.after(() => harness.dispose());
  return { harness, updates };
}

test('test mode exposes update IPC without checking GitHub or downloading from renderer input', async t => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('External network forbidden in fixture.'); });
  const { harness, updates } = await fixture(t);
  assert.equal(updates.checkOptions.currentVersion, '0.3.0');
  const before = await harness.api.appUpdateStatus();
  assert.deepEqual(before, { check: { state: 'idle', currentVersion: '0.3.0' }, download: { state: 'idle' } });
  await harness.api.checkAppUpdate();
  await harness.api.checkAppUpdate(true);
  await harness.invoke('app:update-download', 'https://evil.example/installer.dmg');
  assert.equal(updates.checkCalls.length, 0);
  assert.equal(updates.downloads.length, 0);
  assert.equal(fetches, 0);
  assert.equal(harness.networkRequests, 0);
});

test('packaged startup schedules discovery after IPC is ready and checks online state', async t => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('External network forbidden in fixture.'); });
  const { harness, updates } = await fixture(t, { testMode: false });
  assert.equal(updates.checkCalls.length, 0, 'startup must not await a network check before registering IPC');
  assert.deepEqual(await harness.api.listVideos(), []);
  await eventually(() => updates.checkCalls.length === 1, 'startup check did not run', 2500);
  assert.equal(updates.checkCalls[0].force, false);
  harness.setOnline(false);
  await harness.api.checkAppUpdate(true);
  assert.equal(updates.checkCalls.length, 1, 'automatic offline check must not contact GitHub');
  await harness.api.checkAppUpdate();
  assert.equal(updates.checkCalls.length, 2);
  assert.equal(updates.checkCalls[1].force, true);
  assert.equal(fetches, 0);
});

test('download IPC selects only the main-process validated release and snapshot broadcasts match status', async t => {
  const { harness, updates } = await fixture(t, { testMode: false });
  const release = { version: '0.4.0', tag: 'v0.4.0', asset: { name: 'vetted.dmg', url: 'vetted-release-url' } };
  updates.setCheck({ state: 'available', currentVersion: '0.3.0', release });
  updates.setDownload({ state: 'downloading', downloadedBytes: 100, totalBytes: 1024 });
  const status = await harness.api.appUpdateStatus();
  const broadcast = harness.events.filter(event => event.channel === 'app:update-status').at(-1);
  assert.deepEqual(broadcast.value, status);
  assert.equal(updates.downloadOptions.directory, path.join(harness.dataDir, 'updates'));
  assert.equal(updates.downloadOptions.freeBytes(), 1e12);
  await harness.api.checkAppUpdate();
  assert.equal(updates.checkCalls.length, 0, 'a download in progress must not be invalidated by a new check');
  updates.setDownload({ state: 'idle' });
  await harness.invoke('app:update-download', { version: '99.0.0', asset: { url: 'https://evil.example/payload' } });
  assert.deepEqual(updates.downloads, [release]);
  await harness.api.downloadAppUpdate('https://evil.example/ignored');
  assert.deepEqual(updates.downloads, [release, release]);
  updates.setCheck({ state: 'unavailable', currentVersion: '0.3.0' });
  await harness.api.downloadAppUpdate();
  assert.equal(updates.downloads.length, 2);
  await harness.api.cancelAppUpdate();
  assert.equal(updates.cancelCalls, 1);
});

test('quit disposes update discovery and download work', async () => {
  const updates = updateFixtures();
  const harness = await createHarness({ ...updates });
  await harness.dispose();
  assert.deepEqual(updates.disposed, [1, 1]);
});

test('real downloader sends progress and ready states through main IPC and reopens its verified installer', async t => {
  let externalFetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { externalFetches++; throw new Error('External network forbidden in fixture.'); });
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
  let finishBody;
  const { harness, updates } = await fixture(t, {
    testMode: false,
    updateDownloadFactory: options => createUpdateDownload({
      ...options,
      platform: 'darwin', arch: 'arm64',
      fetch: async url => {
        requests.push(url);
        if (url === release.checksums.url) return new Response(checksums);
        assert.equal(url, release.asset.url);
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(data.subarray(0, 512));
          finishBody = () => { controller.enqueue(data.subarray(512)); controller.close(); };
        } }));
      },
      openPath: async file => { opened.push({ file, bytes: await fs.readFile(file) }); return ''; },
      freeBytes: () => 1e12,
    }),
  });
  updates.setCheck({ state: 'available', currentVersion: '0.3.0', release });
  assert.equal((await harness.api.appUpdateStatus()).download.state, 'idle');
  const pending = harness.invoke('app:update-download', { asset: { url: 'https://evil.example/ignored.dmg' } });
  await eventually(() => harness.events.some(event => event.channel === 'app:update-status'
    && event.value.download.downloadedBytes === 512), 'download progress did not reach main IPC');
  const progress = await harness.api.appUpdateStatus();
  assert.equal(progress.download.state, 'downloading');
  assert.equal(progress.download.progress, 0.5);
  assert.equal(progress.download.totalBytes, 1024);
  await harness.api.checkAppUpdate();
  assert.equal(updates.checkCalls.length, 0, 'real download status must prevent a competing release check');
  finishBody();
  const complete = await pending;
  assert.equal(complete.download.state, 'ready', JSON.stringify(complete.download));
  assert.equal(complete.download.progress, 1);
  assert.equal(complete.download.downloadedBytes, 1024);
  assert.deepEqual(harness.events.filter(event => event.channel === 'app:update-status').at(-1).value, complete);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].bytes, data);
  assert.equal(path.basename(opened[0].file), name);
  assert.ok(opened[0].file.startsWith(await fs.realpath(path.join(harness.dataDir, 'updates')) + path.sep));
  assert.deepEqual(requests, [release.checksums.url, release.asset.url]);
  assert.equal((await harness.api.downloadAppUpdate()).download.state, 'ready');
  assert.equal(opened.length, 2, 'the ready action must reopen the already verified installer');
  assert.equal(opened[1].file, opened[0].file);
  assert.equal(requests.length, 2, 'reopening a verified cached installer must not download it again');
  assert.equal(externalFetches, 0);
});
