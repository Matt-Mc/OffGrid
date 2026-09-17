const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {createAssetRecovery}=require('../electron/asset-recovery.cjs');
function setup(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-asset-journal-'));const workDirectory=path.join(directory,'work'),assetsDirectory=path.join(directory,'assets');fs.mkdirSync(workDirectory);fs.mkdirSync(assetsDirectory);
  const job={id:crypto.randomUUID(),kind:'assets'},videoId=crypto.randomUUID();const work=path.join(workDirectory,job.id);fs.mkdirSync(work);const oldId=crypto.randomUUID(),newId=crypto.randomUUID();const text='WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n';
  const record=(id,language)=>({id,kind:'subtitle',format:'vtt',language,origin:'manual',filePath:path.join(assetsDirectory,`${videoId}.${id}.vtt`),sizeBytes:Buffer.byteLength(text)});
  const old=record(oldId,'en'),fresh=record(newId,'en');fs.writeFileSync(old.filePath,text);const source=path.join(work,`${videoId}.${newId}.vtt`);fs.writeFileSync(source,text);
  let library=[{id:videoId,title:'Journey',playbackPositionSeconds:10,watched:false,assets:[old],assetWarnings:['Missing captions']}],saveHook=null;
  const options={workDirectory,assetsDirectory,getLibrary:()=>library,saveLibrary:next=>{if(saveHook)saveHook(next);library=next;}};
  const input={videoId,assets:[fresh],sources:[source],replaced:[old],warnings:[]};
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return{job,videoId,work,old,fresh,source,input,options,store:createAssetRecovery(options),get library(){return library;},set library(value){library=value;},setSaveHook:callback=>saveHook=callback};
}
function failLinkOnce(destination,callback){const original=fs.linkSync;fs.linkSync=(source,target)=>{if(target===destination)throw new Error('Simulated crash before asset link');return original(source,target);};try{return callback();}finally{fs.linkSync=original;}}
test('asset commit merges into latest playback record and removes only replaced assets',t=>{
  const h=setup(t);h.library[0].playbackPositionSeconds=75;const result=h.store.commit(h.job,h.input);assert.equal(result.status,'complete');assert.equal(h.library[0].playbackPositionSeconds,75);assert.equal(h.library[0].assets[0].id,h.fresh.id);assert.deepEqual(h.library[0].assetWarnings,[]);assert(fs.existsSync(h.fresh.filePath));assert(!fs.existsSync(h.source));assert(!fs.existsSync(h.old.filePath));assert(!fs.existsSync(path.join(h.work,'assets-journal.json')));assert.deepEqual(h.store.recover(h.job),{});
});
test('prepared journal survives a crash before moving any staged asset',t=>{
  const h=setup(t);assert.throws(()=>failLinkOnce(h.fresh.filePath,()=>h.store.commit(h.job,h.input)),/Simulated crash/);assert(fs.existsSync(path.join(h.work,'assets-journal.json')));assert(fs.existsSync(h.source));assert(!fs.existsSync(h.fresh.filePath));
  h.library[0].playbackPositionSeconds=99;const restored=createAssetRecovery(h.options);assert.equal(restored.recover(h.job).status,'complete');assert.equal(h.library[0].playbackPositionSeconds,99);assert(!fs.existsSync(h.old.filePath));
});
test('crash after hardlink before source unlink recovers the shared inode without overwrite',t=>{
  const h=setup(t);assert.throws(()=>failLinkOnce(h.fresh.filePath,()=>h.store.commit(h.job,h.input)));fs.linkSync(h.source,h.fresh.filePath);assert.equal(fs.statSync(h.source).ino,fs.statSync(h.fresh.filePath).ino);assert.equal(createAssetRecovery(h.options).recover(h.job).status,'complete');assert(!fs.existsSync(h.source));assert.equal(h.library[0].assets[0].id,h.fresh.id);
});
test('crash after moves but before library save recovers using the final file identity',t=>{
  const h=setup(t);h.setSaveHook(()=>{throw new Error('Simulated library write failure');});assert.throws(()=>h.store.commit(h.job,h.input),/write failure/);assert(fs.existsSync(h.fresh.filePath));assert(!fs.existsSync(h.source));assert(fs.existsSync(h.old.filePath));assert.equal(h.library[0].assets[0].id,h.old.id);
  h.setSaveHook(null);h.library[0].watched=true;createAssetRecovery(h.options).recover(h.job);assert(h.library[0].watched);assert.equal(h.library[0].assets[0].id,h.fresh.id);assert(!fs.existsSync(h.old.filePath));
});
test('post-library crash cleanup keeps committed files and preserves newer playback',t=>{
  const h=setup(t);const unlink=fs.unlinkSync;fs.unlinkSync=file=>{if(file===h.old.filePath)throw new Error('Simulated cleanup crash');return unlink(file);};try{assert.throws(()=>h.store.commit(h.job,h.input),/cleanup crash/);}finally{fs.unlinkSync=unlink;}
  assert.equal(h.library[0].assets[0].id,h.fresh.id);h.library[0].playbackPositionSeconds=120;createAssetRecovery(h.options).discard(h.job);assert(fs.existsSync(h.fresh.filePath));assert(!fs.existsSync(h.old.filePath));assert.equal(h.library[0].playbackPositionSeconds,120);
});
test('discard and missing-video recovery clean only newly owned files',t=>{
  for(const missingVideo of [false,true]){
    const h=setup(t);h.setSaveHook(()=>{throw new Error('Crash');});assert.throws(()=>h.store.commit(h.job,h.input));h.setSaveHook(null);const unrelated=path.join(h.work,'unrelated.txt');fs.writeFileSync(unrelated,'Keep me');if(missingVideo)h.library=[];
    const restored=createAssetRecovery(h.options);(missingVideo?restored.recover:restored.discard)(h.job);assert(!fs.existsSync(h.fresh.filePath));assert(fs.existsSync(h.old.filePath));assert(fs.existsSync(unrelated));assert(!fs.existsSync(path.join(h.work,'assets-journal.json')));
  }
});
test('destination collisions and changed staged inode never overwrite external files',t=>{
  const h=setup(t);assert.throws(()=>failLinkOnce(h.fresh.filePath,()=>h.store.commit(h.job,h.input)));fs.writeFileSync(h.fresh.filePath,'External file');assert.throws(()=>h.store.recover(h.job),/changed/);assert.equal(fs.readFileSync(h.fresh.filePath,'utf8'),'External file');assert(fs.existsSync(h.source));
  fs.unlinkSync(h.fresh.filePath);const oldSource=fs.readFileSync(h.source);fs.renameSync(h.source,h.source+'.old');fs.writeFileSync(h.source,oldSource);assert.throws(()=>h.store.recover(h.job),/changed/);assert(fs.existsSync(h.old.filePath));
});
test('unsafe staged paths, symlink directories and malformed journals preserve the library',t=>{
  const h=setup(t);assert.throws(()=>h.store.commit(h.job,{...h.input,sources:[h.old.filePath]}),/owner directory/);assert.equal(h.library[0].assets[0].id,h.old.id);
  fs.writeFileSync(path.join(h.work,'assets-journal.json'),'{broken');assert.throws(()=>h.store.recover(h.job),/could not be read/);assert(fs.existsSync(h.old.filePath));
  fs.unlinkSync(path.join(h.work,'assets-journal.json'));fs.renameSync(h.work,h.work+'.real');fs.symlinkSync(h.work+'.real',h.work);assert.throws(()=>h.store.recover(h.job),/directory is unsafe/);
});
