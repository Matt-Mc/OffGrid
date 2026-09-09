const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;
const { JellyfinClient, normalizeServerUrl, validateId, networkError } = require('../electron/jellyfin-client.cjs');
const { JellyfinConnection } = require('../electron/jellyfin-connection.cjs');
const TOKEN = 'fixture-private-token', PASSWORD = 'fixture-private-password';
const USER = 'c'.repeat(32), MOVIE = 'a'.repeat(32), SECTION = 'b'.repeat(32);
const movie = { Id: MOVIE, Type: 'Movie', Name: 'Test film', ProductionYear: 2025, RunTimeTicks: 123450000,
  CanDownload: true, Path: '/media/film.mkv', VideoType: 'VideoFile', MediaSources: [{ Protocol: 'File', Path: '/media/film.mkv', Container: 'mkv', Size: 8 }] };
function json(res, value) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
async function fixture(t, handler, prefix = '') {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}${prefix}`;
  return { client: new JellyfinClient({ baseUrl, token: TOKEN, userId: USER }), baseUrl, requests };
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-jellyfin-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Jellyfin URLs and IDs restrict destinations and allow a safe reverse proxy base path', () => {
  assert.equal(normalizeServerUrl('http://192.168.1.2:8096/jellyfin/'), 'http://192.168.1.2:8096/jellyfin');
  assert.equal(normalizeServerUrl('https://jellyfin.local/'), 'https://jellyfin.local');
  for (const bad of ['http://8.8.8.8', 'http://user:password@localhost', 'http://localhost:0', 'http://localhost/path/..', 'http://localhost/%2e', 'http://localhost//api', 'http://localhost?api_key=secret', 'http://localhost/#x', 'http://localhost\\evil', 'file:///tmp/media']) assert.throws(() => normalizeServerUrl(bad));
  assert.equal(validateId('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'), MOVIE);
  for (const bad of ['1', '../item', `${MOVIE}?token=x`]) assert.throws(() => validateId(bad));
  assert.throws(() => new JellyfinClient({ baseUrl: 'http://localhost', token: 'token"\r\nheader', userId: USER }), /invalid access token/);
});

test('Jellyfin login sends only a bounded JSON password and tokens remain in headers', async t => {
  let body;
  const { baseUrl, requests } = await fixture(t, async (req, res) => {
    if (req.url.endsWith('/AuthenticateByName')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks));
      return json(res, { AccessToken: TOKEN, User: { Id: USER } });
    }
    json(res, { Id: 'server-123', ServerName: 'Living room' });
  }, '/jellyfin');
  const login = new JellyfinClient({ baseUrl });
  const credentials = await login.authenticate({ username: ' matt ', password: PASSWORD });
  assert.deepEqual(credentials, { token: TOKEN, userId: USER });
  assert.deepEqual(body, { Username: 'matt', Pw: PASSWORD });
  assert.equal(requests[0].url, '/jellyfin/Users/AuthenticateByName');
  assert.equal(requests[0].method, 'POST');
  assert.match(requests[0].headers.authorization, /^MediaBrowser Client="Offgrid"/);
  assert.ok(!requests[0].headers.authorization.includes('Token='));
  const client = new JellyfinClient({ baseUrl, ...credentials });
  assert.deepEqual(await client.identity(), { serverId: 'server-123', name: 'Living room' });
  assert.equal(requests[1].url, '/jellyfin/System/Info/Public');
  assert.match(requests[1].headers.authorization, /Token="fixture-private-token"/);
  assert.ok(!JSON.stringify(client).includes(TOKEN));
  for (const req of requests) assert.ok(!req.url.includes(TOKEN) && !req.url.includes(PASSWORD));
  await assert.rejects(login.authenticate({ username: 'matt', password: 'x'.repeat(4097) }), /username and password/);
  await assert.rejects(login.sections(), /Connect/);
});

test('Jellyfin connection saves encrypted token and user identity only, preserves old login on failure', async t => {
  let rejected = false, mismatch = false;
  const { baseUrl, requests } = await fixture(t, (req, res) => {
    if (rejected) { res.writeHead(401); return res.end(PASSWORD); }
    json(res, req.url.endsWith('AuthenticateByName') ? { AccessToken: TOKEN, User: { Id: USER }, ServerId: mismatch ? 'changed' : 'server-123' } : { Id: 'server-123', ServerName: 'Study' });
  });
  let unlocked = true;
  const safeStorage = { isEncryptionAvailable: () => unlocked, encryptString: text => Buffer.from([...text].reverse().join('')), decryptString: bytes => [...bytes.toString()].reverse().join('') };
  const dir = directory(t);
  const connection = new JellyfinConnection(dir, safeStorage);
  const status = await connection.connect({ baseUrl, username: 'matt', password: PASSWORD });
  assert.equal(status.userId, USER); assert.equal(status.serverName, 'Study'); assert.equal(status.configured, true);
  const saved = fs.readFileSync(path.join(dir, 'jellyfin-connection.json'), 'utf8');
  assert.ok(!saved.includes(TOKEN) && !saved.includes(PASSWORD) && !saved.includes('username'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'jellyfin-connection.json')).mode & 0o777, 0o600);
  assert.equal((await connection.client().identity()).serverId, 'server-123');
  const savedDevice = JSON.parse(saved).deviceId;
  assert.match(savedDevice, /^[a-f0-9-]{36}$/);
  assert.ok(requests[0].headers.authorization.includes(savedDevice));
  mismatch = true;
  await assert.rejects(connection.connect({ baseUrl, username: 'matt', password: '' }), /identity changed/);
  assert.equal(fs.readFileSync(path.join(dir, 'jellyfin-connection.json'), 'utf8'), saved);
  assert.ok(requests.at(-1).headers.authorization.includes(savedDevice));
  rejected = true;
  await assert.rejects(connection.connect({ baseUrl, username: 'matt', password: PASSWORD }), /authentication failed/);
  assert.equal(fs.readFileSync(path.join(dir, 'jellyfin-connection.json'), 'utf8'), saved);
  unlocked = false; assert.throws(() => connection.client(), /could not be unlocked/);
  await assert.rejects(connection.connect({ baseUrl, username: 'matt', password: PASSWORD }), /keychain/);
  assert.equal(connection.disconnect().configured, false);
});

test('Jellyfin libraries, pagination, search, series and episode data are normalized without server paths', async t => {
  const { client, requests } = await fixture(t, (req, res) => {
    if (req.url.endsWith('/Views')) return json(res, { Items: [{ Id: SECTION, Name: 'Films', CollectionType: 'movies' }, { Id: MOVIE, Name: 'Music', CollectionType: 'music' }] });
    json(res, { Items: [movie, { Id: SECTION, Type: 'Series', Name: 'A show' }], TotalRecordCount: 250 });
  });
  assert.deepEqual(await client.sections(), [{ id: SECTION, title: 'Films', type: 'movie' }]);
  const result = await client.browse({ sectionId: SECTION, start: 100, query: 'test & film' });
  assert.equal(result.total, 250); assert.equal(result.items[0].duration, 12); assert.equal(result.items[0].downloadable, true);
  assert.equal(result.items[1].type, 'show'); assert.equal(result.items[1].downloadable, false);
  assert.ok(!JSON.stringify(result).includes('/media/'));
  const params = new URL(requests[1].url, 'http://localhost').searchParams;
  assert.equal(params.get('StartIndex'), '100'); assert.equal(params.get('Limit'), '100'); assert.equal(params.get('SearchTerm'), 'test & film');
  assert.equal(params.get('Recursive'), 'true');
  await client.browse({ parentId: SECTION });
  assert.equal(new URL(requests[2].url, 'http://localhost').searchParams.get('ParentId'), SECTION);
  await assert.rejects(client.browse({ sectionId: SECTION, start: -1 }), /Invalid Jellyfin browsing/);
});

test('Jellyfin original metadata enforces download permission, one source, matching file and supported container', async t => {
  let row = structuredClone(movie);
  const { client } = await fixture(t, (_req, res) => json(res, row));
  const result = await client.metadata(MOVIE);
  assert.equal(result.downloadId, MOVIE); assert.equal(result.extension, 'mkv'); assert.equal(result.sizeBytes, 8);
  assert.ok(!JSON.stringify(result).includes('/media/'));
  row.MediaSources[0].HasSegments = true; assert.equal((await client.metadata(MOVIE)).downloadable, true);
  row.CanDownload = false; await assert.rejects(client.metadata(MOVIE), /account cannot download/);
  row = structuredClone(movie); row.MediaSources.push(row.MediaSources[0]); await assert.rejects(client.metadata(MOVIE), /Multiple-version/);
  row = structuredClone(movie); row.PartCount = 2; await assert.rejects(client.metadata(MOVIE), /multi-part/);
  for (const change of [r => r.MediaSources[0].Protocol = 'Http', r => r.MediaSources[0].Path = '/different/version.mkv', r => r.MediaSources[0].Size = 0, r => r.MediaSources[0].Container = 'exe', r => r.MediaSources[0].IsInfiniteStream = true, r => r.VideoType = 'Iso']) {
    row = structuredClone(movie); change(row); await assert.rejects(client.metadata(MOVIE), /unavailable or uses an unsupported/);
  }
});

test('Jellyfin rejects redirects, server error bodies and malformed or oversized JSON without leaking secrets', async t => {
  let mode = 'redirect';
  const { client, requests } = await fixture(t, (_req, res) => {
    if (mode === 'redirect') res.writeHead(302, { Location: `http://public.invalid/${TOKEN}` });
    if (mode === 'denied') res.writeHead(403);
    if (mode === 'large') res.writeHead(200, { 'Content-Length': 5 * 1024 * 1024 });
    res.end(PASSWORD);
  });
  for (const [next, pattern] of [['redirect', /redirects/], ['denied', /access was denied/], ['large', /too large/], ['invalid', /invalid library data/]]) {
    mode = next; await assert.rejects(client.identity(), error => pattern.test(error.message) && !error.message.includes(PASSWORD));
  }
  assert.equal(requests.length, 4);
});

