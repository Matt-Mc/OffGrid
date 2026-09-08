const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDependencies, parseRpaths, minimumMacOS, compareVersions, resolveDependency, formulaOwner, isSystemPath, cleanEnvironment, relativeLoadPath } = require('../scripts/bundle-mpv.cjs');

test('Mach-O dependency parsing preserves spaces, weak references, and versioned identities', () => {
  assert.deepEqual(parseDependencies(`/tmp/My Player:\n\t@rpath/libname.2.dylib (compatibility version 1.0.0, current version 2.0.0)\n\t/usr/lib/swift/libswift.dylib (compatibility version 1.0.0, current version 1.0.0, weak)\n\t/tmp/A Folder/libother.dylib (compatibility version 1.0.0, current version 1.0.0)`), ['@rpath/libname.2.dylib', '/usr/lib/swift/libswift.dylib', '/tmp/A Folder/libother.dylib']);
  assert.deepEqual(parseRpaths('          cmd LC_RPATH\n      cmdsize 48\n         path @loader_path/../Some Libraries (offset 12)\nLoad command 2\n cmd LC_RPATH\n cmdsize 32\n path /usr/lib/swift (offset 12)'), ['@loader_path/../Some Libraries', '/usr/lib/swift']);
});

test('dependency resolution handles loader/executable paths, inherited rpaths and symlinks', () => {
  const entries = new Map([
    ['/brew/lib/liba.dylib', '/brew/Cellar/a/1/lib/liba.1.dylib'],
    ['/brew/bin/libb.dylib', '/brew/Cellar/b/2/lib/libb.dylib'],
    ['/shared/libc.dylib', '/brew/Cellar/c/3/lib/libc.dylib'],
  ]);
  const resolve = name => resolveDependency(name, '/brew/lib/libowner.dylib', '/brew/bin/mpv', ['/absent', '/shared'], name => entries.has(name), name => entries.get(name));
  assert.equal(resolve('@loader_path/liba.dylib'), '/brew/Cellar/a/1/lib/liba.1.dylib');
  assert.equal(resolve('@executable_path/libb.dylib'), '/brew/Cellar/b/2/lib/libb.dylib');
  assert.equal(resolve('@rpath/libc.dylib'), '/brew/Cellar/c/3/lib/libc.dylib');
  assert.equal(resolve('/usr/lib/libSystem.B.dylib'), '/usr/lib/libSystem.B.dylib');
  assert.throws(() => resolve('@rpath/missing.dylib'), /Cannot resolve/);
  assert.throws(() => resolve('relative.dylib'), /Cannot resolve/);
});

test('system dependency allowlist has directory boundaries and rewrites remain relocatable', () => {
  assert.equal(isSystemPath('/System/Library/Frameworks/Metal.framework/Metal'), true);
  assert.equal(isSystemPath('/usr/lib/libSystem.B.dylib'), true);
  for (const name of ['/usr/library/libbad.dylib', '/System/LibraryOther/libbad.dylib', '/opt/homebrew/lib/a.dylib', '/usr/local/lib/a.dylib']) assert.equal(isSystemPath(name), false);
  assert.equal(relativeLoadPath('/bundle/bin/mpv', '/bundle/lib/a.dylib'), '@loader_path/../lib/a.dylib');
  assert.equal(relativeLoadPath('/bundle/lib/b.dylib', '/bundle/lib/a.dylib'), '@loader_path/a.dylib');
});

test('formula provenance follows symlinks to the installed recipe and fails closed for unowned binaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-bundle-provenance-'));
  try {
    const keg = path.join(root, 'Cellar/mpv/0.41.0_9');
    fs.mkdirSync(path.join(keg, '.brew'), { recursive: true });
    fs.mkdirSync(path.join(keg, 'bin'));
    fs.writeFileSync(path.join(keg, '.brew/mpv.rb'), 'class Mpv < Formula; end');
    fs.writeFileSync(path.join(keg, 'INSTALL_RECEIPT.json'), '{}');
    fs.writeFileSync(path.join(keg, 'bin/mpv'), 'fixture');
    fs.symlinkSync(path.join(keg, 'bin/mpv'), path.join(root, 'mpv'));
    assert.deepEqual(formulaOwner(path.join(root, 'mpv')), { name: 'mpv', version: '0.41.0_9', kegPath: fs.realpathSync(keg), recipePath: fs.realpathSync(path.join(keg, '.brew/mpv.rb')), receiptPath: fs.realpathSync(path.join(keg, 'INSTALL_RECEIPT.json')) });
    fs.writeFileSync(path.join(root, 'unowned'), 'fixture');
    assert.throws(() => formulaOwner(path.join(root, 'unowned')), /No installed Homebrew recipe/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('minimum macOS versions come from build/min-version commands and compare numerically', () => {
  assert.equal(minimumMacOS('cmd LC_BUILD_VERSION\n cmdsize 32\n platform 1\n minos 26.0\n sdk 26.5'), '26.0');
  assert.equal(minimumMacOS('cmd LC_VERSION_MIN_MACOSX\n cmdsize 16\n version 10.15\n sdk 11.0'), '10.15');
  assert.throws(() => minimumMacOS('cmd LC_BUILD_VERSION\n cmdsize 32\n platform 2\n minos 15.0'), /Could not determine/);
  assert(compareVersions('15.10', '15.9') > 0);
  assert.equal(compareVersions('15.0.0', '15'), 0);
});

test('minimal runtime environment strips developer loader and player overrides', () => {
  const keys = ['DYLD_LIBRARY_PATH', 'VK_DRIVER_FILES', 'MPV_HOME'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = '/developer/dependency';
    const env = cleanEnvironment({ VK_DRIVER_FILES: '/app/driver.json' });
    assert.equal(env.DYLD_LIBRARY_PATH, undefined);
    assert.equal(env.MPV_HOME, undefined);
    assert.equal(env.VK_DRIVER_FILES, '/app/driver.json');
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  } finally {
    keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
  }
});
