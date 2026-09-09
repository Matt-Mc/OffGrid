// Real Windows mpv + IPC + process-tree checks using disposable generated media.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createManagedMpv } = require('../electron/managed-mpv.cjs');
const { createMpvPlayer } = require('../electron/mpv-player.cjs');
const { killProcessTree } = require('../electron/process-tree.cjs');

const waitFor = async predicate => {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Windows verification timed out.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
async function verify() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Run on Windows x64.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-windows-'));
  const managed = createManagedMpv({ directory: path.join(temporary, 'tools'), onError: error => console.error('Player setup:', error) });
  let player, tree;
  try {
    const installation = await managed.ensure();
    assert.equal(installation.available, true, installation.message);
    const offline = createManagedMpv({ directory: path.join(temporary, 'tools'), fetch: () => { throw new Error('Network disabled'); } });
    assert.equal((await offline.ensure()).available, true);
    const filePath = path.join(temporary, 'A video with spaces — offline.y4m');
    const frames = [Buffer.from('YUV4MPEG2 W16 H16 F25:1 Ip A1:1 C420jpeg\n')];
    for (let index = 0; index < 125; index++) frames.push(Buffer.from('FRAME\n'), Buffer.alloc(384, 128));
    await fs.writeFile(filePath, Buffer.concat(frames));
    const progress = [];
    player = createMpvPlayer({ managedStatus: offline.status,
      onProgress: (id, value) => progress.push(value),
      spawn: (command, args, options) => spawn(command, ['--vo=null', '--ao=null', ...args], options),
    });
    const video = { id: 'fixture', title: 'Windows offline fixture', filePath, duration: 5, playbackPositionSeconds: 1 };
    await player.open(video);
    await waitFor(() => player.state().positionSeconds >= 1);
    await player.control('toggle-pause');
    await waitFor(() => player.state().paused);
    await player.control('toggle-pause');
    await waitFor(() => !player.state().paused);
    await player.stop();
    assert.ok(progress.some(value => value.positionSeconds >= 1));
    await player.open({ ...video, playbackPositionSeconds: 4 });
    await waitFor(() => player.state().status === 'ended');
    await player.stop();
    assert.ok(progress.some(value => value.watched));

    const heartbeat = path.join(temporary, 'child-heartbeat');
    const descendant = `setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'.'),50)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)`;
    tree = spawn(process.execPath, ['-e', parent, heartbeat], { stdio: 'ignore', windowsHide: true });
    await waitFor(async () => { try { return (await fs.stat(heartbeat)).size >= 2; } catch { return false; } });
    await killProcessTree(tree);
    tree = null;
    const size = (await fs.stat(heartbeat)).size;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await fs.stat(heartbeat)).size, size, 'Descendant must stop writing before cancellation finishes');
    console.log('Windows verified: player setup, offline reuse, real playback, pause/resume, saved progress, EOF, and descendant cancellation.');
  } finally {
    if (tree) await killProcessTree(tree).catch(() => {});
    await player?.stop();
    await managed.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
