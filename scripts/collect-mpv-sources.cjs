#!/usr/bin/env node
'use strict';

// Collect corresponding source for the exact Homebrew kegs copied by bundle-mpv.
// Run only against trusted, locally installed Homebrew formula recipes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const bundleDir = path.join(root, 'vendor/mpv');
const outputDir = path.join(root, 'release');
const sourceDir = path.join(root, 'vendor/mpv-sources');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
const safeName = value => String(value).replace(/[^a-zA-Z0-9_.@+-]/g, '_');

// Let Homebrew evaluate its own DSL instead of regex-parsing recipes or using
// today's online formula metadata, which can differ from the installed bottle.
const recipeReader = String.raw`
require "formulary"
require "json"
def describe_resource(resource, name)
  {name: name, url: resource.url, mirrors: resource.mirrors, sha256: resource.checksum.to_s, specs: resource.specs,
   patches: resource.patches.map { |patch| describe_patch(patch) }}
end
def describe_patch(patch)
  if patch.class.to_s == "LocalPatch"
    return {name: "patch", localFile: patch.file.to_s, strip: patch.strip}
  end
  if patch.respond_to?(:contents)
    return {name: "patch", inline: patch.contents, strip: patch.strip}
  end
  raise "Unsupported patch source" unless patch.respond_to?(:resource)
  {name: "patch", url: patch.resource.url, sha256: patch.resource.checksum.to_s,
   specs: patch.resource.specs, strip: patch.strip}
end
result = ARGV.map do |recipe|
  formula = Formulary.factory(Pathname.new(recipe))
  raise "HEAD formula cannot be released without exact source provenance" unless formula.stable
  {name: formula.name, version: formula.pkg_version.to_s, license: formula.license,
   homepage: formula.homepage,
   resources: [describe_resource(formula.stable.resource, "source")] +
      formula.stable.resources.values.map { |resource| describe_resource(resource, resource.name) },
   patches: formula.stable.patches.map { |patch| describe_patch(patch) }}
end
puts JSON.generate(result)
`;

function validateResource(resource) {
  if (typeof resource.inline === 'string' && resource.inline.length) return;
  const url = new URL(resource.url);
  if (url.protocol !== 'https:') throw new Error(`Source must use HTTPS: ${resource.url}`);
  if (url.username || url.password) throw new Error('Source URLs must not contain credentials.');
  if (!/^[a-f0-9]{64}$/i.test(resource.sha256 || '') &&
      !/^[a-f0-9]{40}$/i.test(resource.specs?.revision || '')) {
    throw new Error(`Source has no SHA256 or pinned git commit: ${resource.url}`);
  }
  for (const patch of resource.patches || []) validateResource(patch);
}

function bottleMatches(metadata, receipt, installed) {
  if (metadata.annotations?.['org.opencontainers.image.title'] !== installed.name) return false;
  return (metadata.manifests || []).some(entry => {
    const tab = JSON.parse(entry.annotations?.['sh.brew.tab'] || '{}');
    const architecture = { x86_64: 'amd64', aarch64: 'arm64' }[receipt.arch] || receipt.arch;
    return tab.source_modified_time === receipt.source_modified_time &&
      tab.homebrew_version === receipt.homebrew_version && tab.compiler === receipt.compiler &&
      entry.platform?.architecture === architecture && entry.platform?.os === 'darwin';
  });
}

