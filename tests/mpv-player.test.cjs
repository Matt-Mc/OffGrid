const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMpvPlayer } = require('../electron/mpv-player.cjs');

function harness(t, options = {}) {
  const processes = [], progress = [], states = [], launches = [];
  const fileSystem = { promises: {
    async access(file) { if (file !== '/opt/homebrew/bin/mpv') throw new Error('Missing'); },
    async stat(file) { if (file.includes('missing')) throw new Error('Missing'); return { isFile: () => true }; },
    async realpath(file) { return file; },
  } };
  const player = createMpvPlayer({ platform: 'darwin', fs: fileSystem, env: { PATH: '.:relative:/bin' },
    startupTimeoutMs: 100, shutdownTimeoutMs: 5,
    onProgress: (id, value) => progress.push({ id, ...value }), onState: state => states.push(state),
    spawn(executable, args, config) {
      launches.push({ executable, args, config });
      const child = new EventEmitter(), ipc = new EventEmitter();
      ipc.commands = [];
      ipc.write = data => {
        const command = JSON.parse(data).command;
        ipc.commands.push(command);
        if (command[0] === 'quit' && !options.ignoreQuit) queueMicrotask(() => child.emit('close', 0));
        return true;
      };
      ipc.destroy = () => { ipc.destroyed = true; };
      child.stdio = [null, null, null, ipc];
      child.kills = [];
      child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null)); };
      child.message = message => ipc.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
      child.property = (name, data) => child.message({ event: 'property-change', name, data });
      processes.push(child);
      if (!options.noAutoLoad) queueMicrotask(() => child.message({ event: 'file-loaded' }));
      return child;
    }, ...options.dependencies });
  t.after(() => player.stop());
  return { player, processes, progress, states, launches };
}
const media = (id = 'one', extra = {}) => ({ id, filePath: `/library/${id}.mkv`, title: 'A movie', duration: 100, playbackPositionSeconds: 20, watched: false, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('discovers mpv without a shell and launches only the supplied local file through inherited IPC', async t => {
  const { player, launches, processes } = harness(t);
  assert.equal((await player.status()).path, '/opt/homebrew/bin/mpv');
  await player.open(media('movie', { title: '--script=/tmp/bad\n$(bad)' }));
  assert.equal(launches[0].config.shell, false);
  assert.deepEqual(launches[0].config.stdio, ['ignore', 'ignore', 'ignore', 'pipe']);
  assert.deepEqual(launches[0].args.slice(-2), ['--', '/library/movie.mkv']);
  for (const arg of ['--no-config', '--load-scripts=no', '--ytdl=no', '--access-references=no', '--input-ipc-client=fd://3', '--start=20']) assert.ok(launches[0].args.includes(arg));
  assert.equal(launches[0].args.some(arg => arg.startsWith('--script=')), false);
  assert.deepEqual(processes[0].stdio[3].commands, [['observe_property', 1, 'time-pos'], ['observe_property', 2, 'duration'], ['observe_property', 3, 'pause']]);
  assert.equal(player.state().status, 'playing');
  await assert.rejects(player.open(media('remote', { filePath: 'https://example.com/movie.mkv' })), /downloaded library/);
  await assert.rejects(player.open(media('missing')), /missing or unreadable/);
  assert.equal(processes.length, 1);
});

test('reports installation guidance and unsupported platforms without spawning', async t => {
  const absent = harness(t, { dependencies: { fs: { promises: { access: async () => { throw new Error('Missing'); } } } } });
  assert.equal((await absent.player.status()).available, false);
  await assert.rejects(absent.player.open(media()), /brew install mpv/);
  const windows = harness(t, { dependencies: { platform: 'win32' } });
  assert.match((await windows.player.status()).message, /Windows/);
  assert.equal(absent.processes.length + windows.processes.length, 0);
});

test('accepts fragmented messages, saves progress and pause, and ignores malformed properties', async t => {
  const { player, processes, progress } = harness(t);
  await player.open(media());
  const child = processes[0];
  child.stdio[3].emit('data', Buffer.from('not json\n{"event":"property-change","name":"time-pos",'));
  child.stdio[3].emit('data', Buffer.from('"data":35}\n'));
  assert.equal(player.state().positionSeconds, 35);
  assert.deepEqual(progress.at(-1), { id: 'one', positionSeconds: 35, watched: false });
  child.property('time-pos', -1);
  child.property('time-pos', '80');
  child.property('duration', null);
  assert.equal(player.state().positionSeconds, 35);
  child.property('pause', true);
  assert.equal(player.state().status, 'paused');
  await player.control('toggle-pause');
  assert.deepEqual(child.stdio[3].commands.at(-1), ['cycle', 'pause']);
  await assert.rejects(player.control(['run', 'bad']), /Unsupported/);
  child.property('time-pos', 96);
  assert.equal(progress.at(-1).watched, true);
  await player.stop();
  assert.deepEqual(progress.at(-1), { id: 'one', positionSeconds: 96, watched: true });
});

test('EOF marks watched and retains the final position after process closure', async t => {
  const { player, processes, progress } = harness(t);
  await player.open(media());
  processes[0].property('duration', 123);
  processes[0].message({ event: 'end-file', reason: 'eof' });
  processes[0].emit('close', 0);
  assert.equal(player.state().status, 'ended');
  assert.deepEqual(progress.at(-1), { id: 'one', positionSeconds: 123, watched: true });
});

test('switching videos saves the last position and stale child events cannot change the next video', async t => {
  const { player, processes, progress, launches } = harness(t);
  await player.open(media());
  processes[0].property('time-pos', 44);
  await player.open(media('two', { watched: true }));
  assert.ok(progress.some(value => value.id === 'one' && value.positionSeconds === 44));
  assert.ok(launches[1].args.includes('--start=0'));
  processes[0].property('time-pos', 80);
  assert.equal(player.state().videoId, 'two');
  assert.equal(player.state().positionSeconds, 0);
  await player.control('stop');
  await assert.rejects(player.control('toggle-pause'), /No video/);
});

test('startup timeout and process errors fail visibly and terminate the child', async t => {
  const timed = harness(t, { noAutoLoad: true, dependencies: { startupTimeoutMs: 10 } });
  await assert.rejects(timed.player.open(media()), /in time/);
  await tick();
  assert.equal(timed.player.state().status, 'error');
  const failed = harness(t, { noAutoLoad: true });
  const opening = failed.player.open(media());
  await tick();
  failed.processes[0].emit('error', new Error('ENOENT'));
  await assert.rejects(opening, /could not start/);
  assert.equal(failed.player.state().status, 'error');
});

test('decode errors and premature process exit do not report a successful playback', async t => {
  const failed = harness(t);
  await failed.player.open(media());
  failed.processes[0].message({ event: 'end-file', reason: 'error' });
  assert.equal(failed.player.state().status, 'error');
  assert.equal(failed.progress.at(-1).watched, false);
  const early = harness(t, { noAutoLoad: true });
  const opening = early.player.open(media());
  await tick();
  early.processes[0].emit('close', 1);
  await assert.rejects(opening, /before playback/);
});

test('oversized IPC fails safely and unresponsive players are killed on shutdown', async t => {
  const oversized = harness(t);
  await oversized.player.open(media());
  oversized.processes[0].stdio[3].emit('data', Buffer.alloc(128 * 1024 + 1, 65));
  assert.match(oversized.player.state().error, /oversized/);
  const stuck = harness(t, { ignoreQuit: true });
  await stuck.player.open(media());
  await stuck.player.stop();
  assert.deepEqual(stuck.processes[0].kills, ['SIGKILL']);
  assert.equal(stuck.player.state().status, 'stopped');
});

test('simultaneous opens are superseded and stop cancels a pending startup', async t => {
  const { player, processes } = harness(t, { noAutoLoad: true });
  const first = player.open(media('one'));
  const second = player.open(media('two'));
  await assert.rejects(first, /canceled/);
  await tick();
  assert.equal(processes.length, 1);
  const stopped = player.stop();
  await assert.rejects(second, /stopped before/);
  await stopped;
  assert.equal(player.state().videoId, 'two');
  assert.equal(player.state().status, 'stopped');
});

test('synchronous spawn failure and a running process crash preserve an actionable state', async t => {
  const failed = harness(t, { dependencies: { spawn() { throw new Error('spawn failed'); } } });
  await assert.rejects(failed.player.open(media()), /could not start/);
  assert.equal(failed.player.state().status, 'error');
  const crashed = harness(t);
  await crashed.player.open(media());
  crashed.processes[0].property('time-pos', 45);
  crashed.processes[0].emit('close', 2);
  assert.match(crashed.player.state().error, /stopped unexpectedly/);
  assert.equal(crashed.progress.at(-1).positionSeconds, 45);
  assert.equal(crashed.progress.at(-1).watched, false);
});

test('storage failures are visible while playback continues and clear after a successful save', async t => {
  let fail = true;
  const errors = [];
  const { player, processes } = harness(t, { dependencies: {
    onProgress() { if (fail) throw new Error('Disk is full'); },
    onError: message => errors.push(message),
  } });
  await player.open(media());
  processes[0].property('time-pos', 25);
  assert.equal(player.state().status, 'playing');
  assert.match(player.state().error, /could not be saved/);
  assert.equal(errors.length, 1);
  processes[0].property('pause', true);
  assert.equal(errors.length, 1);
  fail = false;
  processes[0].property('pause', false);
  await tick();
  assert.equal(player.state().error, null);
});

test('asynchronous save failure after closure reports through onError', async t => {
  const errors = [];
  const { player, processes } = harness(t, { dependencies: {
    onProgress: async () => { throw new Error('Disk is full'); },
    onError: message => errors.push(message),
  } });
  await player.open(media());
  processes[0].emit('close', 0);
  await tick();
  assert.match(errors[0], /could not be saved/);
});
