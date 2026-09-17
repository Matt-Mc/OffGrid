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
    autoDownload:legacy, checkIntervalHours:6, recentVideoCount:3, defaultSubtitleLanguage:'', allowAutoCaptions:false};
}
function validateSettings(patch, current = defaultSettings()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
  const next = {...current};
  for (const [key,value] of Object.entries(patch)) {
    if (key === 'version' && value === 1) continue;
    if (key === 'defaultQuality' && QUALITIES.includes(value)) next[key] = value;
    else if (['saveComments','autoDownload','allowAutoCaptions'].includes(key) && typeof value === 'boolean') next[key] = value;
    else if (key === 'maxLibraryBytes' && (value === null || (Number.isSafeInteger(value) && value > 0))) next[key] = value;
    else if (key === 'checkIntervalHours' && [0,6,12,24].includes(value)) next[key] = value;
    else if (key === 'defaultSubtitleLanguage' && typeof value === 'string' && (value === '' || /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(value))) next[key] = value;
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
function checkStorageAdmission(storage, expectedBytes, workingMultiplier = 3, reusableBytes = 0, overheadBytes = 16_000_000) {
  if (!Number.isFinite(reusableBytes) || reusableBytes < 0 || !Number.isFinite(workingMultiplier) || workingMultiplier < 1 || !Number.isFinite(overheadBytes) || overheadBytes < 0)
    return 'Download workspace could not be checked. Retry when storage is available.';
  if (storage.freeBytes === null || !Number.isFinite(storage.freeBytes)) return 'Free disk space could not be checked. Retry when storage is available.';
  if (storage.freeBytes < DISK_RESERVE_BYTES) return 'Keep at least 2 GB of disk space free. Free space and retry.';
  if (!Number.isFinite(expectedBytes) && storage.maxLibraryBytes !== null)
    return 'Size unavailable. Try another quality or remove the library limit, then retry.';
  // Video/audio inputs, a merged file and a recoded MP4 may coexist. Reserve 3x
  // the full stream estimate plus 16 MB for thumbnail/metadata. Live checks catch
  // estimates that grow, rather than pretending this estimate is a hard quota.
  // Reusable files are already included in temporaryBytes and excluded from
  // freeBytes. Only reserve additional space, never credit another job's files.
  const workingBytes = Number.isFinite(expectedBytes) ? Math.max(0, Math.ceil(expectedBytes * workingMultiplier) + overheadBytes - reusableBytes) : 0;
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

const QUEUE_VERSION = 2;
const JOB_STATES = new Set(['queued', 'preparing', 'downloading', 'processing', 'paused', 'waiting-storage', 'waiting-network', 'complete', 'error', 'canceled']);
const ACTIVE_STATES = new Set(['preparing', 'downloading', 'processing']);
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function readQueue(file) {
  if (!fs.existsSync(file)) return {version:QUEUE_VERSION,jobs:[],paused:false};
  // Unlike general settings reads, queue recovery must never overwrite a file
  // whose version or contents we cannot interpret.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!saved || typeof saved !== 'object' || (saved.version !== undefined && ![1,QUEUE_VERSION].includes(saved.version)))
    throw new Error('This download queue was written by an unsupported version of Offgrid.');
  if (!Array.isArray(saved.jobs) || typeof saved.paused !== 'boolean') throw new Error('The saved download queue is invalid.');
  const ids = new Set();
  for (const job of saved.jobs) {
    if (!job || !JOB_ID.test(job.id) || ids.has(job.id) || !JOB_STATES.has(job.status)) throw new Error('The saved download queue contains an invalid job.');
    ids.add(job.id);
  }
  return saved;
}
function sameSource(left, right) {
  return Boolean((left.sourceId && left.sourceId === right.sourceId) || (left.url && left.url === right.url));
}
function transientFailure(error) {
  if (error?.retryable === false || /authenticat|permission|denied|unauthoriz|forbidden|different.*server|identity|unsupported|invalid|unavailable/i.test(error?.message || '')) return false;
  return error?.retryable === true || /network|ENOTFOUND|ENETUNREACH|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EPIPE|connection|timed out|offline|interrupted|incomplete/i.test(error?.message || '');
}

class DurableQueue {
  constructor({file, execute, cleanup = () => {}, notify = () => {}, canRun = () => true, recover, retain, retryDelays = [5000,15000,60000]}) {
    this.file=file; this.execute=execute; this.cleanup=cleanup; this.notify=notify; this.canRun=canRun;
    this.recover=recover; this.retain=retain; this.retryDelays=retryDelays;
    this.active=null; this.running=false; this.shuttingDown=false; this.retryTimer=null; this.warning=null;
    this.jobs=[]; this.paused=false;
    let saved;
    try { saved=readQueue(file); }
    catch(error) { this.warning=`Downloads are paused to protect saved data. ${error.message} The original queue has been preserved.`; return; }
    this.jobs=saved.jobs; this.paused=saved.paused;
    for (const job of this.jobs) {
      if (job.status === 'complete') continue;
      const interrupted=ACTIVE_STATES.has(job.status);
      try {
        const patch=this.recover ? this.recover(job) : (this.cleanup(job), {retainedBytes:0,resumable:false});
        if (patch && typeof patch.then === 'function') throw new Error('Download recovery must finish before the queue starts.');
        Object.assign(job,patch || {});
        if (interrupted && job.status !== 'complete') Object.assign(job,{status:'paused',nextRetryAt:null,error:null,
          message:job.resumable ? 'Interrupted. Resume the retained download.' : 'Interrupted. Resume to restart this download.'});
      } catch(error) {
        Object.assign(job,{status:'paused',recoveryBlocked:true,nextRetryAt:null,error:error.message,message:`Recovery needs attention: ${error.message}`});
      }
    }
    this.persist();
    this._scheduleRetry();
  }
  _assertWritable() { if(this.warning) throw new Error(this.warning); }
  _write(jobs=this.jobs, paused=this.paused) { this._assertWritable(); atomicWriteJson(this.file,{version:QUEUE_VERSION,jobs,paused}); }
  _notify() { try { this.notify(this.snapshot()); } catch {} }
  snapshot() { return {version:QUEUE_VERSION,jobs:this.jobs,paused:this.paused,warning:this.warning}; }
  persist() { this._write(); }
  emit() { this.persist(); this._notify(); }
  update(id,patch,{allowStoppedCompletion=false}={}) {
    this._assertWritable();
    const job=this.jobs.find(item=>item.id===id); if(!job) return;
    if(job.status==='complete' && patch.status && patch.status!=='complete') return;
    if(patch.status==='complete' && !allowStoppedCompletion && (this.active?.id!==id || this.active.stopReason)) return;
    // Unwinding an old operation cannot restart a paused/canceled row.
    if(ACTIVE_STATES.has(patch.status) && (this.active?.id!==id || this.active.stopReason)) return;
    const next={...job,...patch,updatedAt:new Date().toISOString()};
    this._write(this.jobs.map(item=>item===job ? next : item));
    Object.assign(job,next); this._notify(); return job;
  }
  addMany(entries) {
    this._assertWritable();
    if(!Array.isArray(entries) || entries.length>500) throw new Error('Choose at most 500 downloads at a time.');
    const next=[...this.jobs],results=[];
    for(const data of entries) {
      if(!data || typeof data!=='object' || Array.isArray(data) || typeof data.url!=='string' || !data.url || data.url.length>8192)
        throw new Error('Invalid download entry.');
      const duplicate=next.find(job=>!TERMINAL.has(job.status) && sameSource(data,job));
      if(duplicate) {results.push({outcome:'alreadyQueued',id:duplicate.id,job:duplicate});continue;}
      const job={...data,id:crypto.randomUUID(),status:'queued',progress:0,error:null,retainedBytes:0,resumable:false,
        retryCount:0,nextRetryAt:null,message:'Waiting to download',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      next.push(job); results.push({outcome:'added',id:job.id,job});
    }
    // The worker must never observe a partly persisted submission.
    if(next.length!==this.jobs.length) {this._write(next);this.jobs=next;this._notify();}
    void this.pump(); return results;
  }
  add(data) { return this.addMany([data])[0].job; }
  pause(paused) {
    this._assertWritable(); if(typeof paused!=='boolean') throw new Error('Invalid queue state.');
    this._write(this.jobs,paused);this.paused=paused;this._notify();this._scheduleRetry();
    if(!paused) void this.pump(); return this.snapshot();
  }
  _job(id) { this._assertWritable();const job=this.jobs.find(item=>item.id===id);if(!job) throw new Error('Download not found.');return job; }
  async cancel(id) {
    const job=this._job(id);if(job.status==='complete') return this.snapshot();
    if(this.active?.id===id) {this.active.stop('canceled','Canceled');await this.active.done;}
    else {this.cleanup(job);this.update(id,{status:'canceled',message:'Canceled',error:null,nextRetryAt:null,retainedBytes:0,resumable:false});}
    this._scheduleRetry();return this.snapshot();
  }
  async pauseJob(id) {
    const job=this._job(id);if(job.status==='complete' || job.status==='canceled') throw new Error('This download cannot be paused.');
    if(this.active?.id===id) {this.active.stop('paused','Paused');await this.active.done;}
    else this.update(id,{status:'paused',message:'Paused',error:null,nextRetryAt:null});
    this._scheduleRetry();return this.snapshot();
  }
  retry(id,options={}) {
    const job=this._job(id);
    if(!['paused','error','canceled','waiting-storage','waiting-network'].includes(job.status)) throw new Error('This download cannot be retried yet.');
    if(job.recoveryBlocked) throw new Error('This download has an unreadable recovery checkpoint. Discard it before adding it again.');
    if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(key=>!['quality','copyQuality'].includes(key))) throw new Error('Invalid retry options.');
    if(options.quality!==undefined && !QUALITIES.includes(options.quality)) throw new Error('Invalid download quality.');
    const server=['plex','jellyfin'].includes(job.provider);
    if(server && options.quality!==undefined) throw new Error('Server downloads keep their original quality.');
    if(options.copyQuality!==undefined && (!server || !['original','720p'].includes(options.copyQuality))) throw new Error('Invalid saved copy quality.');
    if(this.jobs.some(other=>other.id!==id && !TERMINAL.has(other.status) && sameSource(job,other))) throw new Error('This video already has a download in the queue.');
    let patch={};
    if(options.quality!==undefined && options.quality!==job.quality) {
      // Do not credit space until cleanup succeeds. Complete original server
      // inputs survive copyQuality changes and are reconciled by the adapter.
      this.cleanup(job);patch={retainedBytes:0,resumable:false,expectedBytes:null,progress:0};
    }
    this.update(id,{...patch,...options,status:'queued',error:null,message:job.resumable && !('resumable' in patch) ? 'Waiting to resume' : 'Waiting to download',
      retryCount:0,nextRetryAt:null,explicitRetry:true});
    this._scheduleRetry();void this.pump();return this.snapshot();
  }
  resume(id,options={}) { return this.retry(id,options); }
  _scheduleRetry() {
    clearTimeout(this.retryTimer);this.retryTimer=null;
    if(this.warning || this.paused || this.shuttingDown) return;
    const times=this.jobs.filter(job=>job.status==='waiting-network' && Number.isFinite(job.nextRetryAt) && !job.recoveryBlocked).map(job=>job.nextRetryAt);
    if(!times.length) return;
    this.retryTimer=setTimeout(()=>{this.retryTimer=null;void this.pump();},Math.max(0,Math.min(...times)-Date.now()));
    this.retryTimer.unref?.();
  }
  _active(id) {
    let finish,signalStop;
    const writers=new Set(),childClosures=new Map();
    const active={id,children:new Set(),controller:new AbortController(),stopReason:null,
      stopped:new Promise(resolve=>{signalStop=resolve;}),done:new Promise(resolve=>{finish=resolve;}),finish};
    active.finish=finish;
    active.trackWriter=promise=>{
      const settled=Promise.resolve(promise).then(()=>{},()=>{});writers.add(settled);settled.then(()=>writers.delete(settled));return promise;
    };
    const add=active.children.add.bind(active.children);
    active.children.add=child=>{
      if(typeof child.once==='function' && !childClosures.has(child)) {
        childClosures.set(child,new Promise(resolve=>child.once('close',resolve)));
      }
      add(child);return active.children;
    };
    active.stop=(status,message)=>{
      if(active.stopReason) return;
      active.stopReason={status,message};active.controller.abort();signalStop(active.stopReason);
      active.termination=Promise.all([...active.children].map(child=>killProcessTree(child)))
        .then(()=>null,error=>{active.terminationError=error;return error;});
    };
    active.drain=async()=>{await Promise.all([...childClosures.values(),...writers]);await active.termination;};
    return active;
  }
  async pump() {
    if(this.warning || this.running || this.paused || this.shuttingDown) return;
    this.running=true;
    try {
      for(const job of this.jobs) if(job.status==='waiting-network' && Number.isFinite(job.nextRetryAt) && job.nextRetryAt<=Date.now() && !job.recoveryBlocked)
        this.update(job.id,{status:'queued',message:job.resumable ? 'Waiting to resume' : 'Retrying connection',nextRetryAt:null});
      while(!this.paused && !this.shuttingDown) {
        const pending=this.jobs.filter(job=>job.status==='queued' && !job.recoveryBlocked && this.canRun(job));
        const job=pending.find(item=>item.source==='manual') || pending[0];if(!job) break;
        const active=this._active(job.id);this.active=active;
        try {
          this.update(job.id,{status:'preparing',message:'Reading video details…',error:null});
          await Promise.race([Promise.resolve(this.execute(job,active)),active.stopped.then(reason=>{throw new Error(reason.message);})]);
          if(active.stopReason) throw new Error(active.stopReason.message);
          await active.drain();
        } catch(error) {
          const outcome=active.stopReason || {status:transientFailure(error) ? 'waiting-network' : 'error',message:error.message || 'Download failed.'};
          if(!active.stopReason) active.stop(outcome.status,outcome.message);
          // Aborting the controller is not evidence that file writers closed.
          // Child close events and adapter writer promises establish that boundary.
          await active.drain();
          let patch={retainedBytes:0,resumable:false};
          try {
            if(active.terminationError) throw active.terminationError;
            if(outcome.status==='canceled') this.cleanup(job);
            else if(this.retain) patch={...patch,...await this.retain(job,outcome)};
            else this.cleanup(job);
          } catch(retentionError) {
            Object.assign(outcome,{status:'paused',message:`Recovery needs attention: ${retentionError.message}`});
            patch.recoveryBlocked=true;
            if(active.terminationError) this.paused=true;
          }
          if(patch.status==='complete') {
            this.update(job.id,{...patch,retryCount:0,nextRetryAt:null},{allowStoppedCompletion:true});
            continue;
          }
          const retryCount=Number.isInteger(job.retryCount) ? job.retryCount : 0;
          const delay=outcome.status==='waiting-network' ? this.retryDelays[retryCount] : undefined;
          this.update(job.id,{...patch,status:outcome.status,message:outcome.message,error:['paused','canceled'].includes(outcome.status)?null:outcome.message,
            progress:patch.resumable ? job.progress || 0 : 0,
            retryCount:delay===undefined ? retryCount : retryCount+1,nextRetryAt:delay===undefined ? null : Date.now()+delay});
        } finally {this.active=null;active.finish();}
      }
    } catch(error) {
      this.warning=`Downloads are paused because queue state could not be saved: ${error.message}. Existing files have been preserved.`;
      this._notify();
    } finally {this.running=false;this._scheduleRetry();}
  }
  async shutdown() {
    this.shuttingDown=true;clearTimeout(this.retryTimer);this.retryTimer=null;
    if(this.active) {this.active.stop('paused','Interrupted. Resume when ready.');await this.active.done;}
    if(!this.warning) this.persist();
  }
}

module.exports={QUALITIES,DISK_RESERVE_BYTES,atomicWriteJson,readJson,defaultSettings,validateSettings,getExpectedSize,directoryBytes,checkStorageAdmission,sourceIdFromUrl,DurableQueue};
