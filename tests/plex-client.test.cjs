const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;
const { PlexClient, PlexError, normalizeServerUrl, isLocalAddress, validatePartKey, networkError } = require('../electron/plex-client.cjs');

const TOKEN = 'fixture-private-token';
const movie = { ratingKey: '42', type: 'movie', title: 'Test film', year: 2025, duration: 12_345,
  Media: [{ container: 'mkv', Part: [{ key: '/library/parts/123/456/file.mkv', size: 8 }] }] };
function json(response, data) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ MediaContainer: data })); }
async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => { requests.push(request); handler(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { client: new PlexClient({ baseUrl, token: TOKEN }), baseUrl, requests };
}
function destination(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-plex-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'film.mkv');
}

test('server URL accepts private LAN and loopback only, with no embedded paths or credentials', () => {
  assert.equal(normalizeServerUrl('http://192.168.1.10:32400/'), 'http://192.168.1.10:32400');
  assert.equal(normalizeServerUrl('https://plex.local:32400'), 'https://plex.local:32400');
  for (const address of ['127.0.0.1', '10.0.0.4', '172.16.1.5', '172.31.255.1', '192.168.0.5', '::1', 'fd00::12', '::ffff:192.168.1.1']) assert.equal(isLocalAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) assert.equal(isLocalAddress(address), false, address);
  for (const url of ['http://8.8.8.8:32400', 'http://user:pass@localhost:32400', 'http://localhost:32400/?token=x', 'http://localhost/#x', 'http://localhost/path', 'http://localhost/path/..', 'http://localhost\\evil', 'file:///tmp/server', 'http://[::]:32400', 'http://[::ffff:8.8.8.8]:32400']) assert.throws(() => normalizeServerUrl(url));
  assert.throws(() => new PlexClient({ baseUrl: 'http://localhost', token: 'bad\r\nheader' }), /valid Plex token/);
});

test('network diagnostics classify safe codes without exposing native messages or credentials', () => {
  const cases = [
    ['EHOSTUNREACH', /Local Network, enable Offgrid/], ['ENETUNREACH', /Local Network, enable Offgrid/],
    ['EACCES', /Local Network, enable Offgrid/], ['EPERM', /Local Network, enable Offgrid/],
    ['ECONNREFUSED', /running.*address and port.*32400/], ['ENOTFOUND', /hostname.*local IP address/],
    ['EAI_AGAIN', /hostname.*local IP address/], ['ETIMEDOUT', /timed out/],
    ['ECONNRESET', /interrupted/], ['ERR_STREAM_PREMATURE_CLOSE', /interrupted/],
    ['CERT_HAS_EXPIRED', /server certificate; certificate verification must succeed/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /server certificate; certificate verification must succeed/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /server certificate; certificate verification must succeed/],
    ['EPROTO', /secure connection/]
  ];
  for (const [code, expected] of cases) {
    const result = networkError(Object.assign(new Error(`http://server/?X-Plex-Token=${TOKEN}`), { code, body: TOKEN }), { platform: 'darwin' });
    assert.match(result.message, expected);
    assert.equal(result.code, code);
    assert.ok(!`${result.stack}${JSON.stringify(result)}`.includes(TOKEN));
    assert.equal(result.cause, undefined);
  }
  assert.doesNotMatch(networkError({ code: 'EHOSTUNREACH' }, { platform: 'linux' }).message, /macOS|Offgrid/);
  for (const code of [TOKEN, `EHOSTUNREACH ${TOKEN}`, 'toString', '__proto__', null, { toString: () => TOKEN }]) {
    const result = networkError({ code, message: TOKEN, body: TOKEN });
    assert.equal(result.code, 'PLEX_ERROR');
    assert.equal(result.message, 'Could not connect to the local Plex server. Check the server address and network connection.');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
  const aborted = new PlexError('Plex download cancelled.', 'ABORT_ERR');
  assert.equal(networkError(aborted), aborted);
});

test('an actual refused socket produces server and port guidance', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const client = new PlexClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN });
  await assert.rejects(client.identity(), error => error.code === 'ECONNREFUSED' && /server address and port/.test(error.message) && !error.message.includes(TOKEN));
});