function fetchBottleProvenance(receipt, installed) {
  if (receipt.source?.tap !== 'homebrew/core' || !/^[a-z0-9@+._-]+$/.test(installed.name) || !/^[a-zA-Z0-9._+-]+$/.test(installed.version)) {
    throw new Error('Automatic bottle provenance recovery supports homebrew/core stable formulas only.');
  }
  const repository = `homebrew/core/${installed.name.replaceAll('@', '/')}`;
  const curl = (url, token) => {
    const args = ['--silent', '--show-error', '--fail', '--connect-timeout', '15', '--max-time', '45', '--proto', '=https'];
    let input;
    if (token) {
      args.push('--config', '-');
      input = `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\nheader = "Accept: application/vnd.oci.image.index.v1+json"\n`;
    }
    return JSON.parse(run('curl', [...args, url], { input }));
  };
  const token = curl(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`).token;
  if (!token || /[\r\n]/.test(token)) throw new Error('Invalid public Homebrew registry token.');
  // Bottle rebuild numbers are not persisted in all Homebrew receipts. Probe a
  // bounded set of this exact installed version, never the latest formula.
  for (let rebuild = 0; rebuild <= 10; rebuild++) {
    const tag = `${installed.version}${rebuild ? `-${rebuild}` : ''}`;
    let metadata;
    try { metadata = curl(`https://ghcr.io/v2/${repository}/manifests/${tag}`, token); } catch { continue; }
    if (bottleMatches(metadata, receipt, installed)) return metadata;
  }
  throw new Error(`Could not recover the exact installed bottle provenance for ${installed.name} ${installed.version}.`);
}

function findBottleProvenance(receipt, installed) {
  const cache = path.join(run('brew', ['--cache']).trim(), 'downloads');
  const candidates = fs.existsSync(cache) ? fs.readdirSync(cache).filter(file => file.endsWith('.bottle_manifest.json') && file.includes(`--${installed.name.replaceAll('@', '-')}-`)) : [];
  let metadata;
  for (const candidate of candidates) {
    const parsed = JSON.parse(fs.readFileSync(path.join(cache, candidate), 'utf8'));
    if (bottleMatches(parsed, receipt, installed)) { metadata = parsed; break; }
  }
  return metadata || fetchBottleProvenance(receipt, installed);
}

function resolveLocalPatches(recipe, receipt, installed) {
  const patches = [...recipe.patches, ...recipe.resources.flatMap(resource => resource.patches || [])];
  if (!patches.some(patch => patch.localFile)) return;
  const metadata = findBottleProvenance(receipt, installed);
  const revision = metadata.annotations?.['org.opencontainers.image.revision'];
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Bottle has no pinned Homebrew source revision.');
  recipe.bottleProvenance = metadata;
  for (const patch of patches.filter(patch => patch.localFile)) {
    if (!/^Patches\/[a-zA-Z0-9_./+-]+$/.test(patch.localFile) || patch.localFile.split('/').includes('..')) throw new Error('Unsafe Homebrew patch path.');
    patch.url = `https://raw.githubusercontent.com/Homebrew/homebrew-core/${revision}/${patch.localFile}`;
    patch.specs = { revision };
    patch.gitFile = true;
  }
}

function compiledBuildInputsFor(formula) {
  if (formula === 'libplacebo') return ['fast_float', 'vulkan-headers'];
  if (formula === 'vulkan-loader') return ['vulkan-headers'];
  return [];
}

function addCompiledBuildInputs(recipe, receipt, installed) {
  // These are code/header inputs incorporated into the runtime, not standalone
  // compiler tools. Homebrew installs bottles without these build dependencies.
  const inputs = compiledBuildInputsFor(installed.name);
  if (!inputs.length) return;
  const metadata = findBottleProvenance(receipt, installed);
  const revision = metadata.annotations?.['org.opencontainers.image.revision'];
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Build input provenance has no immutable core revision.');
  recipe.bottleProvenance = metadata;
  const cache = path.join(sourceDir, 'build-input-recipes', revision);
  fs.mkdirSync(cache, { recursive: true });
  for (const name of inputs) {
    const recipePath = path.join(cache, `${name}.rb`);
    const recipeUrl = `https://raw.githubusercontent.com/Homebrew/homebrew-core/${revision}/Formula/${name[0]}/${name}.rb`;
    if (!fs.existsSync(recipePath)) {
      run('curl', ['--silent', '--show-error', '--fail', '--location', '--retry', '2', '--connect-timeout', '15', '--max-time', '60', '--proto', '=https', '--proto-redir', '=https', '--output', recipePath, recipeUrl]);
    }
    const [input] = JSON.parse(run('brew', ['ruby', '-e', recipeReader, '--', recipePath], {
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_DEVELOPER: '1' },
    }));
    if (input.name !== name) throw new Error('Compiled build input formula name mismatch.');
    const provenance = { name, version: input.version, license: input.license, recipeUrl, recipeSha256: hash(recipePath), coreRevision: revision };
    recipe.resources.push({ name: `build-input-${name}-recipe`, inline: fs.readFileSync(recipePath, 'utf8'), inlineFilename: `${name}.rb`, buildInput: provenance });
    for (const resource of [...input.resources, ...input.patches]) {
      if (resource.localFile) throw new Error(`Unresolved local patch in compiled build input ${name}`);
      recipe.resources.push({ ...resource, name: `build-input-${name}-${resource.name}`, buildInput: provenance });
    }
  }
}

