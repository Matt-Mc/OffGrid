// Disposable Plex server and app data; never reads a user's server credentials or library.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const net = require('node:net');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-plex-ui-'));
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
const fixtureToken = 'offgrid-disposable-ui-fixture-token';
const media = Buffer.alloc(64 * 1024, 7);
const requests = [];
let interruptMetadata = false;
const movie = (id, title) => ({ ratingKey: String(id), type: 'movie', title, year: 2025, duration: 4200000, Media: [{ container: 'mkv', Part: [{ key: `/library/parts/${id}/1/file.mkv`, size: media.length, container: 'mkv' }] }] });
const movies = Array.from({ length: 101 }, (_, index) => movie(1000 + index, index === 0 ? 'A Quiet Weekend' : `Fixture Movie ${String(index + 1).padStart(3, '0')}`));
const episode = { ...movie(3001, 'The First Journey'), type: 'episode', grandparentTitle: 'Slow Roads', parentIndex: 1, index: 1 };
const fixture = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  requests.push({ pathname: url.pathname, query: url.search, authenticated: request.headers['x-plex-token'] === fixtureToken });
  if (request.headers['x-plex-token'] !== fixtureToken) { response.writeHead(401); response.end(); return; }
  if (interruptMetadata && url.pathname === '/library/metadata/1000') { request.socket.destroy(); return; }
  const json = data => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ MediaContainer: data })); };
  const listing = items => {
    const query = url.searchParams.get('title')?.toLowerCase();
    if (query) items = items.filter(item => item.title.toLowerCase().includes(query));
    const start = Number(request.headers['x-plex-container-start'] || 0);
    json({ totalSize: items.length, Metadata: items.slice(start, start + 100) });
  };
  if (url.pathname === '/') json({ machineIdentifier: 'fixture-plex-server', friendlyName: 'Home Cinema' });
  else if (url.pathname === '/library/sections') json({ Directory: [{ key: '1', title: 'Movies', type: 'movie' }, { key: '2', title: 'TV Shows', type: 'show' }] });
  else if (url.pathname === '/library/sections/1/all') listing(movies);
  else if (url.pathname === '/library/sections/2/all') listing([{ ratingKey: '2001', type: 'show', title: 'Slow Roads' }]);
  else if (url.pathname === '/library/metadata/2001/children') listing([{ ratingKey: '2002', type: 'season', title: 'Season 1', parentTitle: 'Slow Roads', index: 1 }]);
  else if (url.pathname === '/library/metadata/2002/children') listing([episode]);
  else if (url.pathname === '/library/metadata/1000') json({ Metadata: [movies[0]] });
  else if (url.pathname === '/library/metadata/3001') json({ Metadata: [episode] });
  else if (/^\/library\/parts\/(1000|3001)\/1\/file.mkv$/.test(url.pathname)) { response.setHeader('Content-Length', media.length); response.end(media); }
  else { response.writeHead(404); response.end(); }
});

