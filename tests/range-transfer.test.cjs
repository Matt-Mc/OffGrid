const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { rangeTransfer } = require('../electron/range-transfer.cjs');

function destination(t, initial = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-range-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'film.mkv');
  if (initial) fs.writeFileSync(filename, initial, { mode: 0o600 });
  return filename;
}
function response(statusCode, body, headers = {}) {
  const stream = Readable.from(body);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

test('a validated 206 resumes at the checkpoint and produces byte-identical output', async t => {
  const file = destination(t, 'cont-mismatch');
  const checkpoint = { offset: 4, totalBytes: 8, etag: '"version-1"' };
  const requests = [];
  const result = await rangeTransfer({
    request: async headers => { requests.push(headers); return response(206, [Buffer.from('ents')], {
      'content-range': 'bytes 4-7/8', 'content-length': '4', etag: '"version-1"'
    }); },
    destination: file, totalBytes: 8, resumeState: checkpoint, revalidate: async () => true,
    errorPrefix: 'Test server'
  });
  assert.deepEqual(requests, [{ Range: 'bytes=4-', 'If-Range': '"version-1"' }]);
  assert.deepEqual(result, { sizeBytes: 8, resumedBytes: 4 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'contents');
});

test('an ignored range with 200 truncates the checkpoint before writing a fresh representation', async t => {
  const file = destination(t, 'old!');
  const checkpoints = [];
  const result = await rangeTransfer({
    request: async () => response(200, [Buffer.from('new-file')], { 'content-length': '8', etag: '"version-2"' }),
    destination: file, totalBytes: 8, resumeState: { offset: 4, totalBytes: 8, etag: '"version-1"' },
    onCheckpoint: value => checkpoints.push(value), revalidate: async () => true, errorPrefix: 'Test server'
  });
  assert.deepEqual(result, { sizeBytes: 8, resumedBytes: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new-file');
  assert.equal(checkpoints[0], null);
  assert.equal(checkpoints.at(-1), null);
});

test('416 revalidates the source and safely retries from byte zero', async t => {
  const file = destination(t, 'part');
  const requests = [];
  let checks = 0;
  await rangeTransfer({
    request: async headers => {
      requests.push(headers);
      return requests.length === 1 ? response(416, [], {}) : response(200, [Buffer.from('contents')], { 'content-length': '8' });
    },
    destination: file, totalBytes: 8, resumeState: { offset: 4, totalBytes: 8, etag: '"v1"' },
    revalidate: async () => { checks++; return true; }, errorPrefix: 'Test server'
  });
  assert.equal(checks, 2);
  assert.deepEqual(requests, [{ Range: 'bytes=4-', 'If-Range': '"v1"' }, {}]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'contents');
});

test('a changed source invalidates the retained prefix before any range request', async t => {
  const file = destination(t, 'part');
  let requested = false;
  await assert.rejects(rangeTransfer({
    request: async () => { requested = true; return response(206, [Buffer.from('tail')], { 'content-range': 'bytes 4-7/8', etag: '"v1"' }); },
    destination: file, totalBytes: 8, resumeState: { offset: 4, totalBytes: 8, etag: '"v1"' },
    revalidate: async () => false, errorPrefix: 'Test server'
  }), error => error.code === 'SOURCE_CHANGED');
  assert.equal(requested, false);
  assert.equal(fs.existsSync(file), false);
});

test('wrong range offsets, totals, or validators revalidate and restart without appending', async t => {
  for (const headers of [
    { 'content-range': 'bytes 3-7/8', etag: '"v1"' },
    { 'content-range': 'bytes 4-7/9', etag: '"v1"' },
    { 'content-range': 'bytes 4-7/8', etag: '"v2"' },
    { 'content-range': 'bytes 4-7/8' }
  ]) {
    const file = destination(t, 'part');
    let calls = 0;
    await rangeTransfer({
      request: async () => ++calls === 1 ? response(206, [Buffer.from('tail')], headers)
        : response(200, [Buffer.from('contents')], { 'content-length': '8' }), destination: file, totalBytes: 8,
      resumeState: { offset: 4, totalBytes: 8, etag: '"v1"' }, revalidate: async () => true, errorPrefix: 'Test server'
    });
    assert.equal(calls, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'contents');
  }
});

test('only a strong ETag allows a failed transfer to retain a reusable prefix', async t => {
  for (const etag of [undefined, 'W/"weak"']) {
    const file = destination(t);
    const state = [];
    const stream = Readable.from((async function* () {
      yield Buffer.from('part');
      throw Object.assign(new Error('socket interrupted'), { code: 'ECONNRESET' });
    })());
    stream.statusCode = 200; stream.headers = etag ? { etag } : {};
    await assert.rejects(rangeTransfer({ request: async () => stream, destination: file, totalBytes: 8,
      retainOnError: true, onCheckpoint: value => state.push(value), errorPrefix: 'Test server' }), error => error.retryable === true);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(state, [null]);
  }

  const file = destination(t);
  const state = [];
  const stream = Readable.from((async function* () {
    yield Buffer.from('part');
    throw Object.assign(new Error('socket interrupted'), { code: 'ECONNRESET' });
  })());
  stream.statusCode = 200; stream.headers = { etag: '"stable"' };
  await assert.rejects(rangeTransfer({ request: async () => stream, destination: file, totalBytes: 8,
    retainOnError: true, onCheckpoint: value => state.push(value), errorPrefix: 'Test server' }), error => error.retryable === true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'part');
  assert.deepEqual(state.at(-1), { offset: 4, totalBytes: 8, etag: '"stable"' });
});

test('an explicitly retained cancellation saves the synchronized prefix', async t => {
  const file = destination(t);
  const controller = new AbortController();
  const state = [];
  const stream = Readable.from((async function* () {
    yield Buffer.from('part');
    yield Buffer.from('tail');
  })());
  stream.statusCode = 200; stream.headers = { etag: '"stable"' };
  await assert.rejects(rangeTransfer({
    request: async () => stream, destination: file, totalBytes: 8, signal: controller.signal,
    retainOnError: true, onCheckpoint: value => state.push(value), onProgress: () => controller.abort(), errorPrefix: 'Test server'
  }), error => error.code === 'ABORT_ERR' && error.retryable === true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'part');
  assert.deepEqual(state.at(-1), { offset: 4, totalBytes: 8, etag: '"stable"' });
});

test('resume and reset never follow a destination symlink', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-range-symlink-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const protectedFile = path.join(directory, 'protected.mkv');
  const link = path.join(directory, 'film.mkv');
  fs.writeFileSync(protectedFile, 'protected content');
  fs.symlinkSync(protectedFile, link);
  for (const resumeState of [undefined, { offset: 4, totalBytes: 8, etag: '"stable"' }]) {
    await assert.rejects(rangeTransfer({
      request: async () => response(200, [Buffer.from('contents')], { 'content-length': '8' }),
      destination: link, totalBytes: 8, resumeState, errorPrefix: 'Test server'
    }), error => ['ELOOP', 'UNSAFE_DESTINATION', 'EEXIST'].includes(error.code));
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'protected content');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  }
});
