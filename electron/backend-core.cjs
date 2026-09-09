const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { killProcessTree } = require('./process-tree.cjs');
const QUALITIES = ['480p', '720p', '1080p', 'best'];
const DISK_RESERVE_BYTES = 2_000_000_000;
const TERMINAL = new Set(['complete', 'error', 'canceled']);

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    // Preserve corrupt state for recovery instead of silently overwriting it.
    fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    return fallback;
  }
}
function defaultSettings(legacy = false) {
  return {version:1, defaultQuality:'720p', saveComments:legacy, maxLibraryBytes:null,
    autoDownload:legacy, checkIntervalHours:6, recentVideoCount:3};
}
function validateSettings(patch, current = defaultSettings()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
  const next = {...current};
  for (const [key,value] of Object.entries(patch)) {
    if (key === 'version' && value === 1) continue;
    if (key === 'defaultQuality' && QUALITIES.includes(value)) next[key] = value;
    else if (['saveComments','autoDownload'].includes(key) && typeof value === 'boolean') next[key] = value;
    else if (key === 'maxLibraryBytes' && (value === null || (Number.isSafeInteger(value) && value > 0))) next[key] = value;
    else if (key === 'checkIntervalHours' && [0,6,12,24].includes(value)) next[key] = value;
    else if (key === 'recentVideoCount' && [1,3,5,10].includes(value)) next[key] = value;
    else throw new Error(`Invalid value for ${key}.`);
  }
  return next;
}
function getExpectedSize(metadata) {
  const formats = metadata.requested_formats?.length ? metadata.requested_formats : [metadata];
  const sizes = formats.map(format => format.filesize ?? format.filesize_approx);
  return sizes.length && sizes.every(size => Number.isFinite(size) && size > 0)
    ? sizes.reduce((total,size) => total + size, 0) : null;
}
function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    const file = path.join(directory,entry.name);
    try {
      // Never follow symlinks while accounting or cleaning application-owned files.
      if (entry.isDirectory()) bytes += directoryBytes(file);
      else if (entry.isFile()) bytes += fs.statSync(file).size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return bytes;
}
function checkStorageAdmission(storage, expectedBytes, workingMultiplier = 3) {
  if (storage.freeBytes === null || !Number.isFinite(storage.freeBytes)) return 'Free disk space could not be checked. Retry when storage is available.';
  if (storage.freeBytes < DISK_RESERVE_BYTES) return 'Keep at least 2 GB of disk space free. Free space and retry.';
  if (!Number.isFinite(expectedBytes) && storage.maxLibraryBytes !== null)
    return 'Size unavailable. Try another quality or remove the library limit, then retry.';
  // Video/audio inputs, a merged file and a recoded MP4 may coexist. Reserve 3x
  // the full stream estimate plus 16 MB for thumbnail/metadata. Live checks catch
  // estimates that grow, rather than pretending this estimate is a hard quota.
  const workingBytes = Number.isFinite(expectedBytes) ? Math.ceil(expectedBytes * workingMultiplier) + 16_000_000 : 0;
  if (storage.maxLibraryBytes !== null && storage.savedBytes + storage.temporaryBytes + workingBytes > storage.maxLibraryBytes)
    return 'Not enough room under the library limit, including processing space. Free space, lower quality or increase the limit, then retry.';
  if (storage.freeBytes < DISK_RESERVE_BYTES + workingBytes)
    return 'Not enough disk space for this download and processing. Free space or lower quality, then retry.';
  return null;
}
function sourceIdFromUrl(value) {
  try { const url = new URL(value); return url.hostname.endsWith('youtu.be') ? url.pathname.split('/')[1] : url.searchParams.get('v') || (['shorts','live','embed'].includes(url.pathname.split('/')[1]) ? url.pathname.split('/')[2] : null); }
  catch { return null; }
}

