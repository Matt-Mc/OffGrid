'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {createCheckpointStore,checkpointFingerprint}=require('./download-checkpoints.cjs');
const {validateResumeState}=require('./range-transfer.cjs');

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function statFile(file) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('A download recovery file is unsafe.');
  return stat;
}
function ensureDirectory(directory) {
  if(!fs.existsSync(directory)) fs.mkdirSync(directory,{recursive:true});
  const stat=fs.lstatSync(directory);
  if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A download recovery directory is unsafe.');
}
function existing(file) {
  try {return statFile(file);} catch(error) {if(error.code==='ENOENT') return null;throw error;}
}

function createDownloadRecovery({workDirectory,mediaDirectory,thumbnailsDirectory,assetsDirectory,getLibrary,saveLibrary}) {
  const store=createCheckpointStore({workDirectory});
  const roots={media:path.resolve(mediaDirectory),thumbnail:path.resolve(thumbnailsDirectory),asset:path.resolve(assetsDirectory)};
  const isServer=job=>['plex','jellyfin'].includes(job.provider);
  function serverResume(manifest) {return validateResumeState(manifest?.transfer,manifest?.expectedBytes);}
  function summarize(job,summary) {
    if(!isServer(job)) return summary;
    const complete=summary.files.some(file=>file.complete && ['input','output'].includes(file.kind));
    const transfer=serverResume(summary.manifest);
    const partial=transfer && summary.files.some(file=>!file.complete && file.kind==='partial' && file.sizeBytes>=transfer.offset);
    return {...summary,resumable:Boolean(complete || partial)};
  }
  function finalPath(job,kind,name) {
    if(!UUID.test(job.id) || !Object.hasOwn(roots,kind) || typeof name!=='string' || path.basename(name)!==name) throw new Error('Invalid final media path.');
    const valid=kind==='asset' ? new RegExp(`^${job.id}\\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.vtt$`).test(name)
      : new RegExp(`^${job.id}\\.[a-z0-9]{1,10}$`).test(name);
    if(!valid) throw new Error('Final media path does not belong to this download.');
    ensureDirectory(roots[kind]);return path.join(roots[kind],name);
  }
  function ownedSource(job,file) {
    if(typeof file!=='string') throw new Error('Invalid staged download path.');
    const name=path.basename(file),owned=store.path(job,name);
    if(path.resolve(file)!==owned || !name.startsWith(`${job.id}.`)) throw new Error('Staged media must belong to its download directory.');
    statFile(owned);return name;
  }
  function files(job,patch={},prior=store.read(job)) {
    const directory=path.dirname(store.path(job,'checkpoint.json'));
    if(!fs.existsSync(directory)) return [];
    const old=new Map((prior?.files || []).map(file=>[file.name,file]));
    const completed=new Set(patch.completedFiles || []),output=new Set(patch.outputFiles || []);
    const phase=patch.phase || prior?.phase || 'downloading';
    return fs.readdirSync(directory).filter(name=>name.startsWith(`${job.id}.`)).map(name=>{
      const current=statFile(store.path(job,name)),previous=old.get(name);
      const stable=previous?.complete && current.size===previous.sizeBytes;
      const complete=completed.has(name) || Boolean(stable);
      let kind=output.has(name) ? 'output' : completed.has(name) ? 'input' : stable ? previous.kind
        : /\.(?:vtt|srt)$/.test(name) ? 'asset'
          : phase==='processing' && /\.mp4$/.test(name) ? 'output' : previous?.kind || 'partial';
      return {name,kind,complete,sizeBytes:current.size};
    });
  }
  function checkpoint(job,patch={}) {
    const prior=store.read(job);
    store.write(job,{...prior,...patch,files:files(job,patch,prior)});
    return summarize(job,store.inspect(job));
  }
  function journalWrite(job,journal) {
    const prior=store.read(job);
    return store.write(job,{...prior,phase:'finalizing',files:files(job,{},prior),finalization:journal});
  }
  function verifyRecord(job,record) {
    if(!record || record.id!==job.id || typeof record.filePath!=='string') throw new Error('Invalid library finalization record.');
    if(record.filePath!==finalPath(job,'media',path.basename(record.filePath))) throw new Error('Final media destination is invalid.');
    if(record.thumbnailPath && record.thumbnailPath!==finalPath(job,'thumbnail',path.basename(record.thumbnailPath))) throw new Error('Final thumbnail destination is invalid.');
    if(record.assets!==undefined && !Array.isArray(record.assets)) throw new Error('Invalid final media assets.');
    for(const asset of record.assets || []) {
      if(!UUID.test(asset.id) || asset.format!=='vtt' || asset.filePath!==finalPath(job,'asset',`${job.id}.${asset.id}.vtt`)) throw new Error('Final subtitle destination is invalid.');
    }
  }
  function moveEntry(job,entry) {
    if(!entry || !['media','thumbnail','asset'].includes(entry.kind) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes<0) throw new Error('Invalid finalization file entry.');
    const destination=finalPath(job,entry.kind,entry.name);
    const source=entry.sourceName ? store.path(job,entry.sourceName) : null;
    if(source && !entry.sourceName.startsWith(`${job.id}.`)) throw new Error('Finalization source is not owned by this download.');
    let target=existing(destination),input=source ? existing(source) : null;
    const matches=stat=>stat && stat.size===entry.sizeBytes && stat.dev===entry.device && stat.ino===entry.inode;
    if(target) {
      if(!matches(target)) throw new Error('Final media differs from its recovery checkpoint. Existing media was preserved.');
      if(input) {
        if(!matches(input)) throw new Error('Staged media changed during finalization.');
        fs.unlinkSync(source);
      }
      return;
    }
    if(!matches(input)) throw new Error('Completed download input is missing or changed.');
    // A hard-link move cannot overwrite an unrelated existing destination.
    // Both directories are inside the same application data volume. Keeping
    // the inode in the journal also makes a crash between link/unlink safe.
    fs.linkSync(source,destination);fs.unlinkSync(source);
  }
  function finish(job,manifest) {
    const journal=manifest.finalization;
    verifyRecord(job,journal.record);
    if(!Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length>6) throw new Error('Invalid finalization file list.');
    const media=journal.entries.filter(entry=>entry.kind==='media');
    if(media.length!==1 || !Number.isSafeInteger(journal.record.sizeBytes) || journal.record.sizeBytes<=0 || journal.record.sizeBytes!==media[0].sizeBytes)
      throw new Error('Finalized video size does not match its library record.');
    const expected=new Map([[journal.record.filePath,'media']]);
    if(journal.record.thumbnailPath) expected.set(journal.record.thumbnailPath,'thumbnail');
    for(const asset of journal.record.assets || []) expected.set(asset.filePath,'asset');
    const seen=new Set();
    for(const entry of journal.entries) {
      const target=finalPath(job,entry.kind,entry.name);
      if(expected.get(target)!==entry.kind || seen.has(target)) throw new Error('Finalization files do not match the library record.');
      seen.add(target);moveEntry(job,entry);
    }
    if(seen.size!==expected.size) throw new Error('Finalization is missing a media asset.');
    journalWrite(job,{...journal,stage:'assets-moved'});
    const library=getLibrary();
    const saved=library.find(video=>video.id===job.id);
    if(saved) {
      // A crash after library persistence must not reset watched/progress data.
      verifyRecord(job,saved);
      if(saved.filePath!==journal.record.filePath) throw new Error('Existing library record disagrees with its download checkpoint.');
    } else {
      const result=saveLibrary([journal.record,...library]);
      if(result && typeof result.then==='function') throw new Error('Library finalization requires a synchronous durable save.');
    }
    journalWrite(job,{...journal,stage:'library-saved'});
    store.discard(job);
    return saved || journal.record;
  }
  function completePatch(record) {
    return {status:'complete',videoId:record.id,progress:100,error:null,retainedBytes:0,resumable:false,message:'Ready to watch',nextRetryAt:null};
  }
  function recover(job) {
    const manifest=store.read(job);
    if(manifest?.finalization) return completePatch(finish(job,manifest));
    const saved=getLibrary().find(video=>video.id===job.id);
    if(saved) {verifyRecord(job,saved);statFile(saved.filePath);store.discard(job);return completePatch(saved);}
    if(!manifest) return {retainedBytes:0,resumable:false};
    const summary=summarize(job,store.inspect(job));
    return {retainedBytes:summary.retainedBytes,resumable:summary.resumable,
      ...(!summary.compatible ? {message:'The saved source changed. Resume to restart this download.'}
        : isServer(job) && summary.retainedBytes && !summary.resumable ? {message:'This server cannot resume the retained data. Retry to restart the download.'} : {})};
  }
  function prepare(job,{formatIds=[],expectedBytes}={}) {
    const prior=store.read(job);
    if(prior?.finalization) return recover(job);
    const sourceChanged=prior && prior.fingerprint!==checkpointFingerprint(job);
    const formatsChanged=prior && JSON.stringify(prior.formatIds || [])!==JSON.stringify(formatIds.map(String));
    // Legacy/uncheckpointed bytes have no proven source/options identity.
    if(!prior || sourceChanged || formatsChanged) store.discard(job);
    else if(prior) {
      const copyChanged=prior.options.copyQuality!==(job.copyQuality || 'original');
      const transfer=isServer(job) ? serverResume(prior) : null;
      const candidates=new Map(prior.files.map(file=>[file.name,file]));
      for(const file of files(job,{},prior)) if(!candidates.has(file.name)) candidates.set(file.name,file);
      for(const file of candidates.values()) {
        const target=store.path(job,file.name);
        const stat=existing(target);
        if(!stat) continue;
        if((file.complete && stat.size!==file.sizeBytes) || (file.kind==='output' && (!file.complete || copyChanged))) {fs.unlinkSync(target);continue;}
        if(isServer(job) && !file.complete && file.kind==='partial') {
          // Remove or truncate invalid bytes before taking a storage snapshot.
          // Only the durable, validator-bound prefix earns admission credit.
          if(!transfer || stat.size<transfer.offset) fs.unlinkSync(target);
          else if(stat.size>transfer.offset) fs.truncateSync(target,transfer.offset);
        }
      }
    }
    return checkpoint(job,{phase:'preparing',formatIds,...(expectedBytes!==undefined ? {expectedBytes} : {})});
  }
  function retain(job,outcome) {
    if(outcome.status==='canceled') return {retainedBytes:0,resumable:false};
    const prior=store.read(job);
    if(prior?.finalization) return recover(job);
    if(!prior) return {retainedBytes:0,resumable:false};
    for(const file of prior.files) if(file.complete) {
      const target=store.path(job,file.name),stat=existing(target);
      if(stat && stat.size!==file.sizeBytes) fs.unlinkSync(target);
    }
    for(const file of files(job,{},prior)) if(file.kind==='output' && !file.complete) fs.unlinkSync(store.path(job,file.name));
    const summary=checkpoint(job);
    return {retainedBytes:summary.retainedBytes,resumable:summary.resumable};
  }
  function commit(job,record,sourcePath,{assetSources=[],thumbnailSourcePath}={}) {
    const prepared={...record,assets:(record.assets || []).map(asset=>({...asset}))};
    const sourceName=ownedSource(job,sourcePath);
    const entries=[];
    function entry(kind,destination,staged) {
      const final=finalPath(job,kind,path.basename(destination));
      if(destination!==final) throw new Error('Final media destination is invalid.');
      const sourceName=staged ? ownedSource(job,staged) : null;
      const stat=statFile(staged || final);
      entries.push({kind,name:path.basename(final),sourceName,sizeBytes:stat.size,device:stat.dev,inode:stat.ino});
    }
    entry('media',prepared.filePath,sourcePath);
    if(!Number.isSafeInteger(prepared.sizeBytes) || prepared.sizeBytes<=0 || prepared.sizeBytes!==entries[0].sizeBytes)
      throw new Error('Finalized video size does not match its library record.');
    if(prepared.thumbnailPath) entry('thumbnail',prepared.thumbnailPath,thumbnailSourcePath);
    for(const asset of prepared.assets) {
      const supplied=assetSources.find(source=>source.assetId===asset.id);
      const staged=supplied?.sourcePath;
      asset.filePath=finalPath(job,'asset',`${job.id}.${asset.id}.vtt`);
      entry('asset',asset.filePath,staged);
    }
    if(assetSources.some(source=>!prepared.assets.some(asset=>asset.id===source.assetId))) throw new Error('A staged subtitle has no matching library asset.');
    verifyRecord(job,prepared);
    const journal={stage:'prepared',mediaName:path.basename(prepared.filePath),thumbnailName:prepared.thumbnailPath ? path.basename(prepared.thumbnailPath) : null,record:prepared,entries};
    checkpoint(job,{phase:'finalizing',completedFiles:[sourceName],finalization:journal});
    return finish(job,store.read(job));
  }
  return {recover,retain,prepare,checkpoint,commit};
}

module.exports={createDownloadRecovery};
