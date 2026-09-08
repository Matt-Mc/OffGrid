const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson, readJson } = require('./backend-core.cjs');
const { PlexClient } = require('./plex-client.cjs');

// Only the main process can decrypt this credential. Renderer-facing objects
// deliberately contain neither tokens nor authenticated media URLs.
class PlexConnection {
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'plex-connection.json');
    this.safeStorage = safeStorage;
    this.saved = readJson(this.file, null);
  }
  status() {
    if (!this.saved) return { configured: false, baseUrl: '', serverName: '', serverId: '' };
    return { configured: true, baseUrl: this.saved.baseUrl, serverName: this.saved.serverName, serverId: this.saved.serverId };
  }
  encryptionAvailable() {
    return this.safeStorage?.isEncryptionAvailable() && (process.platform !== 'linux' || this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text');
  }
  async connect({ baseUrl, token } = {}) {
    if (!this.encryptionAvailable()) throw new Error('Unlock your system keychain before saving a Plex connection.');
    const client = new PlexClient({ baseUrl, token });
    const identity = await client.identity();
    const saved = {
      baseUrl: client.baseUrl,
      serverName: identity.name,
      serverId: identity.serverId,
      encryptedToken: this.safeStorage.encryptString(token.trim()).toString('base64'),
    };
    atomicWriteJson(this.file, saved);
    fs.chmodSync(this.file, 0o600);
    this.saved = saved;
    return this.status();
  }
  client() {
    if (!this.saved) throw new Error('Connect to your Plex server first.');
    let token;
    try {
      if (!this.encryptionAvailable()) throw new Error();
      token = this.safeStorage.decryptString(Buffer.from(this.saved.encryptedToken, 'base64'));
    } catch {
      throw new Error('Plex credentials could not be unlocked. Unlock your system keychain or reconnect to Plex.');
    }
    return new PlexClient({ baseUrl: this.saved.baseUrl, token });
  }
  disconnect() {
    fs.rmSync(this.file, { force: true });
    this.saved = null;
    return this.status();
  }
}

module.exports = { PlexConnection };
