const { signAsync } = require('@electron/osx-sign');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { namespaceMachOUuids } = require('./brand-mac-uuid.cjs');

function maximumMacOSVersion(...versions) {
  const parsed = versions.map(version => {
    if (typeof version !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(version)) throw new Error('Invalid minimum macOS version.');
    const parts = version.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid minimum macOS version.');
    return { version, parts };
  });
  if (!parsed.length) throw new Error('A minimum macOS version is required.');
  return parsed.reduce((highest, candidate) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = (candidate.parts[index] || 0) - (highest.parts[index] || 0);
      if (difference) return difference > 0 ? candidate : highest;
    }
    return highest;
  }).version;
}

// Packaging changes Electron's plist and resources. Leaving its upstream
// signature in place produces an invalid app identity. Use a configured Apple
// identity when available, otherwise create a valid local ad hoc signature.
// Ad hoc signing is for local builds; it does not provide notarization or a
// stable Apple-issued identity for distributing updates to other machines.
module.exports = async function sign(options) {
  const plist = path.join(options.app, 'Contents', 'Info.plist');
  const readPlist = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {encoding:'utf8'}).trim();
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(options.app, 'Contents', 'Resources', 'mpv', 'manifest.json'), 'utf8'));
  const minimumMacOS = maximumMacOSVersion(readPlist('LSMinimumSystemVersion'), runtimeManifest.minimumMacOS);
  // Let Launch Services reject an unsupported OS before a bundled library fails
  // to load. This plist mutation must happen before the final application seal.
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :LSMinimumSystemVersion ${minimumMacOS}`, plist]);
  const name = readPlist('CFBundleExecutable');
  if (!name || path.basename(name) !== name) throw new Error('Invalid packaged executable name.');
  const executable = path.join(options.app, 'Contents', 'MacOS', name);
  // Stock Electron apps share the same Mach-O UUID. Give this product/release
  // its own identity before signing so network privacy can distinguish it.
  // This custom packaging transform invalidates the old signature; signAsync
  // below replaces it and verifies the complete application afterward.
  const branded = namespaceMachOUuids(fs.readFileSync(executable), `${readPlist('CFBundleIdentifier')}:${readPlist('CFBundleShortVersionString')}`);
  fs.writeFileSync(executable, branded.buffer);
  await signAsync({
    ...options,
    identity: options.identity || '-',
    identityValidation: false,
    preAutoEntitlements: options.identity ? options.preAutoEntitlements : false,
  });
};

module.exports.maximumMacOSVersion = maximumMacOSVersion;
