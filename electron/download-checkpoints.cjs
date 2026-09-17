'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KINDS = new Set(['partial','input','output','asset']);
const PHASES = new Set(['preparing','downloading','processing','finalizing','complete']);

function source(job) {
  return {provider:job.provider || 'youtube',sourceId:job.sourceId || null,
    serverId:job.serverId || null,ratingKey:job.ratingKey || null,url:job.url || null};
}
function options(job) {
  return {quality:job.quality || null,copyQuality:job.copyQuality || 'original',saveComments:Boolean(job.saveComments),
    subtitleLanguages:Array.isArray(job.subtitleLanguages) ? [...job.subtitleLanguages] : [],allowAutoCaptions:Boolean(job.allowAutoCaptions)};
}
function checkpointFingerprint(job) {
  // A copy-quality change can reuse a completed original. Transfer identity
  // deliberately excludes conversion and optional companion-asset options.
  return crypto.createHash('sha256').update(JSON.stringify({source:source(job),quality:job.quality || null})).digest('hex');
}
function basename(name) {
  if(typeof name!=='string' || !name || name.length>255 || name==='.' || name==='..' || path.basename(name)!==name || /[\x00-\x1f\\/]/.test(name))
    throw new Error('Unsafe download checkpoint path.');
  return name;
}
function regularFile(file) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('Download checkpoint contains an unsafe file.');
  return stat;
}
function checkDirectory(directory, optional=false) {
  let stat;
  try {stat=fs.lstatSync(directory);} catch(error) {if(optional && error.code==='ENOENT') return false;throw error;}
  if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Download checkpoint directory is unsafe.');
  return true;
}
function publicRecord(value) {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid finalization record.');
  const visit=item=>{
    if(!item || typeof item!=='object') return;
    for(const [key,child] of Object.entries(item)) {
      if(/^(?:accessToken|token|password|authorization|cookie|headers|signedUrl|downloadUrl)$/i.test(key)) throw new Error('Credentials cannot be stored in a download checkpoint.');
      visit(child);
    }
  };
  visit(value);return JSON.parse(JSON.stringify(value));
}

