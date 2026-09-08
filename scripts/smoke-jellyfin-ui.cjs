// Disposable Jellyfin server and app data; never reads a user's server credentials or library.
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-jellyfin-ui-'));
const screenshots = path.join(temporary, 'screenshots');
fs.mkdirSync(screenshots);
const fixtureToken = 'offgrid-disposable-jellyfin-fixture-token';
const fixtureUsername = 'offgrid-fixture-user';
const fixturePassword = 'fixture-password-only';
const media = Buffer.alloc(64 * 1024, 9);
const id = value => value.toString(16).padStart(32, '0');
const userId = id(99), movieSection = id(1), showSection = id(2), showId = id(2001), seasonId = id(2002);
const requests = [], violations = [];
let sessionDeviceId;
const authHeader = deviceId => `MediaBrowser Client="Offgrid", Device="Offgrid", DeviceId="${deviceId}", Version="1.0"`;
const movie = (value, title) => ({ Id: id(value), Type: 'Movie', Name: title, ProductionYear: 2025, RunTimeTicks: 42000000000, CanDownload: true, Path: `/media/${value}.mkv`, MediaSources: [{ Protocol: 'File', Path: `/media/${value}.mkv`, Container: 'mkv', Size: media.length }] });
const movies = Array.from({ length: 101 }, (_, index) => movie(1000 + index, index === 0 ? 'A Quiet Weekend' : `Fixture Movie ${String(index + 1).padStart(3, '0')}`));
const episode = { ...movie(3001, 'The First Journey'), Type: 'Episode', SeriesName: 'Slow Roads', ParentIndexNumber: 1, IndexNumber: 1 };
const fixture = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const login = url.pathname === '/jellyfin/Users/AuthenticateByName';
  requests.push({ pathname: url.pathname, query: url.search, login, authenticated: request.headers.authorization === `${authHeader(sessionDeviceId)}, Token="${fixtureToken}"` });
  const reject = detail => { violations.push(detail); response.writeHead(400); response.end(); };
  const json = data => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); };
  if (login) {
    const deviceId = request.headers.authorization?.match(/^MediaBrowser Client="Offgrid", Device="Offgrid", DeviceId="([a-f0-9-]{36})", Version="1.0"$/)?.[1];
    if (request.method !== 'POST' || !deviceId) return reject('Unexpected login method or auth header');
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let credentials;
      try { credentials = JSON.parse(body); } catch { return reject('Invalid login JSON'); }
      if (Object.keys(credentials).sort().join(',') !== 'Pw,Username') return reject('Unexpected login fields');
      if (credentials.Username !== fixtureUsername || credentials.Pw !== fixturePassword) { response.writeHead(401); response.end(); return; }
      sessionDeviceId = deviceId;
      json({ AccessToken: fixtureToken, User: { Id: userId }, ServerId: 'fixture-jellyfin-server' });
    });
    return;
  }
  if (request.method !== 'GET' || request.headers.authorization !== `${authHeader(sessionDeviceId)}, Token="${fixtureToken}"`) return reject('Unexpected authenticated method or auth header');
  if (url.pathname === '/jellyfin/System/Info/Public') return json({ Id: 'fixture-jellyfin-server', ServerName: 'Home Cinema' });
  if (url.pathname === `/jellyfin/Users/${userId}/Views`) return json({ Items: [{ Id: movieSection, Name: 'Movies', CollectionType: 'movies' }, { Id: showSection, Name: 'TV Shows', CollectionType: 'tvshows' }] });
  if (url.pathname === `/jellyfin/Users/${userId}/Items`) {
    const parent = url.searchParams.get('ParentId');
    let items = parent === movieSection ? movies : parent === showSection ? [{ Id: showId, Type: 'Series', Name: 'Slow Roads' }] : parent === showId ? [{ Id: seasonId, Type: 'Season', Name: 'Season 1', SeriesName: 'Slow Roads' }] : parent === seasonId ? [episode] : null;
    if (!items) return reject('Unknown ParentId');
    if (url.searchParams.get('Limit') !== '100' || url.searchParams.get('Fields') !== 'MediaSources,Path,CanDownload') return reject('Missing required browse fields');
    const query = url.searchParams.get('SearchTerm');
    if (query) {
      if (url.searchParams.get('Recursive') !== 'true' || url.searchParams.get('IncludeItemTypes') !== 'Movie,Series,Episode') return reject('Invalid recursive search');
      items = items.filter(item => item.Name.toLowerCase().includes(query.toLowerCase()));
    }
    const start = Number(url.searchParams.get('StartIndex'));
    if (![0, 100].includes(start)) return reject('Unexpected page start');
    return json({ Items: items.slice(start, start + 100), TotalRecordCount: items.length });
  }
  if (url.pathname === `/jellyfin/Users/${userId}/Items/${movies[0].Id}`) return json(movies[0]);
  if (url.pathname === `/jellyfin/Users/${userId}/Items/${episode.Id}`) return json(episode);
  if ([movies[0].Id, episode.Id].some(itemId => url.pathname === `/jellyfin/Items/${itemId}/Download`)) { response.setHeader('Content-Length', media.length); response.end(media); return; }
  reject(`Unknown fixture route: ${url.pathname}`);
});

