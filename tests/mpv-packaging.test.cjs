const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateBundle, hashFile } = require('../scripts/check-mpv-bundle.cjs');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'mpv'), release = path.join(directory, 'release');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true }); fs.mkdirSync(release);
  const binary = path.join(root, 'bin/mpv'), recipe = path.join(directory, 'mpv.rb');
  fs.writeFileSync(binary, '# fixture binary', { mode: 0o755 }); fs.writeFileSync(recipe, '# fixture recipe');
  const manifest = { platform: 'darwin', architecture: 'arm64', executable: 'bin/mpv', files: [{path:'bin/mpv',sha256:await hashFile(binary)}], formulas:[{name:'mpv',version:'1',recipePath:recipe}] };
  const manifestFile = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), 'Fixture notice');
  const archive = 'mpv-sources-0.3.0-arm64.tar.gz'; fs.writeFileSync(path.join(release, archive), 'Fixture source archive');
  const sources = {complete:true,archive,sha256:await hashFile(path.join(release,archive)),binaryManifestSha256:await hashFile(manifestFile),formulas:[{name:'mpv',version:'1',recipeSha256:await hashFile(recipe)}]};
  const saveSources = () => fs.writeFileSync(path.join(root, 'sources-manifest.json'), JSON.stringify(sources)); saveSources();
  return {root,release,binary,recipe,sources,saveSources,manifest,manifestFile};
}
test('packaging requires matching runtime, exact recipes, and intact corresponding source archive', async t => {
  const f = await fixture(t);
  const result = await validateBundle(f.root,f.release,'arm64'); assert.equal(result.manifest.executable,'bin/mpv');
  await assert.rejects(validateBundle(f.root,f.release,'x64'), /architecture/);
  fs.appendFileSync(f.recipe, 'modified');
  await assert.rejects(validateBundle(f.root,f.release,'arm64'), /recipe changed/);
});
test('packaging rejects incomplete or stale source collection and changed binary bytes', async t => {
  const f = await fixture(t);
  f.sources.complete=false;f.saveSources();
  await assert.rejects(validateBundle(f.root,f.release,'arm64'), /exact runtime/);
  f.sources.complete=true;f.sources.formulas=[];f.saveSources();
  await assert.rejects(validateBundle(f.root,f.release,'arm64'), /every bundled formula/);
  fs.appendFileSync(f.binary, 'modified');
  await assert.rejects(validateBundle(f.root,f.release,'arm64'), /runtime hash mismatch/);
});
test('packaging rejects missing or corrupted source assets and escaping manifest paths', async t => {
  const f = await fixture(t);
  fs.appendFileSync(path.join(f.release,f.sources.archive), 'corrupt');
  await assert.rejects(validateBundle(f.root,f.release,'arm64'), /archive hash mismatch/);
  f.manifest.files.push({path:'../mpv.rb',sha256:await hashFile(f.recipe)});fs.writeFileSync(f.manifestFile,JSON.stringify(f.manifest));
  await assert.rejects(validateBundle(f.root,f.release,'arm64'), /Invalid mpv manifest path/);
});
