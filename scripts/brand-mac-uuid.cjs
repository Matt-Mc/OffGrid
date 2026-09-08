'use strict';

const crypto = require('node:crypto');

// Custom packaging transform: give the app's reused Electron executable its own
// build identity. Run before code signing: signatures cover these UUID bytes.
// A release-specific namespace (bundle ID + version) is supplied by the caller.
const DNS_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
function uuidBytes(name) {
  const bytes = crypto.createHash('sha1').update(DNS_NAMESPACE).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}
function formatUuid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function invalid(reason) { throw new Error(`Invalid Mach-O executable: ${reason}.`); }
function range(offset, size, end) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > end || size > end - offset) invalid('out-of-bounds data');
}

function namespaceMachOUuids(input, namespace) {
  if (!Buffer.isBuffer(input)) throw new TypeError('Mach-O input must be a Buffer.');
  if (typeof namespace !== 'string' || !namespace.trim() || namespace.length > 1024) throw new TypeError('A nonempty release namespace is required.');
  const uuids = [];
  const architectures = new Set();
  function slice(start, size, expectedArchitecture) {
    range(start, size, input.length);
    const end = start + size;
    range(start, 4, end);
    const magic = input.readUInt32BE(start);
    const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
    const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
    if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) invalid('unsupported slice magic');
    const headerSize = is64 ? 32 : 28;
    range(start, headerSize, end);
    const u32 = offset => little ? input.readUInt32LE(offset) : input.readUInt32BE(offset);
    const architecture = `${u32(start + 4)}:${u32(start + 8)}`;
    if (expectedArchitecture && architecture !== expectedArchitecture) invalid('fat architecture disagrees with its slice');
    if (architectures.has(architecture)) invalid('duplicate architecture');
    architectures.add(architecture);
    const ncmds = u32(start + 16), sizeofcmds = u32(start + 20);
    let cursor = start + headerSize;
    range(cursor, sizeofcmds, end);
    const commandsEnd = cursor + sizeofcmds;
    if (!ncmds || ncmds > Math.floor(sizeofcmds / 8)) invalid('invalid load command count');
    let uuidOffset;
    for (let i = 0; i < ncmds; i++) {
      range(cursor, 8, commandsEnd);
      const command = u32(cursor), commandSize = u32(cursor + 4);
      if (commandSize < 8 || commandSize % 4) invalid('invalid load command size');
      range(cursor, commandSize, commandsEnd);
      if (command === 0x1b) {
        if (commandSize !== 24 || uuidOffset !== undefined) invalid('invalid or duplicate LC_UUID');
        uuidOffset = cursor + 8;
      }
      cursor += commandSize;
    }
    if (cursor !== commandsEnd) invalid('load commands do not fill sizeofcmds');
    if (uuidOffset === undefined) invalid('missing LC_UUID');
    const bytes = uuidBytes(JSON.stringify([namespace, architecture]));
    uuids.push({ offset: uuidOffset, architecture,
      originalUuid: formatUuid(input.subarray(uuidOffset, uuidOffset + 16)), uuid: formatUuid(bytes), bytes });
  }

  range(0, 4, input.length);
  const magic = input.readUInt32BE(0);
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    range(0, 8, input.length);
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const is64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    const u32 = offset => little ? input.readUInt32LE(offset) : input.readUInt32BE(offset);
    const u64 = offset => {
      const value = little ? input.readBigUInt64LE(offset) : input.readBigUInt64BE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid('unsafe 64-bit offset or size');
      return Number(value);
    };
    const count = u32(4), entrySize = is64 ? 32 : 20;
    if (!count || count > 4096) invalid('invalid fat slice count');
    range(8, count * entrySize, input.length);
    const headerEnd = 8 + count * entrySize, slices = [];
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * entrySize;
      const start = is64 ? u64(entry + 8) : u32(entry + 8);
      const size = is64 ? u64(entry + 16) : u32(entry + 12);
      range(start, size, input.length);
      if (start < headerEnd || !size) invalid('slice overlaps fat header or is empty');
      if (slices.some(other => start < other.end && start + size > other.start)) invalid('overlapping fat slices');
      slices.push({ start, end: start + size });
      slice(start, size, `${u32(entry)}:${u32(entry + 4)}`);
    }
  } else slice(0, input.length);

  const buffer = Buffer.from(input);
  for (const { offset, bytes } of uuids) bytes.copy(buffer, offset);
  return { buffer, uuids: uuids.map(({ bytes, ...record }) => record) };
}

module.exports = { namespaceMachOUuids };