async function main() {
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const serverUrl = `http://127.0.0.1:${fixture.address().port}`;
  const portServer = net.createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const packagedExecutable = process.env.OFFGRID_SMOKE_APP;
  const proc = spawn(packagedExecutable || require('electron'), [...(packagedExecutable ? [] : ['.']), `--remote-debugging-port=${port}`], {
    cwd: root, env: { ...process.env, OFFGRID_DATA_DIR: temporary, OFFGRID_TEST_MODE: '1', OFFGRID_PLEX_URL: serverUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { output += chunk; });
  console.log(`Isolated Plex UI fixture: ${temporary}`);
  let socket;
  try {
    let target;
    for (let index = 0; index < 100; index++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(tab => tab.type === 'page'); } catch {}
      if (target) break;
      if (proc.exitCode !== null || proc.signalCode) throw new Error(`Electron exited: ${output}`);
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
      for (let index = 0; index < 120; index++) { if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return; await sleep(100); }
      throw new Error(`Timed out: ${expression}\nVisible content: ${await evaluate('document.body.innerText')}`);
    };
    const click = async label => {
      const clicked = await evaluate(`(() => { const element = [...document.querySelectorAll('button')].find(button => button.getClientRects().length && (button.textContent.trim() === ${JSON.stringify(label)} || button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.matches('.nav-item') && button.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)})); if (!element) return false; element.click(); return true; })()`);
      assert.equal(clicked, true, `Visible button exists: ${label}`); await sleep(100);
    };
    const fill = async (selector, value) => evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const capture = async name => {
      const result = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from(result.data, 'base64'));
    };
    await call('Runtime.enable');
    await waitFor(`document.querySelector('nav') && !document.body.innerText.includes('Opening your library…')`);
    assert.equal((await evaluate('window.offgrid.getStorage()')).libraryPath.startsWith(temporary), true);
    await click('Servers');
    await waitFor(`document.querySelector('.plex-connect input[type="url"]')`);
    assert.equal(await evaluate(`document.querySelector('.plex-connect input[type="url"]').value`), serverUrl, 'Environment suggestion prefills server URL');
    await capture('plex-connect');
    const requestAccessLabel = process.platform === 'darwin' ? 'Request local access' : 'Check server connection';
    await click(requestAccessLabel);
    await waitFor(`document.querySelector('.plex-access-success')`);
    assert.equal(await evaluate(`document.querySelector('input[type="password"]').value`), '', 'Access check needs no token');
    assert.equal(requests.length, 0, 'Access probe sends no HTTP or authentication');
    const closedServer = net.createServer();
    closedServer.listen(0, '127.0.0.1');
    await once(closedServer, 'listening');
    const closedAddress = `http://127.0.0.1:${closedServer.address().port}`;
    await new Promise(resolve => closedServer.close(resolve));
    await fill('.plex-connect input[type="url"]', closedAddress);
    await click(requestAccessLabel);
    await waitFor(`document.querySelector('.plex-local-access')?.textContent.includes('not accepting connections')`);
    assert.equal(await evaluate(`!![...document.querySelectorAll('button')].find(button => button.textContent === 'Check again')`), true);
    if (process.platform === 'darwin') assert.equal(await evaluate(`document.querySelector('.plex-local-access').textContent.includes('Open Local Network settings')`), true);
    await capture('plex-local-access-failed');
    await fill('.plex-connect input[type="password"]', fixtureToken);
    await click('Connect server');
    await waitFor(`document.querySelector('.inline-error')?.textContent.includes('Plex refused the connection')`);
    assert.equal(await evaluate(`document.querySelector('.inline-error').textContent.includes('Error invoking remote method')`), false, 'Connection errors omit Electron IPC internals');
    await capture('plex-connection-error');
    await fill('.plex-connect input[type="url"]', serverUrl);
    await click('Connect server');
    await waitFor(`document.querySelector('.plex-connection') || document.querySelector('.inline-error')`);
    if (await evaluate(`document.body.innerText.includes('Unlock your system keychain')`)) {
      await capture('plex-keychain-unavailable');
      console.log(JSON.stringify({ ok: false, blocked: 'System keychain unavailable; security requirement preserved.', screenshots, fixtureDirectory: temporary, checks: ['Isolated app data', 'Suggested address form'] }, null, 2));
      process.exitCode = 2;
      return;
    }
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 100`);
    assert.equal(await evaluate(`document.querySelector('.plex-local-access') === null`), true, 'Reachable library hides access controls');
    assert.equal(await evaluate(`document.querySelector('input[type="password"]') === null`), true, 'Token form removed after connection');
    const configuration = await evaluate('window.offgrid.getPlexConfig()');
    assert.equal(JSON.stringify(configuration).includes(fixtureToken), false, 'Config never returns token');
    const savedConnection = fs.readFileSync(path.join(temporary, 'plex-connection.json'), 'utf8');
    assert.equal(savedConnection.includes(fixtureToken), false, 'Token encrypted on disk');
    assert.ok(JSON.parse(savedConnection).encryptedToken);
    await capture('plex-movies');
    await evaluate(`document.querySelector('.plex-pagination').scrollIntoView()`);
    await click('Next');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 1 && document.body.innerText.includes('Fixture Movie 101')`);
    await click('Previous');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 100`);
    await fill('input[aria-label="Search Plex library"]', 'Quiet');
    await click('Search');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 1 && document.body.innerText.includes('A Quiet Weekend')`);
    await evaluate(`document.querySelector('section[aria-label="Plex"]').scrollTop = 0`);
    await capture('plex-search');
    interruptMetadata = true;
    await click('Download');
    await waitFor(`document.querySelector('.plex-local-access')?.textContent.includes('Check again')`);
    interruptMetadata = false;
    await click('Check again');
    await waitFor(`document.querySelector('.plex-local-access') === null && document.querySelectorAll('.plex-media-row').length === 1`);
    await click('Download');
    await waitFor(`window.offgrid.listDownloads().then(queue => queue.jobs.some(job => job.status === 'complete' && job.provider === 'plex'))`);
    const library = await evaluate('window.offgrid.listVideos()');
    const video = library.find(item => item.title === 'A Quiet Weekend');
    assert.ok(video, 'Completed download saved to library');
    const persisted = JSON.parse(fs.readFileSync(path.join(temporary, 'library.json'))).find(item => item.id === video.id);
    assert.equal(persisted.filePath.startsWith(temporary), true);
    assert.deepEqual(fs.readFileSync(persisted.filePath), media, 'Original bytes saved without conversion');
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="Plex library"]'); select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.plex-media-row')?.textContent.includes('Slow Roads')`);
    await click('Browse seasons');
    await waitFor(`document.querySelector('.plex-media-row')?.textContent.includes('Season 1')`);
    await click('Browse episodes');
    await waitFor(`document.querySelector('.plex-media-row')?.textContent.includes('The First Journey')`);
    await capture('plex-episodes');
    await click('Download');
    await waitFor(`window.offgrid.listVideos().then(videos => videos.length === 2)`);
    await click('Back to Slow Roads');
    await waitFor(`document.querySelector('.plex-media-row')?.textContent.includes('Season 1')`);
    await click('View downloads');
    await waitFor(`document.querySelector('.download-row')?.textContent.includes('Original quality')`);
    await capture('plex-downloads');
    assert.equal(await evaluate(`document.querySelectorAll('.download-row select').length`), 0, 'Plex jobs have no quality selector');
    await click('Library');
    await click('Play A Quiet Weekend');
    await waitFor(`document.body.innerText.includes('Server downloads play in mpv.') && document.querySelector('section[aria-label="Settings"]:not([hidden])')`);
    assert.equal(await evaluate(`document.querySelector('video') === null`), true, 'Plex cannot fall back to unsupported browser playback');
    await evaluate(`document.querySelector('section[aria-label="Settings"] .settings-section:nth-child(2)').scrollIntoView()`);
    await capture('plex-player-guidance');
    await call('Emulation.setDeviceMetricsOverride', { width: 820, height: 720, deviceScaleFactor: 1, mobile: false });
    await click('Servers');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 100`);
    await capture('plex-narrow');
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('section[aria-label="Plex"]').scrollWidth <= document.querySelector('section[aria-label="Plex"]').clientWidth`), true, 'No horizontal overflow at 820px');
    await click('Disconnect');
    await waitFor(`window.offgrid.getPlexConfig().then(value => !value.configured)`);
    assert.equal(fs.existsSync(path.join(temporary, 'plex-connection.json')), false, 'Disconnect removes encrypted credential');
    assert.equal((await evaluate('window.offgrid.listVideos()')).length, 2, 'Disconnect preserves saved files');
    await click(requestAccessLabel);
    await waitFor(`document.querySelector('.plex-local-access')?.textContent.includes('Enter your server address first')`);
    await capture('plex-local-access-narrow');
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Plex"]').scrollWidth <= document.querySelector('section[aria-label="Plex"]').clientWidth`), true, 'Access controls fit at 820px');
    assert.ok(requests.every(request => request.authenticated && !request.query.includes(fixtureToken)), 'Fixture requests authenticate only in headers');
    assert.equal(exceptions.length, 0, `No renderer exceptions: ${JSON.stringify(exceptions)}`);
    console.log(JSON.stringify({ ok: true, screenshots, fixtureDirectory: temporary, checks: ['Token-free access request and failure recovery controls', 'Address edits invalidate access status', 'Suggested URL and encrypted connection', 'Actionable connection errors without IPC internals', 'Movie pagination and search', 'Shows, seasons, episodes, back navigation', 'Original download bytes and queue UI', 'Missing mpv guidance', 'No overflow at 820px including access controls', 'Disconnect clears credential and retains library', 'No token in IPC config or request URLs', 'No renderer exceptions'] }, null, 2));
  } finally {
    if (socket) socket.close();
    proc.kill('SIGTERM');
    fixture.closeAllConnections();
    fixture.close();
  }
}
main().catch(error => { console.error(error); fixture.closeAllConnections(); fixture.close(); process.exitCode = 1; });
