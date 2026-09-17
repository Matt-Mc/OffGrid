'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function runFfmpeg(command, args, { spawnProcess = spawn, onProgress, timeoutMs = 6 * 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, ['-nostdin', ...args]);
    let output = '', failure;
    const timer = setTimeout(() => { failure = new Error('Media processing timed out.'); child.kill('SIGKILL'); }, timeoutMs);
    const collect = chunk => {
      output = (output + chunk.toString()).slice(-128 * 1024);
      if(failure) return;
      try {onProgress?.(chunk.toString());}
      catch(error) {failure=error;child.kill('SIGKILL');}
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error('Media processing could not finish. Retry or keep the original file.'));
      resolve(output);
    });
  });
}
function parseMediaInfo(output) {
  output=output.split('Stream mapping:')[0];
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(output);
  const videoLine = output.split('\n').find(line => /Stream #.*Video:/.test(line)) || '';
  const dimensions = /(?:^|[ ,])(\d{2,6})x(\d{2,6})(?:[ ,\[]|$)/.exec(videoLine);
  const codec = /Video:\s*([\w-]+)/.exec(videoLine)?.[1];
  if (!duration || !dimensions || !codec) throw new Error('The original media could not be inspected. Keep Original quality for this file.');
  const subtitles = output.split('\n').filter(line => /Stream #.*Subtitle:/.test(line)).map(line => ({
    index: Number(/Stream #0:(\d+)/.exec(line)?.[1]),
    language: /Stream #0:\d+(?:\[[^\]]+\])?\(([^)]+)\)/.exec(line)?.[1] || 'und',
    codec: /Subtitle:\s*([\w-]+)/.exec(line)?.[1]
  }));
  return { duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]), width: Number(dimensions[1]), height: Number(dimensions[2]), codec,
    audioCount: output.split('\n').filter(line => /Stream #.*Audio:/.test(line)).length,
    hdr: /smpte2084|arib-std-b67|dovi|dolby vision|mastering display|content light level/i.test(output), subtitles };
}
async function inspectMedia(command, file, options = {}) {
  const output = await runFfmpeg(command, ['-hide_banner', '-i', file, '-map', '0:v:0', '-map', '0:a?', '-t', '0', '-f', 'null', '-'], { ...options, timeoutMs: 60_000 });
  return parseMediaInfo(output);
}
async function smallerCopy({ command, input, output, jobId, spawnProcess, onProgress, assertActive }) {
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The original file could not be read safely.');
  const source = await inspectMedia(command, input, { spawnProcess }); assertActive();
  if (source.hdr) throw new Error('Smaller HDR copies are not supported yet. Choose Keep original to preserve its colors.');
  if (source.subtitles.length>2 || source.subtitles.some(track => !['subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text', 'text'].includes(track.codec) || !Number.isSafeInteger(track.index))) throw new Error('This file needs Original quality to preserve all subtitle tracks. Choose Keep original.');
  const encoders = await runFfmpeg(command, ['-hide_banner', '-encoders'], { spawnProcess, timeoutMs: 30_000 }); assertActive();
  if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders)) throw new Error('The video tools cannot create a smaller copy. Update them or choose Keep original.');
  await runFfmpeg(command, ['-hide_banner', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '2000k', '-bufsize', '4000k', '-vf', "scale=-2:'trunc(min(720,ih)/2)*2'", '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-progress', 'pipe:1', output], { spawnProcess, onProgress }); assertActive();
  const result = await inspectMedia(command, output, { spawnProcess }); assertActive();
  if (result.height > 720 || result.height > source.height || result.codec !== 'h264' || result.audioCount !== source.audioCount || Math.abs(result.duration - source.duration) > Math.max(1, source.duration * 0.005)) throw new Error('The smaller copy did not pass media checks. Retry or keep the original.');
  if (fs.statSync(output).size >= stat.size) throw new Error('A smaller file could not be made from this video. Choose Keep original or retry.');
  await runFfmpeg(command, ['-hide_banner', '-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], { spawnProcess }); assertActive();
  const subtitles = [];
  for (const [index, track] of source.subtitles.entries()) {
    const target = path.join(path.dirname(output), `${jobId}.embedded-${index}.vtt`);
    await runFfmpeg(command, ['-hide_banner', '-y', '-i', input, '-map', `0:${track.index}`, '-f', 'webvtt', target], { spawnProcess }); assertActive();
    subtitles.push({ file: target, format: 'vtt', language: /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/i.test(track.language) ? track.language : 'und', origin: 'embedded' });
  }
  return { filePath: output, sizeBytes: fs.statSync(output).size, sourceBytes: stat.size, duration: result.duration, subtitles };
}
module.exports = { runFfmpeg, parseMediaInfo, inspectMedia, smallerCopy };