function readPlan(manifest) {
  if (!Array.isArray(manifest.formulas) || !manifest.formulas.length) throw new Error('Bundle manifest has no formula provenance.');
  for (const formula of manifest.formulas) {
    for (const file of [formula.recipePath, formula.receiptPath]) {
      if (!file || !fs.statSync(file).isFile()) throw new Error(`Missing installed formula provenance for ${formula.name}`);
    }
  }
  const recipes = JSON.parse(run('brew', ['ruby', '-e', recipeReader, '--', ...manifest.formulas.map(f => f.recipePath)], {
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_DEVELOPER: '1' },
  }));
  return recipes.map((recipe, index) => {
    const installed = manifest.formulas[index];
    if (recipe.name !== installed.name || recipe.version !== installed.version) {
      throw new Error(`Installed recipe differs from bundled binary: ${installed.name} ${installed.version}`);
    }
    const receipt = JSON.parse(fs.readFileSync(installed.receiptPath, 'utf8'));
    if (receipt.source?.spec !== 'stable') throw new Error(`Non-stable Homebrew build: ${installed.name}`);
    resolveLocalPatches(recipe, receipt, installed);
    addCompiledBuildInputs(recipe, receipt, installed);
    for (const resource of [...recipe.resources, ...recipe.patches]) validateResource(resource);
    return { ...recipe, installed };
  });
}