function createCheckpointStore({workDirectory}) {
  const root=path.resolve(workDirectory);
  function directory(job,create=false) {
    if(!job || !UUID.test(job.id)) throw new Error('Invalid download checkpoint identity.');
    if(create && !fs.existsSync(root)) fs.mkdirSync(root,{recursive:true});
    if(!checkDirectory(root,true)) return path.join(root,job.id);
    const dir=path.join(root,job.id);
    if(create && !fs.existsSync(dir)) fs.mkdirSync(dir);
    checkDirectory(dir,true);return dir;
  }
  function ownedPath(job,name) {return path.join(directory(job),basename(name));}
  function validate(job,data) {
    if(!data || typeof data!=='object' || data.version!==VERSION) throw new Error('Unsupported download checkpoint version.');
    if(data.jobId!==job.id || !PHASES.has(data.phase) || !/^[a-f0-9]{64}$/.test(data.fingerprint) || !data.source || !data.options || !Array.isArray(data.files) || data.files.length>10000)
      throw new Error('Invalid download checkpoint.');
    const names=new Set();
    for(const file of data.files) {
      basename(file.name);
      if(names.has(file.name) || !KINDS.has(file.kind) || typeof file.complete!=='boolean' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes<0)
        throw new Error('Invalid checkpoint file entry.');
      names.add(file.name);
    }
    if(data.finalization) {
      const journal=data.finalization;
      if(!['prepared','media-moved','assets-moved','library-saved'].includes(journal.stage)) throw new Error('Invalid finalization stage.');
      for(const name of [journal.mediaName,journal.thumbnailName].filter(Boolean)) {
        basename(name);
        if(!name.startsWith(`${job.id}.`)) throw new Error('Finalized media must belong to its download.');
      }
      if(journal.record) {
        publicRecord(journal.record);
        if(journal.record.id!==job.id) throw new Error('Invalid finalization record identity.');
      }
    }
    return data;
  }
  function read(job) {
    const file=ownedPath(job,'checkpoint.json');
    let stat;
    try {stat=regularFile(file);} catch(error) {if(error.code==='ENOENT') return null;throw error;}
    if(stat.size>MAX_MANIFEST_BYTES) throw new Error('Download checkpoint is too large.');
    let data;
    try {data=JSON.parse(fs.readFileSync(file,'utf8'));} catch {throw new Error('Download checkpoint could not be read. Its files have been preserved.');}
    return validate(job,data);
  }
  function write(job,data) {
    directory(job,true);
    // Never replace a future/corrupt manifest with a default checkpoint.
    read(job);
    const files=(data.files || []).map(file=>{
      const name=basename(file.name),stat=regularFile(ownedPath(job,name));
      if(name==='checkpoint.json' || name.startsWith('.checkpoint-')) throw new Error('Invalid checkpoint artifact.');
      return {name,kind:file.kind || 'partial',complete:Boolean(file.complete),sizeBytes:stat.size};
    });
    const manifest={version:VERSION,jobId:job.id,phase:data.phase || 'downloading',source:source(job),options:options(job),
      fingerprint:checkpointFingerprint(job),formatIds:(data.formatIds || []).map(String),files,updatedAt:new Date().toISOString()};
    if(data.expectedBytes!==undefined) {
      if(data.expectedBytes!==null && (!Number.isSafeInteger(data.expectedBytes) || data.expectedBytes<0)) throw new Error('Invalid checkpoint size.');
      manifest.expectedBytes=data.expectedBytes;
    }
    if(data.transfer) {
      const transfer={};
      for(const key of ['etag','lastModified','mediaId']) if(data.transfer[key]!==undefined && data.transfer[key]!==null) {
        if(typeof data.transfer[key]!=='string' || data.transfer[key].length>2048 || /[\r\n\0]/.test(data.transfer[key])) throw new Error('Invalid transfer validator.');
        transfer[key]=data.transfer[key];
      }
      for(const key of ['totalBytes','offset']) if(data.transfer[key]!==undefined) {
        if(!Number.isSafeInteger(data.transfer[key]) || data.transfer[key]<0) throw new Error('Invalid transfer checkpoint size.');
        transfer[key]=data.transfer[key];
      }
      manifest.transfer=transfer;
    }
    if(data.finalization) manifest.finalization={...data.finalization,...(data.finalization.record ? {record:publicRecord(data.finalization.record)} : {})};
    validate(job,manifest);
    const encoded=JSON.stringify(manifest,null,2);
    if(Buffer.byteLength(encoded)>MAX_MANIFEST_BYTES) throw new Error('Download checkpoint is too large.');
    const temporary=ownedPath(job,`.checkpoint-${crypto.randomUUID()}.tmp`);
    try {
      const fd=fs.openSync(temporary,'wx',0o600);
      try {fs.writeFileSync(fd,encoded);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(temporary,ownedPath(job,'checkpoint.json'));
    } finally {try {fs.unlinkSync(temporary);} catch(error) {if(error.code!=='ENOENT') throw error;}}
    return manifest;
  }
  function inspect(job) {
    const manifest=read(job);
    if(!manifest) return {manifest:null,retainedBytes:0,resumable:false,compatible:false,files:[]};
    const compatible=manifest.fingerprint===checkpointFingerprint(job);
    const copyChanged=manifest.options.copyQuality!==(job.copyQuality || 'original');
    const files=[];
    for(const file of manifest.files) {
      let stat;
      try {stat=regularFile(ownedPath(job,file.name));} catch(error) {if(error.code==='ENOENT') continue;throw error;}
      // In-flight files may have grown since the last durable checkpoint. A
      // complete input must keep its recorded length, and no file may shrink.
      if(stat.size<file.sizeBytes || (file.complete && stat.size!==file.sizeBytes)) continue;
      if(file.kind==='output' && !file.complete) continue;
      if(!compatible || (copyChanged && file.kind==='output')) continue;
      files.push({...file,sizeBytes:stat.size});
    }
    const retainedBytes=files.reduce((total,file)=>total+file.sizeBytes,0);
    return {manifest,compatible,files,retainedBytes,resumable:retainedBytes>0};
  }
  function discard(job) {
    const dir=directory(job);
    // Refuse symlinked directories rather than recursively deleting through one.
    if(checkDirectory(dir,true)) fs.rmSync(dir,{recursive:true,force:true});
  }
  return {read,write,inspect,path:ownedPath,discard};
}

module.exports={createCheckpointStore,checkpointFingerprint};