test('tokens use headers and API data is normalized without paths or credentials', async t => {
  const { client, requests } = await fixture(t, (req, res) => {
    if (req.url === '/') return json(res, { machineIdentifier: 'server-123', friendlyName: 'Living room' });
    if (req.url === '/library/sections') return json(res, { Directory: [{ key: '1', title: 'Films', type: 'movie' }, { key: '2', title: 'Music', type: 'artist' }] });
    json(res, { Metadata: [movie] });
  });
  assert.deepEqual(await client.identity(), { serverId: 'server-123', name: 'Living room' });
  assert.deepEqual(await client.sections(), [{ id: '1', title: 'Films', type: 'movie' }]);
  const data = await client.metadata('42');
  assert.equal(data.duration, 12);
  assert.equal(data.extension, 'mkv');
  assert.equal(data.sizeBytes, 8);
  assert.equal(data.partKey, '/library/parts/123/456/file.mkv');
  for (const req of requests) { assert.equal(req.headers['x-plex-token'], TOKEN); assert.equal(req.headers.accept, 'application/json'); assert.ok(!req.url.includes(TOKEN)); }
  assert.ok(!JSON.stringify(client).includes(TOKEN));
});

test('browse uses bounded pagination, supports children and encodes title searches', async t => {
  const { client, requests } = await fixture(t, (_req, res) => json(res, { totalSize: 250, Metadata: [movie, { ratingKey: '43', type: 'show', title: 'A show', leafCount: 20 }] }));
  const result = await client.browse({ sectionId: '1', start: 100, query: 'test & film' });
  assert.equal(result.total, 250); assert.equal(result.start, 100); assert.equal(result.items.length, 2);
  assert.equal(result.items[0].downloadable, true); assert.equal(result.items[1].downloadable, false);
  assert.equal(requests[0].url, '/library/sections/1/all?title=test%20%26%20film');
  assert.equal(requests[0].headers['x-plex-container-start'], '100');
  assert.equal(requests[0].headers['x-plex-container-size'], '100');
  await client.browse({ parentId: '43' });
  assert.equal(requests[1].url, '/library/metadata/43/children');
  await assert.rejects(client.browse({ sectionId: '../1' }), /Invalid Plex library item/);
  await assert.rejects(client.browse({ sectionId: '1', start: -1 }), /Invalid Plex browsing/);
});

test('metadata chooses first media version and rejects multipart originals and unsafe paths', async t => {
  let row = structuredClone(movie);
  row.Media.push({ container: 'mp4', Part: [{ key: '/library/parts/999/456/file.mp4', size: 4 }] });
  const { client } = await fixture(t, (_req, res) => json(res, { Metadata: [row] }));
  assert.equal((await client.metadata('42')).extension, 'mkv');
  row.Media[0].Part.push({ key: '/library/parts/124/456/file.mkv', size: 4 });
  await assert.rejects(client.metadata('42'), /Multi-part/);
  row = structuredClone(movie); row.Media[0].Part[0].key = 'http://public.example/file';
  await assert.rejects(client.metadata('42'), /unsupported media file path/);
  for (const key of ['/library/parts/1/2/..', '/library/parts/1/2/%2e%2e', '/library/parts/1/2/a%2fb.mkv', '/library/parts/1/2/%252f.mkv', '/library/parts/1/2/file.mkv?X-Plex-Token=x', '//evil/file', '/library/parts/1/2/../file.mkv']) assert.throws(() => validatePartKey(key));
});

test('redirects and authentication errors are fixed safe messages and never follow redirects', async t => {
  let status = 302;
  const { client, requests } = await fixture(t, (_req, res) => { res.writeHead(status, { Location: `http://public.example/${TOKEN}` }); res.end(TOKEN); });
  await assert.rejects(client.identity(), error => /redirects/.test(error.message) && !error.message.includes(TOKEN));
  assert.equal(requests.length, 1);
  status = 401;
  await assert.rejects(client.sections(), error => /authentication failed/.test(error.message) && !error.message.includes(TOKEN));
});

test('DNS is checked before sending a token and its accepted result is pinned to the socket', async t => {
  const originalLookup = dns.lookup;
  t.after(() => { dns.lookup = originalLookup; });
  const { baseUrl, requests } = await fixture(t, (_req, res) => json(res, { machineIdentifier: 'server', friendlyName: 'Test' }));
  const client = new PlexClient({ baseUrl: baseUrl.replace('127.0.0.1', 'rebind.invalid'), token: TOKEN });
  dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  await assert.rejects(client.identity(), /local network/);
  assert.equal(requests.length, 0);
  dns.lookup = async () => { throw Object.assign(new Error(TOKEN), { code: 'ENOTFOUND' }); };
  await assert.rejects(client.identity(), error => error.code === 'ENOTFOUND' && /hostname/.test(error.message) && !error.message.includes(TOKEN));
  assert.equal(requests.length, 0);
  dns.lookup = async () => [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }];
  await assert.rejects(client.identity(), /local network/);
  let lookups = 0;
  dns.lookup = async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; };
  assert.equal((await client.identity()).serverId, 'server');
  assert.equal(lookups, 1); assert.equal(requests.length, 1);
});

