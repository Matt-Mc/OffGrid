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
const EXTRACTOR = Object.freeze({
  url: 'https://github.com/ip7z/7zip/releases/download/26.03/7zr.exe',
  size: 602624,
  sha256: 'ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d',
});
const VULKAN = Object.freeze({
  url: 'https://sdk.lunarg.com/sdk/download/1.4.357.0/windows/VulkanRT-X64-1.4.357.0-Components.zip',
  size: 18134567,
  sha256: 'a14672efed15aafc7f5a16572d35cd3a3416eadf670aeee3cdf50ee32d5fbf83',
  files: { 'vulkan-1.dll': 'cd862090370454630b31b174e3d4eb474fda38ea034998d1fe1767b0c99a8696' },
});

async function extractVulkan(archive, directory, signal) {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Use Windows' ZIP support only. The older system tar lacks the LZMA codec
  // needed for mpv's 7z archive. Paths are data in the environment, never code.
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[System.IO.Compression.ZipFile]::OpenRead($env:OFFGRID_VULKAN_ZIP); try { foreach($file in @('x64/vulkan-1.dll','VulkanRT-License.txt')) { $entry=$zip.GetEntry('VulkanRT-X64-1.4.357.0-Components/'+$file); if(!$entry){throw 'Missing Vulkan component'}; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry,[System.IO.Path]::Combine($env:OFFGRID_VULKAN_DIR,[System.IO.Path]::GetFileName($file))) } } finally { $zip.Dispose() }";
  await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 30_000, signal,
    env: { ...process.env, OFFGRID_VULKAN_ZIP: archive, OFFGRID_VULKAN_DIR: directory },
  });
}

async function downloadPinned(fetch, asset, destination, signal) {
  let url = asset.url, response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetch(url, { redirect: 'manual', signal, credentials: 'omit' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw new Error('Invalid player redirect.');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash
      || !['github.com', 'release-assets.githubusercontent.com'].includes(next.hostname)
      || (next.hostname === 'github.com' && next.href !== asset.url)) throw new Error('Invalid player redirect.');
    url = next.href;
  }
  if (response.status !== 200 || !response.body) throw new Error('Player download failed.');
  const file = await fs.open(destination, 'wx');
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const bytes of response.body) {
      signal.throwIfAborted();
      size += bytes.length;
      if (size > asset.size) throw new Error('Player download too large.');
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw new Error('Player download write failed.');
        offset += bytesWritten;
      }
    }
  } finally { await file.close(); }
  if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Player download verification failed.');
}

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
function createManagedMpv({ directory, fetch = globalThis.fetch, extract = promisify(execFile), runtime = RUNTIME, extractor = EXTRACTOR, vulkan = VULKAN, extractZip = extractVulkan, onChange = () => {}, onError = () => {} } = {}) {
  const completeRuntime = { ...runtime, files: { ...runtime.files, ...vulkan?.files } };
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
        try { await verifyDirectory(root, completeRuntime); }
        catch {
          value = { ...value, available: false, path: null, message: 'Setting up the Windows player… Keep Offgrid open and connected to the internet.' };
          await fs.mkdir(directory, { recursive: true });
          stage = await fs.realpath(await fs.mkdtemp(path.join(directory, 'mpv-setup-')));
          const archive = path.join(stage, 'runtime.7z');
          const extractorPath = path.join(stage, '7zr.exe');
          await downloadPinned(fetch, runtime, archive, signal);
          await downloadPinned(fetch, extractor, extractorPath, signal);
          signal.throwIfAborted();
          await extract(extractorPath, ['x', archive, `-o${stage}`, '-y', '--', ...Object.keys(runtime.files)], { windowsHide: true, timeout: 30_000, signal });
          await fs.unlink(archive);
          await fs.unlink(extractorPath);
          if (vulkan) {
            const zip = path.join(stage, 'vulkan.zip');
            await downloadPinned(fetch, vulkan, zip, signal);
            await extractZip(zip, stage, signal);
            await fs.unlink(zip);
          }
          await verifyDirectory(stage, completeRuntime);
          signal.throwIfAborted();
          // Only this fixed, application-owned runtime directory is replaced.
          // A symlink is removed itself; its destination is never traversed.
          await fs.rm(root, { recursive: true, force: true });
          await fs.rename(stage, root);
          stage = null;
        }
        value = { available: true, path: path.join(root, 'mpv.exe'), source: 'managed', message: 'The Windows player is ready for offline playback.' };
      } catch (error) {
        try { onError(error); } catch {}
        value = { available: false, path: null, source: 'managed', message: 'Windows player setup could not finish. Connect to the internet and refresh the player in Settings.' };
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
