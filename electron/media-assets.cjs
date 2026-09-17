'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

function timestamp(value) {
  const match=/^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if(!match || Number(match[2])>59 || Number(match[3])>59) return null;
  return Number(match[1] || 0)*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;
}
function validateCues(text) {
  let count=0;
  for(const line of text.split('\n').filter(line=>line.includes('-->'))) {
    const match=/^(\S+)\s+-->\s+(\S+)(?:[ \t]+.*)?$/.exec(line);
    const start=match && timestamp(match[1]),end=match && timestamp(match[2]);
    if(start===null || end===null || start===false || end===false || !match || end<=start) throw new Error('The source returned invalid subtitle timing.');
    count++;
  }
  if(!count) throw new Error('The source returned a subtitle with no cues.');
  return text;
}

function readSubtitle(file, format) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SUBTITLE_BYTES || stat.size === 0) throw new Error('Subtitle file is empty, unsafe, or larger than 5 MB.');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (text.includes('\0') || text.includes('\uFFFD') || /<(?:html|script)\b/i.test(text)) throw new Error('The source returned an invalid text subtitle.');
  if (format === 'vtt') {
    if (!/^WEBVTT(?:[ \t].*)?\n/.test(text) || !/\d{2}:\d{2}(?:\.\d{3})?\s+-->/.test(text)) throw new Error('The source returned an invalid WebVTT subtitle.');
    return validateCues(text);
  }
  if (format !== 'srt' || !/\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(text)) throw new Error('The source returned an unsupported subtitle format.');
  return validateCues('WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'));
}
function subtitleAsset({ file, format, language, origin, outputDirectory, ownerId }) {
  if (!/^[a-f0-9-]{36}$/.test(ownerId) || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)) throw new Error('Invalid subtitle identity.');
  const text = readSubtitle(file, format), id = crypto.randomUUID();
  const filePath = path.join(outputDirectory, `${ownerId}.${id}.vtt`);
  fs.writeFileSync(filePath, text, { flag: 'wx', mode: 0o600 });
  return { id, kind: 'subtitle', language, origin, format: 'vtt', filePath, sizeBytes: Buffer.byteLength(text) };
}
function ownedAssetPath(directory, videoId, asset) {
  if (!/^[a-f0-9-]{36}$/.test(videoId) || !asset || !/^[a-f0-9-]{36}$/.test(asset.id) || asset.kind !== 'subtitle' || asset.format !== 'vtt') return null;
  const target = path.join(directory, `${videoId}.${asset.id}.vtt`);
  return asset.filePath === target ? target : null;
}
module.exports = { MAX_SUBTITLE_BYTES, readSubtitle, subtitleAsset, ownedAssetPath };
