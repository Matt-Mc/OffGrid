const fs = require('node:fs');
const path = require('node:path');
const { validateBundle, hashFile } = require('./check-mpv-bundle.cjs');

async function prepareAssets() {
  const { version } = require('../package.json');
  const { manifest, sources, archive } = await validateBundle();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Publish a stable semantic version.');
  const destination = path.resolve('release/publish');
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length) throw new Error('Release staging is not empty; remove old staging before preparing new assets.');
  const dmgName = `Offgrid-${version}-${manifest.architecture}.dmg`;
  const files = [
    [path.resolve('release', dmgName), dmgName],
    [archive, sources.archive],
    [path.resolve('vendor/mpv/manifest.json'), 'mpv-runtime-manifest.json'],
  ];
  const checksums = [];
  for (const [source, name] of files) {
    if (!fs.statSync(source).isFile() || fs.statSync(source).size >= 2_000_000_000) throw new Error('Release assets must be files smaller than 2 GB.');
    fs.copyFileSync(source, path.join(destination, name));
    checksums.push(`${await hashFile(path.join(destination, name))}  ${name}`);
  }
  const notes = `Offgrid ${version} for macOS Apple Silicon\n\n- mpv and its playback libraries are included. No Homebrew or separate mpv installation is required.\n- Minimum macOS version required by the bundled runtime: ${manifest.minimumMacOS || 'see runtime manifest'}.\n- Includes Plex and Jellyfin original-file downloads, offline library playback, and the persistent download queue.\n\nThis personal build is ad hoc signed and is not Apple-notarized. macOS may show a security warning. Windows and Linux installers are not included.\n\nThe mpv corresponding-source archive and build recipes accompany the installer. Offgrid source is MIT; third-party runtime components retain their own licenses. The runtime manifest records input hashes before application signing; SHA256SUMS verifies the final downloadable assets.\n`;
  fs.writeFileSync(path.join(destination, 'RELEASE-NOTES.md'), notes);
  checksums.push(`${await hashFile(path.join(destination, 'RELEASE-NOTES.md'))}  RELEASE-NOTES.md`);
  fs.writeFileSync(path.join(destination, 'SHA256SUMS'), checksums.join('\n') + '\n');
  console.log(`Prepared ${files.length} verified release assets in ${destination}`);
}
if (require.main === module) prepareAssets().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareAssets };
