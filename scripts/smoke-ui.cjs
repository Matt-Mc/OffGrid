// Runs the built app against disposable data. Never opens the user's library.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const crypto = require('node:crypto');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ui-'));
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
fs.mkdirSync(path.join(temporary, 'videos'));
fs.mkdirSync(path.join(temporary, 'thumbnails'));

async function main() {
  const media = path.join(temporary, 'videos', 'sample.mp4');
  const clip = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=0x486352:s=640x360:r=10:d=60', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media,
  ]);
  if (clip.status !== 0) throw new Error('UI smoke test needs ffmpeg on PATH to create a local playback fixture.');
  const videos = [
    { id: 'sample', title: 'A quieter way to travel', channel: 'Weekend Journal', playbackPositionSeconds: 12, watched: false },
    { id: 'forest', title: 'Walking the forest trail', channel: 'Slow Outside', playbackPositionSeconds: 0, watched: false },
    { id: 'coffee', title: 'Coffee before the train', channel: 'Everyday Notes', playbackPositionSeconds: 60, watched: true },
  ].map((item, index) => {
    const filePath = path.join(temporary, 'videos', `${item.id}.mp4`);
    if (filePath !== media) fs.copyFileSync(media, filePath);
    const thumbnailPath = path.join(temporary, 'thumbnails', `${item.id}.svg`);
    const colors = ['#7b9278', '#567763', '#b19a7d'];
    fs.writeFileSync(thumbnailPath, `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${colors[index]}"/><circle cx="490" cy="90" r="36" fill="#efe4c7"/><path d="M0 280L150 130L310 270L450 160L640 290V360H0Z" fill="#344e42"/><path d="M0 325L200 240L440 330L640 260V360H0Z" fill="#253d32"/></svg>`);
    return { ...item, duration: 60, sourceId: `fixture-${item.id}`, url: `https://www.youtube.com/watch?v=fixture-${item.id}`, filePath, thumbnailPath, sizeBytes: fs.statSync(filePath).size, savedAt: new Date(Date.now() - index * 86400000).toISOString(), comments: [], channelUrl: 'https://www.youtube.com/@fixture' };
  });
  fs.writeFileSync(path.join(temporary, 'library.json'), JSON.stringify(videos));
  fs.writeFileSync(path.join(temporary, 'settings.json'), JSON.stringify({ version: 1, defaultQuality: '720p', saveComments: false, maxLibraryBytes: null, autoDownload: false, checkIntervalHours: 6, recentVideoCount: 3 }));
  fs.writeFileSync(path.join(temporary, 'subscriptions.json'), JSON.stringify([{ id: 'channel-fixture', channel: 'Weekend Journal', channelUrl: 'https://www.youtube.com/@fixture', autoDownload: false, addedAt: new Date().toISOString(), lastCheckedAt: null }]));

  const queuedId = crypto.randomUUID();
  const failedId = crypto.randomUUID();
  fs.writeFileSync(path.join(temporary, 'downloads.json'), JSON.stringify({ paused: true, jobs: [
    { id: queuedId, source: 'manual', url: 'https://www.youtube.com/watch?v=queued-fixture', sourceId: 'queued-fixture', title: 'A video for the journey', status: 'queued', quality: '720p', saveComments: false, expectedBytes: 140000000, progress: 0, message: 'Waiting to download', createdAt: new Date().toISOString() },
    { id: failedId, source: 'manual', url: 'https://www.youtube.com/watch?v=retry-fixture', sourceId: 'retry-fixture', title: 'A download to retry', status: 'error', quality: '1080p', saveComments: false, expectedBytes: 260000000, progress: 0, message: 'Connection interrupted. Retry when connected.', error: 'Connection interrupted. Retry when connected.', createdAt: new Date().toISOString() },
    { id: crypto.randomUUID(), source: 'manual', url: videos[0].url, sourceId: videos[0].sourceId, videoId: videos[0].id, title: videos[0].title, status: 'complete', quality: '720p', saveComments: false, expectedBytes: videos[0].sizeBytes, progress: 100, message: 'Ready to watch', createdAt: new Date().toISOString() },
  ] }));

  const portServer = net.createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const executable = require('electron');
  const proc = spawn(executable, ['.', `--remote-debugging-port=${port}`], {
    cwd: root, env: { ...process.env, OFFGRID_DATA_DIR: temporary, OFFGRID_TEST_MODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', chunk => output += chunk);
  proc.stderr.on('data', chunk => output += chunk);
  console.log(`Isolated UI fixture: ${temporary}`);
  let socket;
  try {
    let target;
    for (let i = 0; i < 100; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
      if (target) break;
      if (proc.exitCode !== null) throw new Error(`Electron exited: ${output}`);
      await sleep(100);
    }
    if (!target) throw new Error(`Electron debugging endpoint unavailable: ${output}`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    let nextId = 0;
    const pending = new Map();
    const exceptions = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 80; i++) { if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return; await sleep(100); }
      throw new Error(`Timed out: ${expression}`);
    };
    const click = async label => {
      const clicked = await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim().replace(/\\s*\\d+$/, '') === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.matches('.nav-item') && b.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)}); if (!el) return false; el.click(); return true; })()`);
      assert.equal(clicked, true, `Button exists: ${label}`);
      await sleep(150);
    };
    const capture = async name => {
      const result = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from(result.data, 'base64'));
    };
    await call('Runtime.enable');
    await waitFor(`document.body.innerText.includes('A quieter way to travel')`);
    await capture('library');
    const saved = await evaluate('window.offgrid.getSettings()');
    assert.equal(saved.defaultQuality, '720p');
    const storage = await evaluate('window.offgrid.getStorage()');
    assert.equal(storage.libraryPath.startsWith(temporary), true);
    assert.ok(storage.savedBytes > 0);
    await evaluate(`window.offgrid.updateSettings({defaultQuality:'480p'})`);
    assert.equal((await evaluate('window.offgrid.getSettings()')).defaultQuality, '480p');
    await click('Settings');
    await waitFor(`document.body.innerText.includes('Maximum library size')`);
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="Default download quality"]'); select.value = '1080p'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`window.offgrid.getSettings().then(value => value.defaultQuality === '1080p')`);
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="Maximum library size"]'); select.value = '20'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await click('Apply limit');
    await waitFor(`window.offgrid.getSettings().then(value => value.maxLibraryBytes === 20000000000)`);
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="Maximum library size"]'); select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('input[aria-label="Custom library limit in GB"]')`);
    await evaluate(`(() => { const input = document.querySelector('input[aria-label="Custom library limit in GB"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '4.1'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('Apply limit');
    await waitFor(`window.offgrid.getSettings().then(value => value.maxLibraryBytes === 4100000000)`);
    await capture('settings');
    await evaluate(`document.querySelector('#storage')?.scrollIntoView()`);
    await capture('storage');
    await click('Downloads');
    await capture('downloads');
    await click('Cancel');
    await waitFor(`window.offgrid.listDownloads().then(value => value.jobs.find(job => job.id === '${queuedId}').status === 'canceled')`);
    await evaluate(`(() => { const row = [...document.querySelectorAll('.download-row')].find(row => row.textContent.includes('A download to retry')); [...row.querySelectorAll('button')].find(button => button.textContent === 'Retry').click(); })()`);
    await waitFor(`window.offgrid.listDownloads().then(value => value.jobs.find(job => job.id === '${failedId}').status === 'queued')`);
    await click('Following');
    await capture('following');
    await click('Library');
    await click('Play A quieter way to travel');
    await waitFor(`document.querySelector('video')?.readyState >= 1`);
    await evaluate(`(() => { window.__smokePlayer = document.querySelector('video'); window.__smokePlayer.pause(); window.__smokePlayer.currentTime = 24; })()`);
    await click('Settings');
    assert.equal(await evaluate(`document.querySelector('video') === window.__smokePlayer`), true, 'Navigation preserves the mounted player');
    await capture('settings-with-player');
    await click('Close player');
    await waitFor(`!document.querySelector('video')`);
    const watchedVideo = (await evaluate('window.offgrid.listVideos()')).find(video => video.id === 'sample');
    assert.ok(watchedVideo.playbackPositionSeconds >= 23, 'Closing the player saves playback progress');
    await call('Emulation.setDeviceMetricsOverride', { width: 820, height: 720, deviceScaleFactor: 1, mobile: false });
    await capture('settings-narrow');
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'No horizontal overflow');
    await click('Library');
    await click('Play A quieter way to travel');
    await waitFor(`document.querySelector('video')?.readyState >= 1`);
    await click('Settings');
    await click('Manage saved videos');
    await evaluate(`(() => { const row = [...document.querySelectorAll('.storage-video-row')].find(row => row.textContent.includes('A quieter way to travel')); row.querySelector('input').click(); })()`);
    await evaluate(`document.querySelector('.manager-actions button').click()`);
    await waitFor(`document.querySelector('dialog')?.open`);
    await click('Delete permanently');
    await waitFor(`window.offgrid.listVideos().then(videos => !videos.some(video => video.id === 'sample'))`);
    await sleep(250);
    assert.equal(await evaluate(`!!document.querySelector('.app-error')`), false, 'Deleting the playing video does not surface a stale playback error');
    assert.equal(exceptions.length, 0, `No renderer exceptions: ${JSON.stringify(exceptions)}`);
    console.log(JSON.stringify({ ok: true, screenshots, fixtureDirectory: temporary, checks: ['Library renders local fixtures', 'Preferences persist through IPC and Settings controls', 'Storage reports real files', 'Settings, Downloads, Following render', 'Playback survives navigation and saves progress', 'Queue cancel/retry controls', 'Delete playing video without stale errors', 'No horizontal overflow at 820px', 'No renderer exceptions'] }, null, 2));
  } finally {
    if (socket) socket.close();
    proc.kill('SIGTERM');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
