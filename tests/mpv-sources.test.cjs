'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateResource, bottleMatches, compiledBuildInputsFor, collectNotices } = require('../scripts/collect-mpv-sources.cjs');

const receipt = { source_modified_time: 123456, homebrew_version: '4.5.1', compiler: 'clang', arch: 'arm64' };
const installed = { name: 'libplacebo', version: '7.360.1' };
const bottle = () => ({
  annotations: { 'org.opencontainers.image.title': 'libplacebo' },
  manifests: [{ platform: { architecture: 'arm64', os: 'darwin' }, annotations: {
    'sh.brew.tab': JSON.stringify(receipt),
  } }],
});

test('source verification accepts checksummed HTTPS archives and pinned git revisions', () => {
  assert.doesNotThrow(() => validateResource({ url: 'https://example.test/source.tar.gz', sha256: 'a'.repeat(64) }));
  assert.doesNotThrow(() => validateResource({ url: 'https://example.test/source.git', specs: { revision: 'b'.repeat(40) } }));
  assert.doesNotThrow(() => validateResource({ inline: '--- a/build\n+++ b/build\n' }));
});

test('source verification fails closed for mutable, insecure, and unchecked inputs', () => {
  for (const resource of [
    { url: 'http://example.test/source.tar.gz', sha256: 'a'.repeat(64) },
    { url: 'https://secret@example.test/source.tar.gz', sha256: 'a'.repeat(64) },
    { url: 'https://example.test/source.git', specs: { revision: 'main' } },
    { url: 'https://example.test/source.tar.gz', sha256: 'abc' },
    { url: 'https://example.test/source.tar.gz', sha256: 'a'.repeat(64), patches: [{ url: 'https://example.test/patch' }] },
  ]) assert.throws(() => validateResource(resource));
});

test('bottle provenance matches the installed source/build environment and architecture', () => {
  assert.equal(bottleMatches(bottle(), receipt, installed), true);
  for (const changed of [
    { ...receipt, source_modified_time: 654321 },
    { ...receipt, homebrew_version: '4.5.2' },
    { ...receipt, compiler: 'gcc' },
    { ...receipt, arch: 'x86_64' },
  ]) assert.equal(bottleMatches(bottle(), changed, installed), false);
  assert.equal(bottleMatches(bottle(), receipt, { ...installed, name: 'mpv' }), false);
  const linux = bottle(); linux.manifests[0].platform.os = 'linux';
  assert.equal(bottleMatches(linux, receipt, installed), false);
  const intel = bottle(); intel.manifests[0].platform.architecture = 'amd64';
  assert.equal(bottleMatches(intel, { ...receipt, arch: 'x86_64' }, installed), true);
});

test('libplacebo includes compiled header/registry inputs without adding unrelated build tools', () => {
  assert.deepEqual(compiledBuildInputsFor('libplacebo'), ['fast_float', 'vulkan-headers']);
  assert.deepEqual(compiledBuildInputsFor('vulkan-loader'), ['vulkan-headers']);
  assert.deepEqual(compiledBuildInputsFor('mpv'), []);
  assert.deepEqual(compiledBuildInputsFor('shaderc'), []); // Its declared resources already include SPIRV/glslang.
  assert.equal(compiledBuildInputsFor('libplacebo').includes('meson'), false);
});

test('license extraction preserves upstream text and rejects sources without a notice', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-source-notices-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'LICENSE.txt'), 'Copyright Fixture Author\nPermission granted.\n');
  const archive = path.join(temp, 'source.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const notices = path.join(temp, 'notices');
  assert.equal(collectNotices([{ name: 'source', file: 'source.tar.gz' }], temp, notices), 1);
  assert.equal(fs.readFileSync(path.join(notices, fs.readdirSync(notices)[0]), 'utf8'), 'Copyright Fixture Author\nPermission granted.\n');
  fs.unlinkSync(path.join(source, 'LICENSE.txt'));
  fs.writeFileSync(path.join(source, 'readme'), 'No license here');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  assert.throws(() => collectNotices([{ name: 'source', file: 'source.tar.gz' }], temp, notices), /No license/);
});
