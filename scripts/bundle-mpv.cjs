#!/usr/bin/env node
'use strict';

// Build a relocatable runtime from an installed Homebrew mpv. Every third-party
// binary must have an installed formula recipe/receipt so release tooling can
// archive the exact corresponding sources and notices alongside the installer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isSystemPath = name => name.startsWith('/System/Library/') || name.startsWith('/usr/lib/');
function parseDependencies(output) {
  return output.split('\n').slice(1).map(line => line.match(/^\s+(.+?) \(compatibility version /)?.[1]).filter(Boolean);
}
function parseRpaths(output) {
  return [...output.matchAll(/\bcmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map(match => match[1]);
}
function minimumMacOS(output) {
  const version = output.match(/\bcmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform 1\s+minos (\d+(?:\.\d+)*)/)?.[1]
    || output.match(/\bcmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+(?:\.\d+)*)/)?.[1];
  if (!version) throw new Error('Could not determine minimum macOS version from Mach-O load commands.');
  return version;
}
function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}
function expandPath(name, owner, executable) {
  if (name === '@loader_path' || name.startsWith('@loader_path/')) return path.resolve(path.dirname(owner), name.slice('@loader_path'.length).replace(/^\//, ''));
  if (name === '@executable_path' || name.startsWith('@executable_path/')) return path.resolve(path.dirname(executable), name.slice('@executable_path'.length).replace(/^\//, ''));
  return name;
}
function resolveDependency(name, owner, executable, rpaths, exists = fs.existsSync, realpath = fs.realpathSync) {
  if (isSystemPath(name)) return name;
  const expanded = expandPath(name, owner, executable);
  const candidates = expanded.startsWith('@rpath/')
    ? rpaths.map(root => path.join(root, expanded.slice(7))) : [expanded];
  const resolved = candidates.find(candidate => path.isAbsolute(candidate) && exists(candidate));
  if (!resolved) throw new Error(`Cannot resolve ${name} required by ${owner}`);
  return realpath(resolved);
}
function formulaOwner(file) {
  let dir = path.dirname(fs.realpathSync(file));
  while (dir !== path.dirname(dir)) {
    const receiptPath = path.join(dir, 'INSTALL_RECEIPT.json');
    const recipes = path.join(dir, '.brew');
    if (fs.existsSync(receiptPath) && fs.existsSync(recipes)) {
      const names = fs.readdirSync(recipes).filter(name => name.endsWith('.rb'));
      if (names.length !== 1) throw new Error(`Expected one installed Homebrew recipe in ${recipes}`);
      const name = path.basename(names[0], '.rb');
      return { name, version: path.basename(dir), kegPath: dir, recipePath: path.join(recipes, names[0]), receiptPath };
    }
    dir = path.dirname(dir);
  }
  throw new Error(`No installed Homebrew recipe and receipt found for ${file}`);
}
function findBinary() {
  for (const dir of (process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin'])) {
    const candidate = path.join(dir, 'mpv');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Install mpv with Homebrew before bundling (brew install mpv).');
}
function cleanEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DYLD_') || key.startsWith('VK_') || key.startsWith('MPV_')) delete env[key];
  return { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...extra };
}
function relativeLoadPath(owner, target) {
  return '@loader_path/' + path.relative(path.dirname(owner), target).split(path.sep).join('/');
}
function bundleMpv({ binary = findBinary(), output = path.resolve('vendor/mpv'), architecture = process.arch } = {}) {
  if (process.platform !== 'darwin') throw new Error('The mpv runtime bundler currently supports macOS only.');
  const expectedArch = { arm64: 'arm64', x64: 'x86_64' }[architecture];
  if (!expectedArch) throw new Error(`Unsupported macOS architecture: ${architecture}`);
  const executable = fs.realpathSync(binary);
  output = path.resolve(output);
  if (executable === output || executable.startsWith(output + path.sep)) throw new Error('The output must not contain the source mpv installation.');
  if (fs.existsSync(output) && !fs.existsSync(path.join(output, 'manifest.json')) && fs.readdirSync(output).length) {
    throw new Error(`Refusing to replace an unrelated nonempty directory: ${output}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(output), '.mpv-build-'));
  const binaries = new Map();
  const destinations = new Map();
  const formulas = new Map();
  const signingOrder = [];
  try {
    fs.mkdirSync(path.join(stage, 'bin'));
    fs.mkdirSync(path.join(stage, 'lib'));
    function visit(source, inheritedRpaths = [], isExecutable = false) {
      source = fs.realpathSync(source);
      if (binaries.has(source)) return binaries.get(source);
      const owner = formulaOwner(source);
      const relative = isExecutable ? 'bin/mpv' : `lib/${path.basename(source)}`;
      if (destinations.has(relative) && destinations.get(relative) !== source) throw new Error(`Dylib filename collision: ${relative}`);
      destinations.set(relative, source);
      const architectures = run('/usr/bin/lipo', ['-archs', source]).split(/\s+/);
      if (!architectures.includes(expectedArch)) throw new Error(`${source} does not contain the requested ${expectedArch} architecture`);
      const destination = path.join(stage, relative);
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o755);
      if (architectures.length > 1) run('/usr/bin/lipo', [destination, '-thin', expectedArch, '-output', destination]);
      const loadCommands = run('/usr/bin/otool', ['-l', destination]);
      const minimumOS = minimumMacOS(loadCommands);
      const ownRpaths = parseRpaths(loadCommands);
      const rpaths = [...ownRpaths.map(name => expandPath(name, source, executable)), ...inheritedRpaths];
      const record = { path: relative, originalPath: source, originalSha256: sha256(source), formula: owner.name,
        minimumMacOS: minimumOS, version: owner.version, kegPath: owner.kegPath, recipePath: owner.recipePath, receiptPath: owner.receiptPath, dependencies: [] };
      binaries.set(source, record);
      formulas.set(`${owner.name}@${owner.version}`, owner);
      const ids = isExecutable ? [] : run('/usr/bin/otool', ['-D', destination]).split('\n').slice(1).map(line => line.trim()).filter(Boolean);
      for (const dependency of parseDependencies(run('/usr/bin/otool', ['-L', destination]))) {
        if (ids.includes(dependency) || isSystemPath(dependency)) continue;
        const resolved = resolveDependency(dependency, source, executable, rpaths);
        if (isSystemPath(resolved)) continue;
        const child = visit(resolved, rpaths);
        const rewritten = relativeLoadPath(destination, path.join(stage, child.path));
        run('/usr/bin/install_name_tool', ['-change', dependency, rewritten, destination]);
        record.dependencies.push(child.path);
      }
      if (!isExecutable) run('/usr/bin/install_name_tool', ['-id', '@rpath/' + path.basename(destination), destination]);
      // All non-system links are direct @loader_path references now. Remove
      // even SDK/toolchain rpaths so no developer installation is consulted.
      for (const rpath of new Set(ownRpaths)) run('/usr/bin/install_name_tool', ['-delete_rpath', rpath, destination]);
      signingOrder.push(destination);
      return record;
    }
    visit(executable, [], true);
    const mpvOwner = formulaOwner(executable);
    const cellar = path.dirname(path.dirname(mpvOwner.kegPath));
    const prefix = path.dirname(cellar);
    const moltenVk = path.join(prefix, 'opt/molten-vk/lib/libMoltenVK.dylib');
    if (!fs.existsSync(moltenVk)) throw new Error('The Homebrew molten-vk driver is required for the bundled macOS player.');
    const driver = visit(moltenVk);
    const driverSource = path.join(formulaOwner(moltenVk).kegPath, 'etc/vulkan/icd.d/MoltenVK_icd.json');
    const driverConfig = JSON.parse(fs.readFileSync(driverSource, 'utf8'));
    const driverRelative = 'share/vulkan/icd.d/MoltenVK_icd.json';
    // ICD library_path is relative to the JSON file, not the executable.
    driverConfig.ICD.library_path = path.relative(path.dirname(driverRelative), driver.path).split(path.sep).join('/');
    fs.mkdirSync(path.dirname(path.join(stage, driverRelative)), { recursive: true });
    fs.writeFileSync(path.join(stage, driverRelative), JSON.stringify(driverConfig, null, 2) + '\n');
    for (const record of binaries.values()) {
      const file = path.join(stage, record.path);
      const ids = record.path === 'bin/mpv' ? [] : run('/usr/bin/otool', ['-D', file]).split('\n').slice(1).map(line => line.trim());
      for (const dependency of parseDependencies(run('/usr/bin/otool', ['-L', file]))) {
        if (ids.includes(dependency) || isSystemPath(dependency)) continue;
        if (!dependency.startsWith('@loader_path/')) throw new Error(`Nonportable dependency remains: ${dependency}`);
        const target = expandPath(dependency, file, path.join(stage, 'bin/mpv'));
        if (!target.startsWith(stage + path.sep) || !fs.existsSync(target)) throw new Error(`Dependency escapes or is missing from bundle: ${dependency}`);
      }
      if (parseRpaths(run('/usr/bin/otool', ['-l', file])).length) throw new Error(`An rpath remains in ${file}`);
    }
    // Sign dependencies first, then the executable; all rewriting is complete.
    for (const file of signingOrder.filter(file => file !== path.join(stage, 'bin/mpv')).concat(path.join(stage, 'bin/mpv'))) {
      run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      run('/usr/bin/codesign', ['--verify', '--strict', file]);
    }
    const version = run(path.join(stage, 'bin/mpv'), ['--no-config', '--version'], { env: cleanEnvironment({ VK_DRIVER_FILES: path.join(stage, driverRelative), VK_ICD_FILENAMES: path.join(stage, driverRelative) }) });
    const files = [...binaries.values()].map(record => ({ ...record, sha256: sha256(path.join(stage, record.path)) })).sort((a, b) => a.path.localeCompare(b.path));
    const driverOwner = formulaOwner(moltenVk);
    files.push({ path: driverRelative, sha256: sha256(path.join(stage, driverRelative)), originalPath: driverSource, originalSha256: sha256(driverSource),
      formula: driverOwner.name, version: driverOwner.version, kegPath: driverOwner.kegPath, recipePath: driverOwner.recipePath, receiptPath: driverOwner.receiptPath });
    const minOS = [...binaries.values()].map(record => record.minimumMacOS).sort(compareVersions).at(-1);
    if (compareVersions(minOS, run('/usr/bin/sw_vers', ['-productVersion'])) > 0) throw new Error(`The bundled runtime requires macOS ${minOS}, newer than this build machine.`);
    // Application signing may rewrite Mach-O signature bytes. These hashes
    // bind the staged inputs checked by beforePack, before final app signing.
    const manifest = { hashScope: 'staged-runtime-before-application-signing', minimumMacOS: minOS, schemaVersion: 1, platform: 'darwin', architecture, executable: 'bin/mpv', version,
      runtimeEnvironment: { VK_DRIVER_FILES: driverRelative, VK_ICD_FILENAMES: driverRelative },
      files, formulas: [...formulas.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const backup = `${stage}-previous`;
    if (fs.existsSync(output)) fs.renameSync(output, backup);
    try { fs.renameSync(stage, output); }
    catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, output); throw error; }
    fs.rmSync(backup, { recursive: true, force: true });
    return manifest;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (require.main === module) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index++) {
      const flag = process.argv[index];
      if (!['--output', '--binary'].includes(flag) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('Usage: node scripts/bundle-mpv.cjs [--output vendor/mpv] [--binary /path/to/mpv]');
      options[flag.slice(2)] = process.argv[++index];
    }
    const manifest = bundleMpv(options);
    console.log(`Bundled ${manifest.files.length} files from ${manifest.formulas.length} formulas for macOS ${manifest.architecture}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { minimumMacOS, compareVersions, bundleMpv, parseDependencies, parseRpaths, expandPath, resolveDependency, formulaOwner, isSystemPath, cleanEnvironment, relativeLoadPath };