class DurableQueue {
  constructor({file, execute, cleanup, notify, canRun = () => true}) {
    this.file=file; this.execute=execute; this.cleanup=cleanup; this.notify=notify; this.canRun=canRun;
    const saved=readJson(file,{jobs:[],paused:false});
    this.jobs=Array.isArray(saved.jobs) ? saved.jobs.filter(job => typeof job.id==='string' && /^[a-f0-9-]{36}$/.test(job.id)) : [];
    this.paused=Boolean(saved.paused); this.active=null; this.running=false; this.shuttingDown=false;
    for (const job of this.jobs) {
      if (['preparing','downloading','processing'].includes(job.status)) {
        cleanup(job); Object.assign(job,{status:'error',error:'Offgrid closed before this download finished. Retry to start again.',message:'Interrupted. Retry to start again.',progress:0});
      } else if (job.status !== 'complete') cleanup(job);
    }
    this.persist();
  }
  snapshot() { return {jobs:this.jobs,paused:this.paused}; }
  persist() { atomicWriteJson(this.file,this.snapshot()); }
  emit() { this.persist(); this.notify(this.snapshot()); }
  update(id,patch) {
    const job=this.jobs.find(item=>item.id===id); if (!job) return;
    if (job.status==='complete' && patch.status && patch.status!=='complete') return;
    Object.assign(job,patch,{updatedAt:new Date().toISOString()}); this.emit(); return job;
  }
  add(data) {
    const duplicate=this.jobs.find(job => !TERMINAL.has(job.status) && ((data.sourceId && job.sourceId===data.sourceId) || job.url===data.url));
    if (duplicate) return duplicate;
    const job={id:crypto.randomUUID(),...data,status:'queued',progress:0,error:null,message:'Waiting to download',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    this.jobs.push(job); this.emit(); void this.pump(); return job;
  }
  pause(paused) { if(typeof paused!=='boolean') throw new Error('Invalid queue state.'); this.paused=paused; this.emit(); if(!paused) void this.pump(); return this.snapshot(); }
  async cancel(id) {
    const job=this.jobs.find(item=>item.id===id); if(!job) throw new Error('Download not found.');
    if(job.status==='complete') return this.snapshot();
    if(this.active?.id===id) { this.active.stop('canceled','Canceled'); await this.active.done; }
    else { this.cleanup(job); this.update(id,{status:'canceled',message:'Canceled',error:null}); }
    return this.snapshot();
  }
  retry(id,options={}) {
    const job=this.jobs.find(item=>item.id===id); if(!job) throw new Error('Download not found.');
    if(!['error','canceled','waiting-storage','waiting-network'].includes(job.status)) throw new Error('This download cannot be retried yet.');
    if(!options || typeof options!=='object' || Object.keys(options).some(key=>key!=='quality')) throw new Error('Invalid retry options.');
    if(options.quality!==undefined && !QUALITIES.includes(options.quality)) throw new Error('Invalid download quality.');
    if(['plex','jellyfin'].includes(job.provider) && options.quality!==undefined) throw new Error('Server downloads keep their original quality.');
    if(this.jobs.some(other=>other.id!==id && !TERMINAL.has(other.status) && ((job.sourceId && other.sourceId===job.sourceId) || other.url===job.url))) throw new Error('This video already has a download in the queue.');
    this.cleanup(job); this.update(id,{status:'queued',quality:options.quality || job.quality,error:null,message:'Waiting to download',progress:0,explicitRetry:true});
    void this.pump(); return this.snapshot();
  }
  async pump() {
    if(this.running || this.paused || this.shuttingDown) return;
    this.running=true;
    try {
      while(!this.paused && !this.shuttingDown) {
        const pending=this.jobs.filter(job=>job.status==='queued' && this.canRun(job));
        const job=pending.find(item=>item.source==='manual') || pending[0]; if(!job) break;
        let finish, signalStop;
        const active={id:job.id,children:new Set(),controller:new AbortController(),stopReason:null,
          stopped:new Promise(resolve=>{signalStop=resolve;}),
          done:new Promise(resolve=>{finish=resolve;})};
        active.stop=(status,message)=>{
          if(active.stopReason) return;
          active.stopReason={status,message};
          active.controller.abort();
          signalStop(active.stopReason);
          active.termination = Promise.all([...active.children].map(child => killProcessTree(child)))
            .then(() => null, error => error);
        };
        this.active=active;
        this.update(job.id,{status:'preparing',message:'Reading video details…',error:null});
        try {
          await this.execute(job,active);
          if(active.stopReason) throw new Error(active.stopReason.message);
        } catch(error) {
          const terminationError = await active.termination;
          if (terminationError) {
            this.paused = true;
            active.stopReason = {status:'error',message:terminationError.message};
          } else this.cleanup(job);
          const outcome=active.stopReason || {status:/network|ENOTFOUND|ENETUNREACH|EAI_AGAIN|connection|timed out|offline/i.test(error.message) ? 'waiting-network' : 'error',message:error.message || 'Download failed.'};
          this.update(job.id,{status:outcome.status,message:outcome.message,error:outcome.status==='canceled'?null:outcome.message,progress:0});
        } finally { this.active=null; finish(); }
      }
    } finally { this.running=false; }
  }
}
module.exports={QUALITIES,DISK_RESERVE_BYTES,atomicWriteJson,readJson,defaultSettings,validateSettings,getExpectedSize,directoryBytes,checkStorageAdmission,sourceIdFromUrl,DurableQueue};
