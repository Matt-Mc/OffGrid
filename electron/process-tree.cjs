const { execFile } = require('node:child_process');
const path = require('node:path');

// Await the tree termination before removing temporary files or starting another job.
function killProcessTree(child, { platform = process.platform, execute = execFile, kill = process.kill } = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    try { child.kill('SIGKILL'); } catch {}
    return Promise.resolve();
  }
  if (platform !== 'win32') {
    try { kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execute(executable, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, error => {
      // 128 means the process already exited. Other failures must not permit cleanup
      // to race a descendant which could still be writing to the download directory.
      if (error && error.code !== 128) reject(new Error('Could not stop the download processes. Close Offgrid before retrying.'));
      else resolve();
    });
  });
}
module.exports = { killProcessTree };