test('Jellyfin rejects public or mixed DNS before credentials and pins the accepted lookup', async t => {
  const original = dns.lookup; t.after(() => { dns.lookup = original; });
  const { baseUrl, requests } = await fixture(t, (_req, res) => json(res, { Id: 'server', ServerName: 'Room' }));
  const client = new JellyfinClient({ baseUrl: baseUrl.replace('127.0.0.1', 'rebind.invalid'), token: TOKEN, userId: USER });
  for (const answers of [[{ address: '8.8.8.8', family: 4 }], [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }]]) {
    dns.lookup = async () => answers; await assert.rejects(client.identity(), /local network/);
  }
  assert.equal(requests.length, 0);
  let calls = 0; dns.lookup = async () => { calls++; return [{ address: '127.0.0.1', family: 4 }]; };
  assert.equal((await client.identity()).serverId, 'server'); assert.equal(calls, 1); assert.equal(requests.length, 1);
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EPERM', 'CERT_HAS_EXPIRED', PASSWORD]) {
    assert.ok(!networkError({ code, message: PASSWORD, cause: TOKEN }).message.includes(PASSWORD));
  }
});

test('Jellyfin streams exact original bytes with progress and does not overwrite existing files', async t => {
  const dest = path.join(directory(t), 'film.mkv');
  const { client, requests } = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': 8 }); res.end('contents'); });
  const updates = [];
  const metadata = { downloadId: MOVIE, sizeBytes: 8 };
  assert.deepEqual(await client.download(metadata, dest, { onProgress: update => updates.push(update) }), { sizeBytes: 8 });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'contents');
  assert.deepEqual(updates.at(-1), { downloadedBytes: 8, totalBytes: 8, progress: 100 });
  assert.equal(requests[0].url, `/Items/${MOVIE}/Download`);
  assert.match(requests[0].headers.authorization, /Token="fixture-private-token"/);
  await assert.rejects(client.download(metadata, dest), /already exists/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'contents'); assert.equal(requests.length, 1);
});

