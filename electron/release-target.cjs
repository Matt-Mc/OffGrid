function releaseTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return { suffix: 'arm64.dmg', checksums: 'SHA256SUMS', format: 'dmg' };
  if (platform === 'win32' && arch === 'x64') return { suffix: 'win-x64.exe', checksums: 'SHA256SUMS-windows', format: 'exe' };
  return null;
}
module.exports = { releaseTarget };
