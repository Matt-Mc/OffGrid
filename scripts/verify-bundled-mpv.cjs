// Exercise the release player through the same inherited JSON IPC used by Offgrid.
// No user library, credentials, mpv configuration, or system mpv is used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createMpvPlayer } = require('../electron/mpv-player.cjs');

function parseArguments(args) {
  const options = { runtimeRoot: path.resolve(__dirname, '../vendor/mpv'), headless: false, ffmpeg: process.env.FFMPEG_PATH };
  let rootProvided = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--headless') options.headless = true;
    else if (args[index] === '--ffmpeg') {
      options.ffmpeg = args[++index];
      if (!options.ffmpeg || options.ffmpeg.startsWith('--')) throw new Error('--ffmpeg requires an executable path.');
    } else if (args[index].startsWith('--') || rootProvided) {
      throw new Error('Usage: node scripts/verify-bundled-mpv.cjs [runtime-root] [--headless] [--ffmpeg /path/to/ffmpeg]');
    } else {
      options.runtimeRoot = path.resolve(args[index]);
      rootProvided = true;
    }
  }
  return options;
}

function findFfmpeg(explicit) {
  // Resolve this build-only tool before giving mpv its restricted environment.
  const candidates = explicit ? [path.resolve(explicit)] : (process.env.PATH || '').split(path.delimiter)
    .filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, 'ffmpeg'));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Try the next build-tool location. */ }
  }
  throw new Error('FFmpeg is needed to generate the disposable test clip. Set FFMPEG_PATH or pass --ffmpeg /path/to/ffmpeg.');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const ffmpeg = findFfmpeg(options.ffmpeg);
  const bundledPath = path.join(options.runtimeRoot, 'bin', 'mpv');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-bundled-player-'));
  let player;
  let interrupted;
  let timer;
  const onInterrupt = signal => {
    interrupted = new Error(`Player verification interrupted (${signal}).`);
    void player?.stop();
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const home = path.join(temporary, 'home');
    fs.mkdirSync(home);
    const clip = path.join(temporary, 'sample.mkv');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', '20', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', clip], { timeout: 30_000, stdio: 'pipe' });
    const environment = { ...process.env, PATH: '/usr/bin:/bin', HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share') };
    for (const key of Object.keys(environment)) {
      if (key.startsWith('DYLD_') || key.startsWith('VK_') || key.startsWith('MPV_') || key === 'LD_LIBRARY_PATH' || key === 'LD_PRELOAD') delete environment[key];
    }
    const progress = [];
    const launches = [];
    let playerDiagnostics = '';
    player = createMpvPlayer({ bundledPath, env: environment, startupTimeoutMs: 20_000,
      onProgress: (id, value) => progress.push({ id, ...value }),
      spawn(executable, args, config) {
        assert.equal(executable, bundledPath, 'Must execute the release runtime, never a system mpv');
        const actualArgs = [...args];
        const extra = ['--terminal=yes', '--msg-level=all=warn'];
        if (options.headless) extra.push('--vo=null', '--ao=null', '--force-window=no');
        actualArgs.splice(actualArgs.indexOf('--'), 0, ...extra);
        launches.push(actualArgs);
        const child = spawn(executable, actualArgs, { ...config, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        const collect = chunk => { playerDiagnostics = (playerDiagnostics + chunk.toString()).slice(-16_384); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        return child;
      },
    });
    const waitFor = async (description, predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (interrupted) throw interrupted;
        const state = player.state();
        if (state.status === 'error') throw new Error(`${description}: ${state.error}\n${playerDiagnostics}`);
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}. State: ${JSON.stringify(state)}\n${playerDiagnostics}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    timer = setTimeout(() => onInterrupt('60-second deadline'), 60_000);
    const installation = await player.status();
    assert.equal(installation.source, 'bundled');
    assert.equal(installation.available, true, installation.message);
    const video = { id: 'bundled-runtime-fixture', title: 'Offgrid player verification', filePath: clip, duration: 20, playbackPositionSeconds: 0, watched: false };
    try {
      await player.open(video);
      await waitFor('playback progress', () => player.state().positionSeconds >= 0.4);
      await player.control('toggle-pause');
      await waitFor('pause acknowledgement', () => player.state().paused);
      // Allow an already-buffered time-pos event to arrive before checking stability.
      await new Promise(resolve => setTimeout(resolve, 200));
      const pausedPosition = player.state().positionSeconds;
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.ok(Math.abs(player.state().positionSeconds - pausedPosition) < 0.15, 'Position should remain stable while paused');
      await player.control('toggle-pause');
      await waitFor('resumed playback', () => !player.state().paused && player.state().positionSeconds > pausedPosition + 0.3);
      await player.stop();
      assert.equal(player.state().status, 'stopped');
      assert.ok(progress.some(value => value.id === video.id && value.positionSeconds > 0.4), 'Playback position must be persisted');
      await player.open({ ...video, playbackPositionSeconds: 3 });
      assert.ok(launches.at(-1).includes('--start=3'), 'Saved resume position must reach mpv');
      await waitFor('playback from saved position', () => player.state().positionSeconds >= 3.4);
      await player.stop();
      assert.equal(player.state().status, 'stopped');
      assert.equal(launches.length, 2);
      if (interrupted) throw interrupted;
    } catch (error) {
      if (playerDiagnostics) error.message += `\nBundled player diagnostics:\n${playerDiagnostics}`;
      throw error;
    }
    console.log(`Bundled mpv verified (${options.headless ? 'headless decoding' : 'native window and GPU'}): playback, pause, resume, persisted progress, saved-position startup, and shutdown.`);
    console.log(`Runtime: ${options.runtimeRoot}`);
  } finally {
    clearTimeout(timer);
    await player?.stop();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
