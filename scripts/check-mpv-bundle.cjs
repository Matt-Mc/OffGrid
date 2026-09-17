const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid mpv manifest path.');
  const resolved = fs.realpathSync(path.join(root, relative));
  if (!resolved.startsWith(fs.realpathSync(root) + path.sep)) throw new Error('mpv manifest path escapes the runtime.');
  return resolved;
}
async function validateBundle(root = path.resolve('vendor/mpv'), releaseDirectory = path.resolve('release'), architecture = process.arch) {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.platform !== 'darwin' || manifest.architecture !== architecture || manifest.executable !== 'bin/mpv') throw new Error('mpv bundle does not match the target macOS architecture.');
  if (!Array.isArray(manifest.files) || !manifest.files.some(file => file.path === 'bin/mpv') || !Array.isArray(manifest.formulas) || !manifest.formulas.length) throw new Error('Incomplete mpv runtime manifest.');
  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new Error('Duplicate mpv manifest path.');
    seen.add(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || await hashFile(inside(root, file.path)) !== file.sha256) throw new Error(`mpv runtime hash mismatch: ${file.path}`);
  }
  fs.accessSync(inside(root, 'bin/mpv'), fs.constants.X_OK);
  if (!fs.readFileSync(inside(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8').trim()) throw new Error('mpv license notices are missing.');
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'sources-manifest.json'), 'utf8'));
  if (sources.complete !== true || sources.binaryManifestSha256 !== await hashFile(manifestPath)) throw new Error('Collect corresponding mpv sources for this exact runtime before packaging.');
  const expected = manifest.formulas.map(formula => `${formula.name}@${formula.version}`).sort();
  const actual = (sources.formulas || []).map(formula => `${formula.name}@${formula.version}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('mpv source archive does not cover every bundled formula.');
  for (const formula of manifest.formulas) {
    const recorded = sources.formulas.find(value => value.name === formula.name && value.version === formula.version);
    if (recorded.recipeSha256 !== await hashFile(formula.recipePath)) throw new Error(`mpv source recipe changed: ${formula.name}`);
  }
  if (typeof sources.archive !== 'string' || !/^mpv-sources-[\w.-]+\.tar\.gz$/.test(sources.archive)) throw new Error('Invalid mpv source archive name.');
  const archive = inside(releaseDirectory, sources.archive);
  if (await hashFile(archive) !== sources.sha256) throw new Error('mpv corresponding-source archive hash mismatch.');
  return { manifest, sources, archive };
}
module.exports = async context => {
  if (context.electronPlatformName === 'win32') {
    if (require('builder-util').Arch[context.arch] !== 'x64') throw new Error('Windows currently supports x64 only.');
    // Windows provisions a pinned, verified upstream runtime on first launch.
    // It does not redistribute the Homebrew runtime or its source archive.
    return;
  }
  if (context.electronPlatformName !== 'darwin') throw new Error('Bundled installers currently target macOS only.');
  const architecture = require('builder-util').Arch[context.arch];
  await validateBundle(path.join(context.packager.projectDir, 'vendor/mpv'), path.join(context.packager.projectDir, 'release'), architecture);
};
module.exports.validateBundle = validateBundle;
module.exports.hashFile = hashFile;
