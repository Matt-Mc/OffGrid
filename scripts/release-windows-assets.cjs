const fs = require('node:fs');
const path = require('node:path');
const { hashFile } = require('./check-mpv-bundle.cjs');

async function prepare() {
  const { version } = require('../package.json');
  const name = `Offgrid-${version}-win-x64.exe`;
  const destination = path.resolve('release/publish-windows');
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length) throw new Error('Windows staging must be empty.');
  fs.copyFileSync(path.resolve('release', name), path.join(destination, name));
  fs.writeFileSync(path.join(destination, 'WINDOWS-RELEASE-NOTES.md'), `Offgrid ${version} for Windows x64\n\nRun the installer and follow the setup prompts. Player, yt-dlp and FFmpeg setup requires internet access on first launch. Before going offline, check that the player and download components are ready in Settings and try playing a saved video.\n\nThis Windows installer is unsigned. Windows ARM64 and 32-bit builds are not included. Updating uses a verified installer; follow its prompts to finish.\n`);
  const lines = [];
  for (const file of [name, 'WINDOWS-RELEASE-NOTES.md']) lines.push(`${await hashFile(path.join(destination, file))}  ${file}`);
  fs.writeFileSync(path.join(destination, 'SHA256SUMS-windows'), lines.join('\n') + '\n');
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
