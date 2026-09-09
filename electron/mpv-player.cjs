const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { randomUUID } = require('node:crypto');

const INITIAL_STATE = { videoId: null, status: 'idle', positionSeconds: 0, duration: 0, paused: false, error: null };
const BUNDLE_REPAIR_MESSAGE = 'Offgrid’s bundled player is missing or unreadable. Download and reinstall the latest Offgrid release, then try again.';
const MAX_IPC_BUFFER = 128 * 1024;
const PROGRESS_ERROR = 'Playback position could not be saved. Check that your library storage is writable.';

// The renderer never supplies an executable, arguments, IPC path, or mpv command.
function createMpvPlayer(options = {}) {
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const connect = options.connect || net.createConnection;
  const fileSystem = options.fs || fs;
  const spawnProcess = options.spawn || spawn;
  const environment = options.env || process.env;
  const bundledPath = options.bundledPath;
  const installMessage = platform === 'darwin'
    ? 'For development, install mpv with brew install mpv, then refresh the player in Settings.'
    : platform === 'win32' ? 'Install mpv for Windows and add its folder to PATH, then refresh the player in Settings.'
    : 'For development, install mpv using your distribution’s package manager, then refresh the player in Settings.';
  const startupHelp = bundledPath ? 'Reinstall the latest Offgrid release and try again.' : 'Check that your mpv installation works.';
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1_500;
  let current = { ...INITIAL_STATE };
  let active = null;
  let generation = 0;

  function invoke(callback, ...args) {
    try { Promise.resolve(callback?.(...args)).catch(() => {}); } catch { /* Storage/UI failures cannot break process cleanup. */ }
  }
  function emit(session, patch) {
    Object.assign(session.state, patch);
    if (active !== session) return;
    current = { ...session.state };
    invoke(options.onState, { ...current });
  }
  function persist(session, force = false) {
    const state = session.state;
    const watched = session.watched || (state.duration > 0 && state.positionSeconds / state.duration >= 0.95);
    session.watched = watched;
    const now = Date.now();
    if (!force && now - session.lastProgressAt < 5_000 && watched === session.lastWatched) return;
    session.lastProgressAt = now;
    session.lastWatched = watched;
    const revision = session.progressRevision = (session.progressRevision || 0) + 1;
    const saved = () => {
      if (revision !== session.progressRevision) return;
      session.persistenceFailed = false;
      if (session.state.error === PROGRESS_ERROR) emit(session, { error: null });
    };
    const failed = () => {
      if (revision !== session.progressRevision) return;
      if (!session.persistenceFailed) invoke(options.onError, PROGRESS_ERROR);
      session.persistenceFailed = true;
      if (session.state.status !== 'error') emit(session, { error: PROGRESS_ERROR });
    };
    try { Promise.resolve(options.onProgress?.(state.videoId, { positionSeconds: state.positionSeconds, watched })).then(saved, failed); }
    catch { failed(); }
  }
  async function status() {
    if (options.managedStatus) return options.managedStatus();
    if (bundledPath) {
      try {
        if (!paths.isAbsolute(bundledPath)) throw new Error('Invalid bundled path');
        await fileSystem.promises.access(bundledPath, fs.constants.X_OK);
        if (!(await fileSystem.promises.stat(bundledPath)).isFile()) throw new Error('Not a file');
        return { available: true, path: bundledPath, source: 'bundled', message: 'The bundled mpv player is ready. No separate installation is needed.' };
      } catch {
        // An incomplete release must not silently depend on a developer's system installation.
        return { available: false, path: null, source: 'bundled', message: BUNDLE_REPAIR_MESSAGE };
      }
    }
    const candidates = platform === 'darwin'
      ? ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/usr/bin/mpv', '/Applications/mpv.app/Contents/MacOS/mpv']
      : platform === 'win32' ? [] : ['/usr/local/bin/mpv', '/usr/bin/mpv'];
    const searchPath = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
    for (const directory of searchPath.split(paths.delimiter)) {
      if (paths.isAbsolute(directory)) candidates.push(paths.join(directory, platform === 'win32' ? 'mpv.exe' : 'mpv'));
    }
    for (const candidate of new Set(candidates)) {
      try {
        await fileSystem.promises.access(candidate, fs.constants.X_OK);
        if ((await fileSystem.promises.stat(candidate)).isFile()) return { available: true, path: candidate, source: 'system', message: 'mpv is ready. Videos open in a separate player window.' };
      } catch { /* Try the next installation location. */ }
    }
    return { available: false, path: null, source: 'system', message: installMessage };
  }
  function send(session, command) {
    if (session.closed || !session.ipc || session.ipc.destroyed) return false;
    try { session.ipc.write(`${JSON.stringify({ command })}\n`); return true; } catch { return false; }
  }
  function fail(session, message) {
    if (session.closed || session.stopping || session.state.status === 'error') return;
    persist(session, true);
    emit(session, { status: 'error', error: message });
    clearTimeout(session.startupTimer);
    clearTimeout(session.connectTimer);
    session.rejectStartup(new Error(message));
    void terminate(session, true);
  }
  function handleMessage(session, message) {
    if (session.closed || session.stopping || session.state.status === 'error' || !message || typeof message !== 'object') return;
    if (message.event === 'file-loaded') {
      session.loaded = true;
      clearTimeout(session.startupTimer);
      emit(session, { status: session.state.paused ? 'paused' : 'playing' });
      session.resolveStartup({ ...session.state });
      return;
    }
    if (message.event === 'property-change') {
      if (message.name === 'time-pos' && Number.isFinite(message.data) && message.data >= 0) {
        emit(session, { positionSeconds: message.data });
        persist(session);
      } else if (message.name === 'duration' && Number.isFinite(message.data) && message.data > 0) {
        emit(session, { duration: message.data });
      } else if (message.name === 'pause' && typeof message.data === 'boolean') {
        emit(session, { paused: message.data, ...(session.loaded ? { status: message.data ? 'paused' : 'playing' } : {}) });
        if (session.loaded) persist(session, true);
      }
      return;
    }
    if (message.event === 'end-file') {
      if (message.reason === 'error') return fail(session, 'mpv could not play this file. Check that the downloaded media is complete.');
      if (message.reason === 'eof') {
        session.watched = true;
        emit(session, { status: 'ended', positionSeconds: session.state.duration || session.state.positionSeconds });
        persist(session, true);
        if (platform === 'win32') void terminate(session);
      }
    }
  }
  function receive(session, chunk) {
    session.buffer += chunk.toString('utf8');
    if (session.buffer.length > MAX_IPC_BUFFER) return fail(session, 'mpv returned an oversized control message.');
    let newline;
    while ((newline = session.buffer.indexOf('\n')) !== -1) {
      const line = session.buffer.slice(0, newline);
      session.buffer = session.buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      handleMessage(session, message);
    }
  }
  function finish(session, code) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.startupTimer);
    clearTimeout(session.killTimer);
    clearTimeout(session.finishTimer);
    clearTimeout(session.disconnectTimer);
    clearTimeout(session.connectTimer);
    session.connecting?.destroy();
    session.ipc?.destroy();
    const failed = session.state.status === 'error';
    if (!session.loaded && !session.stopping && !failed) {
      const message = `mpv exited before playback started. Check the media file. ${startupHelp}`;
      emit(session, { status: 'error', error: message });
      session.rejectStartup(new Error(message));
    } else if (!failed && session.state.status !== 'ended') {
      emit(session, code && !session.stopping
        ? { status: 'error', error: 'mpv stopped unexpectedly. Try opening the video again.' }
        : { status: 'stopped', paused: false });
    }
    persist(session, true);
    if (active === session) active = null;
    session.resolveClosed();
  }
  async function terminate(session, failed = false) {
    if (!session || session.closed) return;
    if (session.stopping) return session.done;
    session.stopping = true;
    clearTimeout(session.startupTimer);
    clearTimeout(session.connectTimer);
    session.connecting?.destroy();
    session.rejectStartup(new Error(failed ? session.state.error : 'Playback was stopped before it started.'));
    persist(session, true);
    if (!send(session, ['quit'])) session.child.kill('SIGTERM');
    session.killTimer = setTimeout(() => {
      if (!session.closed) session.child.kill('SIGKILL');
      // Never leave shutdown hanging on a broken child/IPC implementation.
      session.finishTimer = setTimeout(() => finish(session, null), shutdownTimeoutMs);
    }, shutdownTimeoutMs);
    return session.done;
  }
  async function stop() {
    generation += 1;
    await terminate(active);
    return { ...current };
  }
  async function open(video) {
    if (!video || typeof video.id !== 'string' || !video.id || typeof video.filePath !== 'string' || !paths.isAbsolute(video.filePath) || video.filePath.includes('\0')) {
      throw new Error('Select a downloaded library video to play.');
    }
    const request = ++generation;
    const installation = await status();
    if (!installation.available) throw new Error(installation.message);
    let filePath;
    try {
      filePath = await fileSystem.promises.realpath(video.filePath);
      if (!(await fileSystem.promises.stat(filePath)).isFile()) throw new Error('Not a file');
    } catch { throw new Error('The downloaded media file is missing or unreadable.'); }
    if (request !== generation) throw new Error('Playback request was canceled.');
    await terminate(active);
    if (request !== generation) throw new Error('Playback request was canceled.');
    const position = !video.watched && Number.isFinite(video.playbackPositionSeconds) && video.playbackPositionSeconds > 0 ? video.playbackPositionSeconds : 0;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const session = { state: { ...INITIAL_STATE, videoId: video.id, status: 'starting', positionSeconds: position, duration },
      loaded: false, closed: false, stopping: false, buffer: '', watched: Boolean(video.watched), lastProgressAt: 0, lastWatched: Boolean(video.watched) };
    session.ready = new Promise((resolve, reject) => { session.resolveStartup = resolve; session.rejectStartup = reject; });
    // A synchronous spawn or IPC failure can reject before open returns its promise.
    session.ready.catch(() => {});
    session.done = new Promise(resolve => { session.resolveClosed = resolve; });
    active = session;
    emit(session, {});
    const title = String(video.title || 'Offgrid').replace(/[\r\n\0]/g, ' ').slice(0, 200);
    const pipe = `\\\\.\\pipe\\offgrid-${randomUUID()}`;
    const args = ['--no-config', '--load-scripts=no', '--ytdl=no', '--access-references=no', '--resume-playback=no', '--save-position-on-quit=no',
      platform === 'win32' ? `--input-ipc-server=${pipe}` : '--input-ipc-client=fd://3',
      '--input-terminal=no', '--terminal=no', '--force-window=yes', `--title=Offgrid — ${title}`, `--start=${position}`,
      ...(platform === 'win32' ? ['--idle=yes'] : ['--', filePath])];
    const runtimeEnvironment = { ...environment };
    if (installation.source === 'bundled' && platform === 'darwin') {
      const vulkanDriver = paths.resolve(paths.dirname(installation.path), '../share/vulkan/icd.d/MoltenVK_icd.json');
      runtimeEnvironment.VK_DRIVER_FILES = vulkanDriver;
      runtimeEnvironment.VK_ICD_FILENAMES = vulkanDriver;
    }
    try {
      session.child = spawnProcess(installation.path, args, { shell: false, stdio: platform === 'win32' ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'ignore', 'ignore', 'pipe'], windowsHide: true, env: runtimeEnvironment });
      session.child.once('error', () => fail(session, `mpv could not start. ${startupHelp}`));
      session.child.once('close', code => finish(session, code));
      session.startupTimer = setTimeout(() => fail(session, `mpv did not start playback in time. ${startupHelp}`), startupTimeoutMs);
      const attach = ipc => {
        session.ipc = ipc;
        ipc.on('data', chunk => receive(session, chunk));
        ipc.on('error', () => fail(session, 'The connection to mpv was interrupted.'));
        ipc.on('close', () => {
          // mpv closes IPC just before its process exits when the user closes its
          // window. Let the exit handler report that normal stop first.
          if (!session.closed && !session.stopping) session.disconnectTimer = setTimeout(() => fail(session, 'The connection to mpv was interrupted.'), 100);
        });
        send(session, ['observe_property', 1, 'time-pos']);
        send(session, ['observe_property', 2, 'duration']);
        send(session, ['observe_property', 3, 'pause']);
        // Load only after subscribing: fast files cannot outrun the IPC connection.
        if (platform === 'win32') send(session, ['loadfile', filePath]);
      };
      if (platform === 'win32') {
        const attempt = () => {
          if (session.closed || session.stopping) return;
          const ipc = session.connecting = connect(pipe);
          const retry = error => {
            ipc.destroy();
            if (session.closed || session.stopping) return;
            if (['ENOENT', 'ECONNREFUSED', 'EBUSY'].includes(error.code)) session.connectTimer = setTimeout(attempt, 50);
            else fail(session, 'The mpv control connection could not be created.');
          };
          ipc.once('error', retry);
          ipc.once('connect', () => {
            ipc.removeListener('error', retry);
            if (session.closed || session.stopping) return ipc.destroy();
            session.connecting = null;
            attach(ipc);
          });
        };
        attempt();
      } else {
        if (!session.child.stdio[3]) throw new Error('IPC unavailable');
        attach(session.child.stdio[3]);
      }
    } catch {
      if (session.child) fail(session, 'The mpv control connection could not be created.');
      else {
        const message = `mpv could not start. ${startupHelp}`;
        emit(session, { status: 'error', error: message });
        session.rejectStartup(new Error(message));
        finish(session, null);
      }
    }
    return session.ready;
  }
  async function control(action) {
    if (action === 'stop') return stop();
    if (action !== 'toggle-pause') throw new Error('Unsupported player action.');
    if (!active || !active.loaded || active.stopping || active.closed) throw new Error('No video is playing in mpv.');
    if (!send(active, ['cycle', 'pause'])) throw new Error('The connection to mpv is unavailable.');
    return { ...current };
  }
  return { status, open, stop, control, state: () => ({ ...current }) };
}

module.exports = { createMpvPlayer };