async function main() {
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const serverUrl = `http://127.0.0.1:${fixture.address().port}/jellyfin`;
  const portServer = net.createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const packagedExecutable = process.env.OFFGRID_SMOKE_APP;
  const proc = spawn(packagedExecutable || require('electron'), [...(packagedExecutable ? [] : ['.']), `--remote-debugging-port=${port}`], {
    cwd: root, env: { ...process.env, OFFGRID_DATA_DIR: temporary, OFFGRID_TEST_MODE: '1', OFFGRID_PLEX_URL: '', OFFGRID_JELLYFIN_URL: serverUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { output += chunk; });
  console.log(`Isolated Jellyfin UI fixture: ${temporary}`);
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
    await click('Jellyfin');
    await waitFor(`document.querySelector('.plex-connect input[type="url"]')`);
    assert.equal(await evaluate(`document.querySelector('.plex-connect input[type="url"]').value`), serverUrl, 'Environment suggestion prefills server URL');
    await capture('jellyfin-connect');
    const requestAccessLabel = process.platform === 'darwin' ? 'Request local access' : 'Check server connection';
    await click(requestAccessLabel);
    await waitFor(`document.querySelector('.plex-access-success')`);
    assert.equal(await evaluate(`document.querySelector('input[type="password"]').value`), '', 'Access check needs no token');
    assert.equal(requests.length, 0, 'Access probe sends no HTTP or authentication');
    await fill('.plex-connect input[type="text"]', fixtureUsername);
    await fill('.plex-connect input[type="password"]', 'do-not-retain-this-password');
    await click('Plex');
    await waitFor(`document.querySelector('section[aria-label="Plex"] .plex-connect')`);
    assert.equal(await evaluate(`document.querySelector('input[type="password"]').value`), '', 'Jellyfin password never enters Plex form');
    assert.equal((await evaluate('window.offgrid.getPlexConfig()')).configured, false);
    await click('Jellyfin');
    await waitFor(`document.querySelector('section[aria-label="Jellyfin"] .plex-connect')`);
    assert.equal(await evaluate(`document.querySelector('input[type="password"]').value`), '', 'Provider navigation clears password');
    await fill('.plex-connect input[type="text"]', fixtureUsername);
    await fill('.plex-connect input[type="password"]', 'wrong-password');
    await click('Connect server');
    await waitFor(`document.querySelector('.inline-error')?.textContent.includes('authentication failed') || document.body.innerText.includes('Unlock your system keychain')`);
    if (await evaluate(`document.body.innerText.includes('Unlock your system keychain')`)) throw new Error('System keychain unavailable; encryption requirement preserved.');
    assert.equal(await evaluate(`document.querySelector('.inline-error').textContent.includes('Error invoking remote method')`), false);
    await capture('jellyfin-login-error');
    await fill('.plex-connect input[type="password"]', fixturePassword);
    await click('Connect server');
    await waitFor(`document.querySelector('.plex-connection') || document.querySelector('.inline-error')`);
    if (await evaluate(`document.body.innerText.includes('Unlock your system keychain')`)) {
      await capture('jellyfin-keychain-unavailable');
      console.log(JSON.stringify({ ok: false, blocked: 'System keychain unavailable; security requirement preserved.', screenshots, fixtureDirectory: temporary, checks: ['Isolated app data', 'Suggested address form'] }, null, 2));
      process.exitCode = 2;
      return;
    }
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 100`);
    assert.equal(await evaluate(`document.querySelector('.plex-local-access') === null`), true, 'Reachable library hides access controls');
    assert.equal(await evaluate(`document.querySelector('input[type="password"]') === null`), true, 'Token form removed after connection');
    const configuration = await evaluate('window.offgrid.getJellyfinConfig()');
    assert.equal(JSON.stringify(configuration).includes(fixtureToken), false, 'Config never returns token');
    const savedConnection = fs.readFileSync(path.join(temporary, 'jellyfin-connection.json'), 'utf8');
    assert.equal(savedConnection.includes(fixtureToken), false, 'Token encrypted on disk');
    assert.ok(JSON.parse(savedConnection).encryptedToken);
    assert.equal(savedConnection.includes(fixturePassword), false, 'Password never saved');
    await capture('jellyfin-movies');
    await evaluate(`document.querySelector('.plex-pagination').scrollIntoView()`);
    await click('Next');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 1 && document.body.innerText.includes('Fixture Movie 101')`);
    await click('Previous');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 100`);
    await fill('input[aria-label="Search Jellyfin library"]', 'Quiet');
    await click('Search');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 1 && document.body.innerText.includes('A Quiet Weekend')`);
    await evaluate(`document.querySelector('section[aria-label="Jellyfin"]').scrollTop = 0`);
    await capture('jellyfin-search');
    await click('Download');
    await waitFor(`window.offgrid.listDownloads().then(queue => queue.jobs.some(job => job.status === 'complete' && job.provider === 'jellyfin'))`);
    const library = await evaluate('window.offgrid.listVideos()');
    const video = library.find(item => item.title === 'A Quiet Weekend');
    assert.ok(video, 'Completed download saved to library');
    const persisted = JSON.parse(fs.readFileSync(path.join(temporary, 'library.json'))).find(item => item.id === video.id);
    assert.equal(persisted.filePath.startsWith(temporary), true);
    assert.deepEqual(fs.readFileSync(persisted.filePath), media, 'Original bytes saved without conversion');
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="Jellyfin library"]'); select.value = ${JSON.stringify(showSection)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.plex-media-row')?.textContent.includes('Slow Roads')`);
    await click('Browse seasons');
    await waitFor(`document.querySelector('.plex-media-row')?.textContent.includes('Season 1')`);
    await click('Browse episodes');
    await waitFor(`document.querySelector('.plex-media-row')?.textContent.includes('The First Journey')`);
    await capture('jellyfin-episodes');
    await click('Download');
    await waitFor(`window.offgrid.listVideos().then(videos => videos.length === 2)`);
    await click('Back to Slow Roads');
    await waitFor(`document.querySelector('.plex-media-row')?.textContent.includes('Season 1')`);
    await click('View downloads');
    await waitFor(`document.querySelector('.download-row')?.textContent.includes('Original quality')`);
    await capture('jellyfin-downloads');
    assert.equal(await evaluate(`document.querySelectorAll('.download-row select').length`), 0, 'Jellyfin jobs have no quality selector');
    await click('Library');
    await click('Play A Quiet Weekend');
    await waitFor(`document.body.innerText.includes('Server downloads play in mpv.') && document.querySelector('section[aria-label="Settings"]:not([hidden])')`);
    assert.equal(await evaluate(`document.querySelector('video') === null`), true, 'Jellyfin cannot fall back to unsupported browser playback');
    await evaluate(`document.querySelector('section[aria-label="Settings"] .settings-section:nth-child(2)').scrollIntoView()`);
    await capture('jellyfin-player-guidance');
    await click('Servers');
    await waitFor(`document.querySelector('section[aria-label="Jellyfin"] .plex-media-row')`);
    await click('Plex');
    await waitFor(`document.querySelector('section[aria-label="Plex"] .plex-connect')`);
    assert.equal(await evaluate(`document.querySelectorAll('.plex-media-row').length`), 0, 'Plex receives no Jellyfin browse results');
    assert.equal(await evaluate(`document.querySelector('input[type="password"]').value`), '', 'Plex token stays blank');
    assert.equal((await evaluate('window.offgrid.getPlexConfig()')).configured, false);
    await click('Jellyfin');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 100`);
    await click('Change connection');
    await waitFor(`document.querySelector('.plex-connect input[type="password"]')`);
    assert.equal(await evaluate(`document.querySelector('input[type="password"]').value`), '', 'Reopened connection never retains login password');
    await click('Cancel');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 100`);
    await call('Emulation.setDeviceMetricsOverride', { width: 820, height: 720, deviceScaleFactor: 1, mobile: false });
    await click('Servers');
    await waitFor(`document.querySelectorAll('.plex-media-row').length === 100`);
    await capture('jellyfin-narrow');
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('section[aria-label="Jellyfin"]').scrollWidth <= document.querySelector('section[aria-label="Jellyfin"]').clientWidth`), true, 'No horizontal overflow at 820px');
    await click('Disconnect');
    await waitFor(`window.offgrid.getJellyfinConfig().then(value => !value.configured)`);
    assert.equal(fs.existsSync(path.join(temporary, 'jellyfin-connection.json')), false, 'Disconnect removes encrypted credential');
    assert.equal((await evaluate('window.offgrid.listVideos()')).length, 2, 'Disconnect preserves saved files');
    await click(requestAccessLabel);
    await waitFor(`document.querySelector('.plex-local-access')?.textContent.includes('Enter your server address first')`);
    await capture('jellyfin-local-access-narrow');
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Jellyfin"]').scrollWidth <= document.querySelector('section[aria-label="Jellyfin"]').clientWidth`), true, 'Access controls fit at 820px');
    assert.ok(requests.every(request => (request.login || request.authenticated) && !request.query.includes(fixtureToken) && !request.query.includes(fixturePassword)), 'Fixture requests authenticate only in headers');
    assert.deepEqual(violations, [], 'Strict Jellyfin fixture routes and headers');
    assert.equal(exceptions.length, 0, `No renderer exceptions: ${JSON.stringify(exceptions)}`);
    console.log(JSON.stringify({ ok: true, screenshots, fixtureDirectory: temporary, checks: ['Token-free access request', 'Provider isolation and password clearing', 'Base path URL, password authentication and encrypted session', 'Actionable connection errors without IPC internals', 'Movie pagination and search', 'Shows, seasons, episodes, back navigation', 'Original download bytes and queue UI', 'Missing mpv guidance', 'No overflow at 820px including access controls', 'Disconnect clears credential and retains library', 'No token in IPC config or request URLs', 'No renderer exceptions'] }, null, 2));
  } finally {
    if (socket) socket.close();
    proc.kill('SIGTERM');
    fixture.closeAllConnections();
    fixture.close();
  }
}
main().catch(error => { console.error(error); fixture.closeAllConnections(); fixture.close(); process.exitCode = 1; });
