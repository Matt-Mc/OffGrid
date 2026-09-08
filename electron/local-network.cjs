'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { normalizeServerUrl, isLocalAddress, PlexError } = require('./plex-client.cjs');

const MAX_TIMEOUT_MS = 8000;

// macOS does not expose a general-purpose Local Network permission status or
// request API. An outgoing connection can trigger its first permission prompt.
// Failed connections cannot reliably distinguish privacy denial from LAN faults.
function localNetworkResult(error, platform = process.platform) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (['EACCES', 'EPERM'].includes(code) || (platform === 'darwin' && ['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN'].includes(code))) {
    return {
      status: 'blocked-or-unreachable',
      message: platform === 'darwin'
        ? 'Local access may be blocked, or the server may be unreachable. Open Local Network Settings and enable Offgrid, then try again. Also check the server address and that both devices are on the same network.'
        : 'Local access may be blocked, or the server may be unreachable. Check your network permissions, firewall, server address, and that both devices are on the same network.',
    };
  }
  const messages = new Map([
    ['ECONNREFUSED', 'The server is not accepting connections at this address and port. Check that Plex Media Server is running and that the port is correct (usually 32400).'],
    ['ETIMEDOUT', 'The local connection timed out. Check the server address and network connection, then try again. This does not determine whether local access is allowed.'],
    ...['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].map(value => [value, 'Could not find the local server. Check its hostname or use its local IP address.']),
  ]);
  return { status: 'unreachable', message: messages.get(code) || 'Could not reach the local server. Check the address, server, and network connection, then try again.' };
}

function cancelled() {
  const error = new Error('Local network request cancelled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

async function requestLocalNetworkAccess(baseUrl, { signal, platform = process.platform, timeoutMs = MAX_TIMEOUT_MS } = {}) {
  const url = new URL(normalizeServerUrl(baseUrl));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!port) throw new PlexError('Enter a valid local Plex server port.');
  if (signal?.aborted) throw cancelled();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      // Retain the error listener while destroying: a queued socket error must
      // never escape as an uncaught exception after cancellation or timeout.
      socket?.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(cancelled());
    const deadline = setTimeout(() => finish(null, localNetworkResult({ code: 'ETIMEDOUT' }, platform)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();

    (async () => {
      const results = net.isIP(hostname)
        ? [{ address: hostname, family: net.isIP(hostname) }]
        : await dns.lookup(hostname, { all: true, verbatim: true });
      if (settled) return;
      if (!results.length || results.some(result => !isLocalAddress(result.address))) {
        throw new PlexError('Plex connections must stay on the local network.');
      }
      const address = results[0];
      socket = new net.Socket();
      socket.on('error', error => finish(null, localNetworkResult(error, platform)));
      socket.once('connect', () => finish(null, {
        status: 'reachable',
        message: 'The server is reachable from Offgrid. Connect to Plex to verify your token and browse your library.',
      }));
      // Connect to the verified numeric IP: no second lookup or DNS rebinding.
      // Send no HTTP request, TLS handshake, token, or other application bytes.
      socket.connect({ host: address.address, family: net.isIP(address.address), port });
    })().catch(error => {
      if (error instanceof PlexError) finish(error);
      else finish(null, localNetworkResult(error, platform));
    });
  });
}

module.exports = { requestLocalNetworkAccess, localNetworkResult };
