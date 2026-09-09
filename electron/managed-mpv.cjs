const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Baseline x86_64 build (not x86_64-v3). Update the archive AND extracted hashes
// together after testing a new upstream release. No upstream scripts are executed.
const RUNTIME = Object.freeze({
  version: '20260903',
  url: 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20260903/mpv-x86_64-20260903-git-69e63f425a.7z',
  size: 33768341,
  sha256: '418dbfb5feb851cbed33d6c05d8481ba71802621bfd6efe8974522b28d42ac97',
  files: {
    'mpv.exe': '4a0bc712bc98e6f80cd980930b74b6ac202b8ccf2041e887adab69906f82731c',
    'd3dcompiler_43.dll': '4b074a3976399dc735484f5d43d04b519b7bdee8ac719d9ab8ed6bd4e6be0345',
  },
});

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyDirectory(directory, runtime) {
  if (!(await fs.lstat(directory)).isDirectory() || await fs.realpath(directory) !== directory) throw new Error('Invalid runtime directory.');
  for (const [name, hash] of Object.entries(runtime.files)) {
    const file = path.join(directory, name);
    if (!(await fs.lstat(file)).isFile() || await hashFile(file) !== hash) throw new Error('Player verification failed.');
  }
}
function createManagedMpv({ directory, fetch = globalThis.fetch, extract = promisify(execFile), runtime = RUNTIME, onChange = () => {} } = {}) {
  let pending, controller, disposed = false;
  let value = { available: false, path: null, source: 'managed', message: 'The Windows player needs first-time setup. Connect to the internet and refresh the player.' };
  const status = () => ({ ...value });
  function ensure() {
    if (disposed) return Promise.resolve(status());
    if (pending) return pending;
    controller = new AbortController();
    const signal = controller.signal;
    pending = (async () => {
      let stage;
      const timer = setTimeout(() => controller.abort(), 120_000);
      try {
        // Resolve legitimate aliases in the parent (macOS /var and Windows
        // short names/junctions), while still rejecting a replaced runtime root.
        await fs.mkdir(directory, { recursive: true });
        const root = path.join(await fs.realpath(directory), `mpv-windows-${runtime.version}`);
        try { await verifyDirectory(root, runtime); }
        catch {
          value = { ...value, available: false, path: null, message: 'Setting up the Windows player… Keep Offgrid open and connected to the internet.' };
          await fs.mkdir(directory, { recursive: true });
          stage = await fs.realpath(await fs.mkdtemp(path.join(directory, 'mpv-setup-')));
          let url = runtime.url, response;
          for (let redirects = 0; redirects <= 3; redirects++) {
            response = await fetch(url, { redirect: 'manual', signal, credentials: 'omit' });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            await response.body?.cancel();
            const location = response.headers.get('location');
            if (!location || redirects === 3) throw new Error('Invalid player redirect.');
            const next = new URL(location, url);
            if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash
              || !['github.com', 'release-assets.githubusercontent.com'].includes(next.hostname)
              || (next.hostname === 'github.com' && next.href !== runtime.url)) throw new Error('Invalid player redirect.');
            url = next.href;
          }
          if (response.status !== 200 || !response.body) throw new Error('Player download failed.');
          const archive = path.join(stage, 'runtime.7z');
          const file = await fs.open(archive, 'wx');
          const hash = crypto.createHash('sha256');
          let size = 0;
          try {
            for await (const bytes of response.body) {
              signal.throwIfAborted();
              size += bytes.length;
              if (size > runtime.size) throw new Error('Player archive too large.');
              hash.update(bytes);
              let offset = 0;
              while (offset < bytes.length) {
                const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
                if (!bytesWritten) throw new Error('Player archive write failed.');
                offset += bytesWritten;
              }
            }
          } finally { await file.close(); }
          if (size !== runtime.size || hash.digest('hex') !== runtime.sha256) throw new Error('Player archive verification failed.');
          signal.throwIfAborted();
          const tar = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
          await extract(tar, ['-xf', archive, '-C', stage, ...Object.keys(runtime.files)], { windowsHide: true, timeout: 30_000, signal });
          await fs.unlink(archive);
          await verifyDirectory(stage, runtime);
          signal.throwIfAborted();
          // Only this fixed, application-owned runtime directory is replaced.
          // A symlink is removed itself; its destination is never traversed.
          await fs.rm(root, { recursive: true, force: true });
          await fs.rename(stage, root);
          stage = null;
        }
        value = { available: true, path: path.join(root, 'mpv.exe'), source: 'managed', message: 'The Windows player is ready for offline playback.' };
      } catch {
        value = { available: false, path: null, source: 'managed', message: 'Windows player setup could not finish. Connect to the internet and refresh the player in Settings. Windows 10 version 1803 or later is required.' };
      } finally {
        clearTimeout(timer);
        if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
        if (!disposed) { try { onChange(status()); } catch {} }
      }
      return status();
    })().finally(() => { pending = null; controller = null; });
    return pending;
  }
  async function dispose() { disposed = true; controller?.abort(); await pending; }
  return { ensure, status, dispose };
}
module.exports = { createManagedMpv, RUNTIME, verifyDirectory };
