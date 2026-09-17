#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function parseArgs(args) {
  const options = {
    ffmpeg: process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg',
    ytdlp: process.env.YTDLP_PATH || '/opt/homebrew/bin/yt-dlp',
    mpv: process.env.MPV_PATH || path.resolve(__dirname, '../vendor/mpv/bin/mpv'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--ffmpeg', '--yt-dlp', '--mpv'].includes(name)) throw new Error('Usage: node scripts/smoke-download-runtime.cjs [--ffmpeg PATH] [--yt-dlp PATH] [--mpv PATH]');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires an executable path.`);
    options[{ '--ffmpeg': 'ffmpeg', '--yt-dlp': 'ytdlp', '--mpv': 'mpv' }[name]] = value;
  }
  return options;
}

function run(executable, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', timedOut = false;
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < 256 * 1024) stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { if (stderr.length < 256 * 1024) stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function waitForMpvTrackList(socketPath, child, expectedSubtitle, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let socket, buffer = '', settled = false, requestId = 0, retryTimer;
    const timer = setTimeout(() => finish(new Error('mpv did not return its subtitle track list in time.')), timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      socket?.destroy();
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      if (error) reject(error); else resolve(result);
    };
    const onClose = code => finish(new Error(`mpv exited before returning its subtitle track list (code ${code}).`));
    const onError = error => finish(error);
    child.once('close', onClose);
    child.once('error', onError);

    const query = currentSocket => {
      requestId += 1;
      currentSocket.write(`${JSON.stringify({ command: ['get_property', 'track-list'], request_id: requestId })}\n`);
    };
    const connect = () => {
      if (settled) return;
      const currentSocket = net.createConnection(socketPath);
      socket = currentSocket;
      currentSocket.once('error', () => {
        currentSocket.destroy();
        if (socket === currentSocket) socket = null;
        if (!settled) retryTimer = setTimeout(connect, 50);
      });
      currentSocket.once('connect', () => query(currentSocket));
      currentSocket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 256 * 1024) return finish(new Error('mpv returned an oversized track-list response.'));
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.request_id === requestId) {
            if (message.error !== 'success' || !Array.isArray(message.data)) return finish(new Error(`mpv could not read its track list: ${message.error || 'invalid response'}`));
            if (message.data.some(track => track.type === 'sub' && track.external === true && track['external-filename'] === expectedSubtitle)) return finish(null, message.data);
            retryTimer = setTimeout(() => query(currentSocket), 100);
          }
        }
      });
    };
    connect();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-runtime-'));
  let server, mpv;
  const socketPath = `/tmp/offgrid-mpv-${process.pid}.sock`;
  try {
    const sourceVideo = path.join(directory, 'generated.mp4');
    const outputVideo = path.join(directory, 'resumed.mp4');
    const subtitle = path.join(directory, 'fixture.vtt');
    const generated = await run(options.ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=5',
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sourceVideo,
    ]);
    if (generated.code !== 0 || generated.timedOut) throw new Error(`FFmpeg could not generate a disposable video fixture: ${generated.stderr.trim() || `exit ${generated.code}`}`);
    const body = fs.readFileSync(sourceVideo);
    if (body.length < 256 * 1024) throw new Error(`Generated video is too small for a useful resume check (${body.length} bytes).`);
    fs.writeFileSync(subtitle, 'WEBVTT\n\n00:00:00.000 --> 00:00:04.500\nOffgrid external subtitle smoke caption\n');
    const partialPath = `${outputVideo}.part`;
    const partialBytes = Math.floor(body.length / 4);
    fs.writeFileSync(partialPath, body.subarray(0, partialBytes));

    const requests = [];
    const etag = `"${sha256(body)}"`;
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/fixture.mp4') { response.writeHead(404); response.end(); return; }
      const range = request.headers.range;
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', ETag: etag });
        response.end();
        return;
      }
      requests.push({ method: request.method, range: range || null, ifRange: request.headers['if-range'] || null });
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
      if (start >= body.length || end < start) {
        response.writeHead(416, { 'Content-Range': `bytes */${body.length}`, ETag: etag });
        response.end();
        return;
      }
      const partial = Boolean(match);
      response.writeHead(partial ? 206 : 200, {
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'attachment; filename="fixture.mp4"',
        ETag: etag,
        ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
      });
      response.end(body.subarray(start, end + 1));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/fixture.mp4`;
    const downloadArgs = ['--ignore-config', '--no-progress', '--no-warnings', '--verbose', '--retries', '0', '--fragment-retries', '0', '--extractor-retries', '0', '--continue', '-o', outputVideo, url];
    const resumed = await run(options.ytdlp, downloadArgs);
    if (resumed.code !== 0 || resumed.timedOut) throw new Error(`yt-dlp resume failed: ${resumed.stderr.trim() || `exit ${resumed.code}`}`);
    if (!requests.some(request => request.range && request.range.startsWith(`bytes=${partialBytes}-`))) {
      throw new Error(`yt-dlp did not resume at the preserved byte offset ${partialBytes}; requests were ${JSON.stringify(requests)}.`);
    }
    const downloaded = fs.readFileSync(outputVideo);
    if (downloaded.length !== body.length || sha256(downloaded) !== sha256(body)) throw new Error('Resumed yt-dlp output does not exactly match the generated source bytes.');
    console.log(`yt-dlp resume: continued a generated byte-identical .part (${partialBytes}/${body.length} bytes), requested Range bytes=${partialBytes}-, final SHA-256 ${sha256(downloaded)} matches source.`);

    mpv = spawn(options.mpv, [
      '--no-config', '--load-scripts=no', '--ytdl=no', '--sub-auto=no', `--sub-file=${subtitle}`,
      '--vo=null', '--ao=null', '--force-window=no', '--keep-open=yes', `--input-ipc-server=${socketPath}`, '--', outputVideo,
    ], { stdio: 'ignore', shell: false });
    const tracks = await waitForMpvTrackList(socketPath, mpv, subtitle);
    const externalSubtitle = tracks.find(track => track.type === 'sub' && track.external === true && track['external-filename'] === subtitle);
    if (!externalSubtitle) throw new Error(`mpv did not expose the VTT as an external subtitle track: ${JSON.stringify(tracks)}.`);
    console.log(`bundled mpv subtitle: track ${externalSubtitle.id} loaded from ${externalSubtitle['external-filename']}; track-list verified.`);
    console.log('Playback boundary: this smoke uses --vo=null, so it proves native mpv track loading/decoding, not visible subtitle rendering in a desktop window.');
  } finally {
    if (mpv && mpv.exitCode === null) { mpv.kill('SIGTERM'); await new Promise(resolve => mpv.once('close', resolve)); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    try { fs.unlinkSync(socketPath); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
