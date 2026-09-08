const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dns = require('node:dns').promises;
const { EventEmitter, getEventListeners } = require('node:events');
const { requestLocalNetworkAccess, localNetworkResult } = require('../electron/local-network.cjs');

async function fixture(t) {
  const sockets = new Set();
  let receivedBytes = 0;
  let connections = 0;
  let closed;
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    connections++;
    socket.on('data', data => { receivedBytes += data.length; });
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); closed(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    connectionClosed,
    receivedBytes: () => receivedBytes,
    connections: () => connections,
  };
}

test('request opens a real local connection and sends no credentials or application bytes', async t => {
  const server = await fixture(t);
  const controller = new AbortController();
  const result = await requestLocalNetworkAccess(server.baseUrl, { signal: controller.signal });
  assert.equal(result.status, 'reachable');
  assert.match(result.message, /verify your token/);
  await server.connectionClosed;
  assert.equal(server.connections(), 1);
  assert.equal(server.receivedBytes(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('refused local port is unreachable without claiming permission denial', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  const result = await requestLocalNetworkAccess(baseUrl, { platform: 'darwin' });
  assert.equal(result.status, 'unreachable');
  assert.match(result.message, /not accepting connections.*port/);
  assert.doesNotMatch(result.message, /permission|blocked|Settings/);
});

test('missing, malformed, public, credential-bearing and path-bearing addresses fail safely', async () => {
  for (const baseUrl of [undefined, '', 123, {}, '192.168.1.2', 'http://8.8.8.8', 'http://[2001:4860:4860::8888]',
    'http://user:secret@127.0.0.1', 'http://127.0.0.1?token=secret', 'http://127.0.0.1/secret', 'http://127.0.0.1:0']) {
    await assert.rejects(requestLocalNetworkAccess(baseUrl), error => {
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
});

test('all DNS answers must be local and an accepted answer is pinned without another lookup', async t => {
  const server = await fixture(t);
  const hostnameUrl = server.baseUrl.replace('127.0.0.1', 'plex.test');
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  await assert.rejects(requestLocalNetworkAccess(hostnameUrl), /stay on the local network/);
  lookup.mock.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }]);
  await assert.rejects(requestLocalNetworkAccess(hostnameUrl), /stay on the local network/);
  lookup.mock.mockImplementation(async () => []);
  await assert.rejects(requestLocalNetworkAccess(hostnameUrl), /stay on the local network/);
  assert.equal(server.connections(), 0);
  let calls = 0;
  lookup.mock.mockImplementation(async () => {
    assert.equal(++calls, 1, 'must not repeat DNS lookup after validation');
    return [{ address: '127.0.0.1', family: 4 }];
  });
  assert.equal((await requestLocalNetworkAccess(hostnameUrl)).status, 'reachable');
  await server.connectionClosed;
  assert.equal(calls, 1);
  assert.equal(server.receivedBytes(), 0);
});

test('DNS errors and platform-specific network failures return fixed, credential-free messages', async t => {
  t.mock.method(dns, 'lookup', async () => { throw Object.assign(new Error('secret'), { code: 'ENOTFOUND' }); });
  const result = await requestLocalNetworkAccess('http://plex.test');
  assert.equal(result.status, 'unreachable');
  assert.match(result.message, /hostname/);
  const cases = [
    ['EACCES', 'darwin', 'blocked-or-unreachable'], ['EPERM', 'linux', 'blocked-or-unreachable'],
    ['EHOSTUNREACH', 'darwin', 'blocked-or-unreachable'], ['ENETUNREACH', 'darwin', 'blocked-or-unreachable'],
    ['ENETDOWN', 'darwin', 'blocked-or-unreachable'], ['EHOSTDOWN', 'darwin', 'blocked-or-unreachable'],
    ['EHOSTUNREACH', 'linux', 'unreachable'], ['ETIMEDOUT', 'darwin', 'unreachable'],
    ['ECONNREFUSED', 'darwin', 'unreachable'], ['secret', 'darwin', 'unreachable'],
  ];
  for (const [code, platform, expected] of cases) {
    const mapped = localNetworkResult({ code, message: 'secret', url: 'http://user:secret@plex' }, platform);
    assert.equal(mapped.status, expected);
    assert.doesNotMatch(JSON.stringify(mapped), /secret/);
    if (expected === 'blocked-or-unreachable' && platform === 'darwin') {
      assert.match(mapped.message, /may be blocked.*may be unreachable/);
      assert.match(mapped.message, /Local Network Settings/);
    }
  }
  assert.doesNotMatch(result.message, /secret/);
});

test('lookup timeout includes DNS time and late answers cannot open a socket', async t => {
  const server = await fixture(t);
  let answer;
  t.mock.method(dns, 'lookup', () => new Promise(resolve => { answer = resolve; }));
  const controller = new AbortController();
  const result = await requestLocalNetworkAccess(server.baseUrl.replace('127.0.0.1', 'plex.test'), {
    timeoutMs: 20, signal: controller.signal,
  });
  assert.equal(result.status, 'unreachable');
  assert.match(result.message, /timed out.*does not determine/);
  answer([{ address: '127.0.0.1', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(server.connections(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort before and during DNS lookup rejects and ignores a later lookup failure', async t => {
  let fail;
  let calls = 0;
  t.mock.method(dns, 'lookup', () => { calls++; return new Promise((_resolve, reject) => { fail = reject; }); });
  const early = new AbortController();
  early.abort();
  await assert.rejects(requestLocalNetworkAccess('http://plex.test', { signal: early.signal }), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const request = requestLocalNetworkAccess('http://plex.test', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError', code: 'ABORT_ERR' });
  fail(new Error('late secret'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('socket timeout and abort destroy the socket and safely consume late errors', async t => {
  const sockets = [];
  class PendingSocket extends EventEmitter {
    constructor() { super(); this.destroyed = false; sockets.push(this); }
    connect(options) { this.options = options; }
    destroy() { this.destroyed = true; }
  }
  const originalSocket = net.Socket;
  net.Socket = PendingSocket;
  t.after(() => { net.Socket = originalSocket; });
  const timeoutController = new AbortController();
  const result = await requestLocalNetworkAccess('http://192.168.1.2:32400', { timeoutMs: 20, signal: timeoutController.signal });
  assert.equal(result.status, 'unreachable');
  assert.equal(sockets[0].destroyed, true);
  assert.deepEqual(sockets[0].options, { host: '192.168.1.2', family: 4, port: 32400 });
  sockets[0].emit('error', new Error('late error'));
  assert.equal(getEventListeners(timeoutController.signal, 'abort').length, 0);

  const abortController = new AbortController();
  const request = requestLocalNetworkAccess('https://[fd00::1]', { signal: abortController.signal });
  abortController.abort();
  await assert.rejects(request, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(sockets[1].destroyed, true);
  assert.deepEqual(sockets[1].options, { host: 'fd00::1', family: 6, port: 443 });
  sockets[1].emit('error', new Error('late error'));
  assert.equal(getEventListeners(abortController.signal, 'abort').length, 0);
});
