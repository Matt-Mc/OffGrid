const { signAsync } = require('@electron/osx-sign');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { namespaceMachOUuids } = require('./brand-mac-uuid.cjs');

// Packaging changes Electron's plist and resources. Leaving its upstream
// signature in place produces an invalid app identity. Use a configured Apple
// identity when available, otherwise create a valid local ad hoc signature.
// Ad hoc signing is for local builds; it does not provide notarization or a
// stable Apple-issued identity for distributing updates to other machines.
module.exports = async function sign(options) {
  const plist = path.join(options.app, 'Contents', 'Info.plist');
  const readPlist = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {encoding:'utf8'}).trim();
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