function download(resource, directory, index) {
  const prefix = `${String(index).padStart(3, '0')}-${safeName(resource.name || 'source')}`;
  const revision = resource.specs?.revision;
  let filename;
  if (typeof resource.inline === 'string') {
    filename = `${prefix}-${safeName(resource.inlineFilename || "embedded.patch")}`;
    fs.writeFileSync(path.join(directory, filename), resource.inline);
  } else if (resource.gitFile) {
    filename = `${prefix}-${safeName(path.basename(resource.localFile))}`;
    run('curl', ['--silent', '--show-error', '--fail', '--location', '--retry', '3', '--proto', '=https', '--proto-redir', '=https', '--output', path.join(directory, filename), resource.url], { stdio: ['ignore', 'ignore', 'inherit'] });
  } else if (/^[a-f0-9]{64}$/i.test(resource.sha256 || '')) {
    const urlName = path.basename(new URL(resource.url).pathname) || 'source.tar';
    filename = `${prefix}-${safeName(urlName)}`;
    const dest = path.join(directory, filename);
    if (!fs.existsSync(dest) || hash(dest) !== resource.sha256.toLowerCase()) {
      const pending = `${dest}.partial`;
      let downloaded = false;
      const urls = [...new Set([resource.url, ...(resource.mirrors || [])])].filter(url => url.startsWith('https://'));
      for (const url of urls) {
        try {
          run('curl', ['--silent', '--show-error', '--fail', '--location', '--retry', '1', '--connect-timeout', '20', '--max-time', '120', '--proto', '=https', '--proto-redir', '=https', '--output', pending, url], { stdio: ['ignore', 'ignore', 'inherit'] });
          downloaded = true;
          break;
        } catch { console.warn(`Source endpoint unavailable: ${url}`); }
      }
      if (!downloaded) throw new Error(`All recorded source endpoints failed: ${resource.url}`);
      if (hash(pending) !== resource.sha256.toLowerCase()) {
        fs.rmSync(pending, { force: true });
        throw new Error(`Source checksum mismatch: ${resource.url}`);
      }
      fs.renameSync(pending, dest);
    }
  } else {
    filename = `${prefix}-${revision}.tar.gz`;
    const dest = path.join(directory, filename);
    const stamp = `${dest}.json`;
    if (!fs.existsSync(dest) || !fs.existsSync(stamp) || JSON.parse(fs.readFileSync(stamp)).sha256 !== hash(dest) || JSON.parse(fs.readFileSync(stamp)).url !== resource.url) {
      const checkout = fs.mkdtempSync(path.join(directory, '.git-source-'));
      try {
        const git = args => run('git', ['-c', 'protocol.file.allow=never', '-C', checkout, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        git(['init', '--quiet']);
        git(['remote', 'add', 'origin', resource.url]);
        git(['fetch', '--quiet', '--depth=1', 'origin', revision]);
        git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
        if (git(['rev-parse', 'HEAD']).trim() !== revision) throw new Error('Source git revision mismatch.');
        git(['submodule', 'update', '--init', '--recursive', '--depth=1']);
        const submodules = git(['submodule', 'status', '--recursive']).trim();
        if (submodules.split('\n').some(line => /^[-+U]/.test(line))) throw new Error('Unresolved source submodules.');
        run('tar', ['--exclude=.git', '-czf', dest, '-C', checkout, '.']);
        fs.writeFileSync(stamp, JSON.stringify({ revision, url: resource.url, submodules, sha256: hash(dest) }, null, 2));
      } finally { fs.rmSync(checkout, { recursive: true, force: true }); }
    }
  }
  return { ...resource, file: filename, sha256: hash(path.join(directory, filename)) };
}

function collectNotices(archives, directory, licenseDir) {
  fs.rmSync(licenseDir, { recursive: true, force: true });
  fs.mkdirSync(licenseDir, { recursive: true });
  let count = 0;
  for (const archive of archives) {
    if (archive.name === 'patch' || typeof archive.inline === 'string') continue;
    const filename = path.join(directory, archive.file);
    let entries;
    try { entries = run('tar', ['-tf', filename]).split(/\r?\n/); } catch { continue; }
    for (const entry of entries) {
      if (!/(?:^|\/)(?:licen[sc]e|copying|copyright|notice)(?:[._-][^/]*)?$/i.test(entry)) continue;
      // Read content through tar without extracting untrusted filesystem paths.
      const content = execFileSync('tar', ['-xOf', filename, '--', entry], { maxBuffer: 16 * 1024 * 1024 });
      if (!content.length) continue;
      const name = `${String(++count).padStart(3, '0')}-${safeName(archive.name)}-${safeName(entry)}`;
      fs.writeFileSync(path.join(licenseDir, name), content);
    }
  }
  if (!count) throw new Error(`No license/copyright notices found in sources for ${path.basename(directory)}`);
  return count;
}

function main() {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const completionPath = path.join(bundleDir, 'sources-manifest.json');
  if (!process.argv.includes('--plan-only')) fs.rmSync(completionPath, { force: true });
  const plan = readPlan(manifest);
  console.log(`Source plan: ${plan.length} exact installed Homebrew formulas.`);
  if (process.argv.includes('--plan-only')) {
    console.log(plan.map(f => `${f.name} ${f.version}: ${f.resources.length} source(s), ${f.patches.length} patch(es)`).join('\n'));
    return;
  }
  fs.mkdirSync(sourceDir, { recursive: true });
  const licenses = path.join(bundleDir, 'licenses');
  fs.mkdirSync(licenses, { recursive: true });
  const results = [];
  for (const formula of plan) {
    console.log(`Collecting ${formula.name} ${formula.version}`);
    const directory = path.join(sourceDir, safeName(`${formula.name}-${formula.version}`));
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(formula.installed.recipePath, path.join(directory, `${safeName(formula.name)}.rb`));
    fs.copyFileSync(formula.installed.receiptPath, path.join(directory, 'INSTALL_RECEIPT.json'));
    if (formula.bottleProvenance) fs.writeFileSync(path.join(directory, 'bottle-provenance.json'), JSON.stringify(formula.bottleProvenance, null, 2));
    let index = 0;
    const archives = [];
    for (const resource of [...formula.resources, ...formula.patches]) {
      archives.push(download(resource, directory, index++));
      for (const patch of resource.patches || []) archives.push(download(patch, directory, index++));
    }
    const retained = new Set([`${safeName(formula.name)}.rb`, 'INSTALL_RECEIPT.json', 'bottle-provenance.json', 'sources.json', ...archives.flatMap(archive => [archive.file, `${archive.file}.json`])]);
    for (const file of fs.readdirSync(directory)) {
      if (!retained.has(file)) fs.rmSync(path.join(directory, file), { recursive: true, force: true });
    }
    const licenseCount = collectNotices(archives, directory, path.join(licenses, safeName(formula.name)));
    const buildInputs = [...new Map(formula.resources.filter(resource => resource.buildInput).map(resource => [resource.buildInput.name, resource.buildInput])).values()];
    const record = { name: formula.name, version: formula.version, license: formula.license, homepage: formula.homepage, buildInputs, recipeSha256: hash(formula.installed.recipePath), archives, licenseCount };
    fs.writeFileSync(path.join(directory, 'sources.json'), `${JSON.stringify(record, null, 2)}\n`);
    results.push(record);
  }
  const version = require('../package.json').version;
  const arch = manifest.arch || process.arch;
  const archiveName = `mpv-sources-${version}-${arch}.tar.gz`;
  const notice = `Offgrid bundled mpv runtime\n\nOffgrid's own code is MIT licensed. mpv and its libraries retain their own licenses.\nmpv is run as a separate process; the bundled Homebrew build includes GPL components.\n\nCorresponding source, exact Homebrew build recipes, patches, resources and receipts\nare in ${archiveName}, distributed alongside this installer at:\nhttps://github.com/Matt-Mc/OffGrid/releases\n\nBinary provenance: manifest.json. Individual license and copyright texts: licenses/.\n\n${results.map(f => `${f.name} ${f.version}\n${JSON.stringify(f.license)}\n${f.homepage}\n${f.buildInputs.map(input => `Compiled build input: ${input.name} ${input.version}, ${JSON.stringify(input.license)}\n${input.recipeUrl}\n`).join('')}`).join('\n')}`;
  fs.writeFileSync(path.join(bundleDir, 'THIRD-PARTY-NOTICES.txt'), notice);
  fs.writeFileSync(path.join(sourceDir, 'sources.json'), `${JSON.stringify(results, null, 2)}\n`);
  fs.copyFileSync(manifestPath, path.join(sourceDir, 'binary-manifest.json'));
  fs.copyFileSync(path.join(root, 'docs/third-party.md'), path.join(sourceDir, 'BUILDING.md'));
  fs.copyFileSync(__filename, path.join(sourceDir, 'collect-mpv-sources.cjs'));
  fs.copyFileSync(path.join(root, 'scripts/bundle-mpv.cjs'), path.join(sourceDir, 'bundle-mpv.cjs'));
  fs.mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, archiveName);
  // Select only this bundle's formula directories; old download cache is excluded.
  run('tar', ['-czf', archivePath, '-C', sourceDir, 'sources.json', 'binary-manifest.json', 'BUILDING.md', 'collect-mpv-sources.cjs', 'bundle-mpv.cjs', ...plan.map(f => safeName(`${f.name}-${f.version}`))]);
  if (fs.statSync(archivePath).size >= 2_000_000_000) throw new Error('Source archive exceeds GitHub release asset limit; split it before distributing binaries.');
  fs.writeFileSync(completionPath, `${JSON.stringify({ complete: true, archive: archiveName, sha256: hash(archivePath), binaryManifestSha256: hash(manifestPath), formulas: results.map(({ archives, ...record }) => record) }, null, 2)}\n`);
  console.log(`Created ${archivePath}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`mpv source collection failed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { validateResource, readPlan, collectNotices, fetchBottleProvenance, bottleMatches, compiledBuildInputsFor };