test('Jellyfin incomplete, excess, interrupted and cancelled streams remove partial files', async t => {
  const dest = path.join(directory(t), 'film.mkv');
  let mode = 'length';
  const { client } = await fixture(t, (_req, res) => {
    if (mode === 'length') { res.writeHead(200, { 'Content-Length': 3 }); return res.end('bad'); }
    res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
    if (mode === 'short') return res.end('bad');
    if (mode === 'excess') return res.end('too-much-data');
    res.write('part');
    if (mode === 'interrupted') setImmediate(() => res.destroy());
  });
  const metadata = { downloadId: MOVIE, sizeBytes: 8 };
  for (const next of ['length', 'short', 'excess', 'interrupted']) { mode = next; await assert.rejects(client.download(metadata, dest)); assert.equal(fs.existsSync(dest), false); }
  mode = 'cancelled'; const controller = new AbortController();
  await assert.rejects(client.download(metadata, dest, { signal: controller.signal, onProgress: () => controller.abort() }), error => error.code === 'ABORT_ERR');
  assert.equal(fs.existsSync(dest), false);
});

test('Jellyfin cancellation interrupts metadata and DNS before late results or files', async t => {
  const controller = new AbortController();
  const { client } = await fixture(t, (_req, res) => { res.writeHead(200); res.write('{'); setImmediate(() => controller.abort()); });
  await assert.rejects(client.metadata(MOVIE, { signal: controller.signal }), error => error.code === 'ABORT_ERR');
  const original = dns.lookup; t.after(() => { dns.lookup = original; });
  dns.lookup = () => new Promise(() => {});
  const lookupController = new AbortController();
  const waiting = new JellyfinClient({ baseUrl: 'http://wait.invalid', token: TOKEN, userId: USER }).identity({ signal: lookupController.signal });
  lookupController.abort();
  await assert.rejects(waiting, error => error.code === 'ABORT_ERR');
});