test('metadata response size is bounded and malformed responses do not expose body content', async t => {
  let oversized = true;
  const { client } = await fixture(t, (_req, res) => {
    if (oversized) { res.writeHead(200, { 'Content-Length': 5 * 1024 * 1024 }); res.end('{}'); }
    else res.end(`not-json-${TOKEN}`);
  });
  await assert.rejects(client.sections(), /too large/);
  oversized = false;
  await assert.rejects(client.sections(), error => /invalid library data/.test(error.message) && !error.message.includes(TOKEN));
});

test('original download streams to disk, reports byte progress, and refuses overwriting files', async t => {
  const dest = destination(t);
  const { client, requests } = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': 8 }); res.end('contents'); });
  const updates = [];
  const metadata = { partKey: '/library/parts/123/456/file.mkv', sizeBytes: 8 };
  assert.deepEqual(await client.download(metadata, dest, { onProgress: progress => updates.push(progress) }), { sizeBytes: 8 });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'contents');
  assert.deepEqual(updates.at(-1), { downloadedBytes: 8, totalBytes: 8, progress: 100 });
  assert.equal(requests[0].url, '/library/parts/123/456/file.mkv?download=1');
  assert.equal(requests[0].headers['x-plex-token'], TOKEN);
  await assert.rejects(client.download(metadata, dest), /already exists/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'contents');
  assert.equal(requests.length, 1);
});

test('mismatched sizes and short/oversized chunked streams remove incomplete files', async t => {
  const dest = destination(t);
  let mode = 'length';
  const { client } = await fixture(t, (_req, res) => {
    if (mode === 'length') res.writeHead(200, { 'Content-Length': 3 });
    else res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
    res.end(mode === 'oversized' ? 'too-much-data' : 'bad');
  });
  const metadata = { partKey: '/library/parts/123/456/file.mkv', sizeBytes: 8 };
  await assert.rejects(client.download(metadata, dest), /file size changed/); assert.equal(fs.existsSync(dest), false);
  mode = 'short';
  await assert.rejects(client.download(metadata, dest), /incomplete/); assert.equal(fs.existsSync(dest), false);
  mode = 'oversized';
  await assert.rejects(client.download(metadata, dest), /more data/); assert.equal(fs.existsSync(dest), false);
});

test('cancelling active downloads closes the stream and removes partial data', async t => {
  const dest = destination(t);
  const controller = new AbortController();
  const { client } = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': 8 }); res.write('part'); });
  await assert.rejects(client.download({ partKey: '/library/parts/123/456/file.mkv', sizeBytes: 8 }, dest,
    { signal: controller.signal, onProgress: () => controller.abort() }), error => error.code === 'ABORT_ERR');
  assert.equal(fs.existsSync(dest), false);
});

test('cancellation also interrupts pending metadata and pre-cancelled downloads', async t => {
  const dest = destination(t);
  const controller = new AbortController();
  const { client, requests } = await fixture(t, () => controller.abort());
  await assert.rejects(client.metadata('42', { signal: controller.signal }), error => error.code === 'ABORT_ERR');
  await assert.rejects(client.download({ partKey: '/library/parts/123/456/file.mkv', sizeBytes: 8 }, dest, { signal: controller.signal }), error => error.code === 'ABORT_ERR');
  assert.equal(requests.length, 1); assert.equal(fs.existsSync(dest), false);
});

test('cancellation while a metadata response is streaming preserves abort semantics', async t => {
  const controller = new AbortController();
  const { client } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"MediaContainer":');
    setImmediate(() => controller.abort());
  });
  await assert.rejects(client.identity({ signal: controller.signal }), error => error.code === 'ABORT_ERR');
});

test('an abruptly disconnected original is never retained as a complete download', async t => {
  const dest = destination(t);
  const { client } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': 8 });
    res.write('part');
    setImmediate(() => res.destroy());
  });
  await assert.rejects(client.download({ partKey: '/library/parts/123/456/file.mkv', sizeBytes: 8 }, dest), error => error.code === 'ECONNRESET' && /interrupted/.test(error.message));
  assert.equal(fs.existsSync(dest), false);
});

test('a disconnected metadata stream preserves an actionable network diagnostic', async t => {
  const { client } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 100 });
    res.write('{"MediaContainer":');
    setImmediate(() => res.destroy());
  });
  await assert.rejects(client.identity(), error => error.code === 'ECONNRESET' && /interrupted/.test(error.message));
});
