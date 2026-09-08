const test = require('node:test');
const assert = require('node:assert/strict');
const { namespaceMachOUuids } = require('../scripts/brand-mac-uuid.cjs');

function thin({ little = true, is64 = true, cpu = 0x100000c, subtype = 0 } = {}) {
  const header = is64 ? 32 : 28;
  const buffer = Buffer.alloc(header + 32 + 16, 0xa5);
  const u32 = (value, offset) => little ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  buffer.fill(0, 0, header);
  u32(is64 ? 0xfeedfacf : 0xfeedface, 0); u32(cpu, 4); u32(subtype, 8);
  u32(2, 12); u32(2, 16); u32(32, 20);
  u32(0x1b, header); u32(24, header + 4);
  u32(0x2, header + 24); u32(8, header + 28);
  return buffer;
}
function fat({ little = false, is64 = false } = {}) {
  const entries = [thin(), thin({ little: false, is64: false, cpu: 7 })];
  const buffer = Buffer.alloc(512, 0x6b), starts = [128, 256];
  const u32 = (value, offset) => little ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  const u64 = (value, offset) => little ? buffer.writeBigUInt64LE(BigInt(value), offset) : buffer.writeBigUInt64BE(BigInt(value), offset);
  u32(is64 ? 0xcafebabf : 0xcafebabe, 0); u32(2, 4);
  entries.forEach((data, index) => {
    const entry = 8 + index * (is64 ? 32 : 20);
    u32(index ? 7 : 0x100000c, entry); u32(0, entry + 4);
    if (is64) { u64(starts[index], entry + 8); u64(data.length, entry + 16); u32(0, entry + 28); }
    else { u32(starts[index], entry + 8); u32(data.length, entry + 12); }
    u32(7, entry + (is64 ? 24 : 16));
    data.copy(buffer, starts[index]);
  });
  return buffer;
}
const namespace = 'com.offgrid.videolibrary:0.1.2';
function verifyTransform(input) {
  const original = Buffer.from(input);
  const result = namespaceMachOUuids(input, namespace);
  assert.deepEqual(input, original, 'caller buffer is unchanged');
  assert.notEqual(result.buffer, input);
  assert.deepEqual(namespaceMachOUuids(result.buffer, namespace).buffer, result.buffer, 'idempotent');
  assert.deepEqual(namespaceMachOUuids(input, namespace).buffer, result.buffer, 'deterministic');
  assert.notDeepEqual(namespaceMachOUuids(input, `${namespace}:other-app`).buffer, result.buffer);
  assert.equal(new Set(result.uuids.map(item => item.uuid)).size, result.uuids.length);
  for (const item of result.uuids) {
    assert.notEqual(item.uuid, item.originalUuid);
    assert.match(item.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  for (let i = 0; i < input.length; i++) {
    if (!result.uuids.some(item => i >= item.offset && i < item.offset + 16)) assert.equal(result.buffer[i], input[i], `unchanged byte ${i}`);
  }
  return result;
}

test('thin 32/64-bit Mach-O in both byte orders gets deterministic app-specific UUIDs', () => {
  for (const little of [true, false]) for (const is64 of [true, false]) assert.equal(verifyTransform(thin({ little, is64 })).uuids.length, 1);
  assert.notEqual(verifyTransform(thin()).uuids[0].uuid, verifyTransform(thin({ subtype: 2 })).uuids[0].uuid);
});

test('universal FAT32/FAT64 in both byte orders brands each architecture without changing other bytes', () => {
  for (const little of [true, false]) for (const is64 of [true, false]) assert.equal(verifyTransform(fat({ little, is64 })).uuids.length, 2);
});

test('malformed thin headers and load commands fail without changing the input', () => {
  const cases = [Buffer.alloc(0), Buffer.alloc(4), thin().subarray(0, 20)];
  for (const [offset, value] of [[16, 0], [16, 1000], [20, 4096], [20, 36], [32, 1], [36, 0], [36, 23], [36, 4096]]) {
    const buffer = thin(); buffer.writeUInt32LE(value, offset); cases.push(buffer);
  }
  const duplicate = Buffer.alloc(80); thin().copy(duplicate); duplicate.writeUInt32LE(48, 20);
  duplicate.writeUInt32LE(0x1b, 56); duplicate.writeUInt32LE(24, 60); cases.push(duplicate);
  for (const input of cases) {
    const original = Buffer.from(input);
    assert.throws(() => namespaceMachOUuids(input, namespace), /Invalid Mach-O/);
    assert.deepEqual(input, original);
  }
  assert.throws(() => namespaceMachOUuids('not a buffer', namespace), /Buffer/);
  assert.throws(() => namespaceMachOUuids(thin(), ''), /namespace/);
});

test('malformed universal bounds, overlapping slices and inconsistent architectures are rejected', () => {
  const cases = [];
  for (const [offset, value] of [[4, 0], [4, 4097], [16, 4], [16, 500], [20, 500], [36, 128], [8, 7]]) {
    const buffer = fat(); buffer.writeUInt32BE(value, offset); cases.push(buffer);
  }
  const unsafe = fat({ is64: true }); unsafe.writeBigUInt64BE(2n ** 63n, 16); cases.push(unsafe);
  const badSlice = fat(); badSlice.writeUInt32BE(0, 256); cases.push(badSlice);
  const duplicateArch = fat(); duplicateArch.writeUInt32BE(0x100000c, 28); duplicateArch.writeUInt32BE(0x100000c, 260); cases.push(duplicateArch);
  for (const input of cases) assert.throws(() => namespaceMachOUuids(input, namespace), /Invalid Mach-O/);
});
