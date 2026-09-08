const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { atomicWriteJson, readJson } = require('./backend-core.cjs');
const { JellyfinClient } = require('./jellyfin-client.cjs');

// Only the main process can decrypt this credential. Renderer-facing objects
// deliberately contain neither tokens nor authenticated media URLs.
class JellyfinConnection {
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'jellyfin-connection.json');
    this.safeStorage = safeStorage;
    this.saved = readJson(this.file, null);
  }
  status() {
    if (!this.saved) return { configured: false, baseUrl: '', serverName: '', serverId: '' };
    return { configured: true, baseUrl: this.saved.baseUrl, serverName: this.saved.serverName, serverId: this.saved.serverId, userId: this.saved.userId };
  }
  encryptionAvailable() {
    return this.safeStorage?.isEncryptionAvailable() && (process.platform !== 'linux' || this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text');
  }
  async connect({ baseUrl, username, password } = {}) {
    if (!this.encryptionAvailable()) throw new Error('Unlock your system keychain before saving a Jellyfin connection.');
    const deviceId = this.saved?.deviceId || randomUUID();
    const login = new JellyfinClient({ baseUrl, deviceId });
    const { token, userId, serverId } = await login.authenticate({ username, password });
    const client = new JellyfinClient({ baseUrl: login.baseUrl, token, userId, deviceId });
    const identity = await client.identity();
    if (serverId !== undefined && serverId !== identity.serverId) throw new Error('Jellyfin server identity changed during login. Retry the connection.');
    const saved = {
      baseUrl: client.baseUrl,
      userId,
      deviceId,
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
    if (!this.saved) throw new Error('Connect to your Jellyfin server first.');
    let token;
    try {
      if (!this.encryptionAvailable()) throw new Error();
      token = this.safeStorage.decryptString(Buffer.from(this.saved.encryptedToken, 'base64'));
    } catch {
      throw new Error('Jellyfin credentials could not be unlocked. Unlock your system keychain or reconnect to Jellyfin.');
    }
    return new JellyfinClient({ baseUrl: this.saved.baseUrl, token, userId: this.saved.userId, deviceId: this.saved.deviceId });
  }
  disconnect() {
    fs.rmSync(this.file, { force: true });
    this.saved = null;
    return this.status();
  }
}

module.exports = { JellyfinConnection };
