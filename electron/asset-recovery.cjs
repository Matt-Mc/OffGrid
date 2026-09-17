'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_JOURNAL_BYTES = 128 * 1024;
const fail = message => { throw new Error(message || 'Subtitle recovery needs attention. Its files were preserved.'); };
function directory(value, optional = false) {
  let stat;
  try { stat = fs.lstatSync(value); } catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Subtitle recovery directory is unsafe.');
  return true;
}
function regular(file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Subtitle recovery file is unsafe.');
  return stat;
}
function identity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size }; }
function matching(file, expected, optional = false) {
  const stat = regular(file, optional);
  if (stat && (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size)) fail('Subtitle recovery file changed. Its files were preserved.');
  return stat;
}
function syncDirectory(value) {
  // Windows does not support flushing directory handles through Node's fsync.
  // Journal contents and staged files are still flushed before publishing them.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(value, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function createAssetRecovery({ workDirectory, assetsDirectory, getLibrary, saveLibrary }) {
  const root = path.resolve(workDirectory), destination = path.resolve(assetsDirectory);
  function locations(job) {
    if (!job || !UUID.test(job.id)) fail('Invalid subtitle recovery job.');
    directory(root); directory(destination);
    const work = path.join(root, job.id);
    directory(work, true);
    return { work, journal: path.join(work, 'assets-journal.json') };
  }
  function assetRecord(videoId, asset, targetDirectory) {
    if (!UUID.test(videoId) || !asset || !UUID.test(asset.id) || asset.kind !== 'subtitle' || asset.format !== 'vtt' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(asset.language) || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > 5 * 1024 * 1024) fail('Invalid subtitle recovery asset.');
    const filePath = path.join(targetDirectory, `${videoId}.${asset.id}.vtt`);
    if (asset.filePath !== filePath) fail('Subtitle recovery asset is outside its owner directory.');
    return { id: asset.id, kind: 'subtitle', language: asset.language, format: 'vtt', origin: typeof asset.origin === 'string' ? asset.origin.slice(0, 40) : 'manual', filePath, sizeBytes: asset.sizeBytes };
  }
  function validate(job, value) {
    const { work } = locations(job);
    if (job.targetVideoId && value?.videoId !== job.targetVideoId) fail('Subtitle journal belongs to a different video.');
    if (!value || value.version !== 1 || value.jobId !== job.id || !UUID.test(value.videoId) || !Array.isArray(value.entries) || value.entries.length > 10 || !Array.isArray(value.replaced) || value.replaced.length > 100 || !Array.isArray(value.warnings) || value.warnings.length > 100 || value.warnings.some(warning => typeof warning !== 'string' || warning.length > 2000)) fail('Unsupported or invalid subtitle recovery journal.');
    const ids = new Set();
    for (const entry of value.entries) {
      assetRecord(value.videoId, entry.asset, destination);
      if (ids.has(entry.asset.id) || entry.source !== path.join(work, `${value.videoId}.${entry.asset.id}.vtt`)) fail();
      ids.add(entry.asset.id);
      if (!entry.identity || ![entry.identity.dev,entry.identity.ino,entry.identity.size].every(Number.isSafeInteger) || entry.identity.size !== entry.asset.sizeBytes) fail();
    }
    const replacedIds = new Set();
    for (const entry of value.replaced) {
      assetRecord(value.videoId, entry.asset, destination);
      if (ids.has(entry.asset.id) || replacedIds.has(entry.asset.id)) fail();
      replacedIds.add(entry.asset.id);
      if (entry.identity !== null && (!entry.identity || ![entry.identity.dev,entry.identity.ino,entry.identity.size].every(Number.isSafeInteger) || entry.identity.size !== entry.asset.sizeBytes)) fail();
    }
    return value;
  }
  function read(job) {
    const { journal } = locations(job);
    const stat = regular(journal, true);
    if (!stat) return null;
    if (stat.size > MAX_JOURNAL_BYTES) fail('Subtitle recovery journal is too large.');
    let value;
    try { value = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch { fail('Subtitle recovery journal could not be read. Its files were preserved.'); }
    return validate(job, value);
  }
  function write(job, value) {
    const { work, journal } = locations(job);
    directory(work);
    const temporary = path.join(work, `.assets-journal-${crypto.randomUUID()}.tmp`);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) fail('Subtitle recovery journal is too large.');
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, journal); syncDirectory(work); } finally { fs.unlinkSync(temporary); }
  }
  function referenced(asset) {
    return getLibrary().some(video => (video.assets || []).some(item => item.id === asset.id && item.filePath === asset.filePath));
  }
  function removeOwned(file, expected) {
    if (matching(file, expected, true)) fs.unlinkSync(file);
  }
  function finish(job) {
    const { work, journal } = locations(job);
    fs.unlinkSync(journal); syncDirectory(work); syncDirectory(destination);
  }
  function cleanupReplaced(value) {
    for (const entry of value.replaced) {
      if (entry.identity && !referenced(entry.asset)) removeOwned(entry.asset.filePath, entry.identity);
    }
  }
  function completePatch(value) {
    return { status: 'complete', videoId: value.videoId, retainedBytes: 0, resumable: false, progress: 100, error: null, message: 'Subtitle update finished.' };
  }
  function rollback(job, value) {
    // Only new files named in this journal are eligible. Other jobs and prior
    // subtitles remain untouched, including a file another operation replaced.
    for (const entry of value.entries) {
      if (!referenced(entry.asset)) removeOwned(entry.asset.filePath, entry.identity);
      removeOwned(entry.source, entry.identity);
    }
    finish(job);
    return completePatch(value);
  }
  function recover(job) {
    const value = read(job);
    if (!value) return {};
    if (!getLibrary().some(video => video.id === value.videoId)) return rollback(job, value);
    // Validate every file before moving any. Existing destinations are allowed
    // only when they are the same inode created by an earlier interrupted link.
    for (const entry of value.entries) {
      const source = matching(entry.source, entry.identity, true), target = matching(entry.asset.filePath, entry.identity, true);
      if (!source && !target) fail('A staged subtitle is missing. Its journal was preserved.');
    }
    for (const entry of value.entries) {
      if (!regular(entry.asset.filePath, true)) { matching(entry.source, entry.identity); fs.linkSync(entry.source, entry.asset.filePath); syncDirectory(destination); }
      removeOwned(entry.source, entry.identity);
    }
    const latest = getLibrary();
    const video = latest.find(item => item.id === value.videoId);
    if (!video) return rollback(job, value);
    const alreadySaved = value.entries.every(entry => (video.assets || []).some(asset => asset.id === entry.asset.id && asset.filePath === entry.asset.filePath));
    if (!alreadySaved || !value.entries.length) {
      const removed = new Set(value.replaced.map(entry => `${entry.asset.id}:${entry.asset.filePath}`));
      const fresh = new Set(value.entries.map(entry => entry.asset.id));
      const next = { ...video, assets: [...(video.assets || []).filter(asset => !removed.has(`${asset.id}:${asset.filePath}`) && !fresh.has(asset.id)), ...value.entries.map(entry => entry.asset)], assetWarnings: value.warnings };
      saveLibrary(latest.map(item => item.id === video.id ? next : item));
    }
    cleanupReplaced(value); finish(job);
    return completePatch(value);
  }
  function commit(job, { videoId, assets, sources, replaced = [], warnings = [] }) {
    if (read(job)) fail('A subtitle update is already waiting for recovery.');
    if (!Array.isArray(assets) || !Array.isArray(sources) || assets.length !== sources.length || !Array.isArray(replaced)) fail('Invalid subtitle update.');
    const { work } = locations(job);
    const video = getLibrary().find(item => item.id === videoId);
    if (!video) fail('This video is no longer in your library.');
    const entries = assets.map((asset,index) => {
      const record = assetRecord(videoId,asset,destination), source = typeof sources[index] === 'string' ? sources[index] : sources[index]?.filePath;
      if (source !== path.join(work, `${videoId}.${record.id}.vtt`)) fail('A staged subtitle is outside its owner directory.');
      if (regular(record.filePath,true)) fail('A subtitle already exists at the destination.');
      const stat = regular(source);
      if (stat.size !== record.sizeBytes) fail('A staged subtitle changed before saving.');
      // Windows requires a writable handle for FlushFileBuffers/fsync.
      const fd=fs.openSync(source,process.platform === 'win32' ? 'r+' : 'r'); try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      return { asset: record, source, identity: identity(stat) };
    });
    const prior = replaced.map(asset => {
      const record = assetRecord(videoId,asset,destination);
      if (!(video.assets || []).some(item => item.id === record.id && item.filePath === record.filePath)) fail('A replaced subtitle does not belong to this video.');
      const stat = regular(record.filePath,true);
      return { asset:record, identity:stat ? identity(stat) : null };
    });
    const value = validate(job,{version:1,jobId:job.id,videoId,entries,replaced:prior,warnings});
    write(job,value);
    return recover(job);
  }
  function discard(job) {
    const value = read(job);
    if (!value) return {};
    // A library save is the commit point. Complete cleanup once any new asset
    // is referenced; otherwise rollback only this job's staged/new files.
    return value.entries.some(entry => referenced(entry.asset)) ? recover(job) : rollback(job,value);
  }
  return { commit, recover, discard };
}
module.exports = { createAssetRecovery };
