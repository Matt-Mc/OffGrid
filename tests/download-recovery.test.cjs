const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createDownloadRecovery}=require('../electron/download-recovery.cjs');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directories=Object.fromEntries(['workDirectory','mediaDirectory','thumbnailsDirectory','assetsDirectory'].map(key=>[key,path.join(root,key)]));
  for(const directory of Object.values(directories)) fs.mkdirSync(directory);
  const job={id:crypto.randomUUID(),source:'manual',url:'https://www.youtube.com/watch?v=abc',sourceId:'abc',quality:'720p'};
  let library=[],failure=false,writes=0;
  const recovery=createDownloadRecovery({...directories,getLibrary:()=>library,saveLibrary:value=>{if(failure) throw new Error('Library disk write failed');library=value;writes++;}});
  const work=path.join(directories.workDirectory,job.id);
  const name=suffix=>`${job.id}.${suffix}`;
  const put=(suffix,bytes)=>{fs.mkdirSync(work,{recursive:true});const file=path.join(work,name(suffix));fs.writeFileSync(file,Buffer.alloc(bytes,7));return file;};
  return {...directories,root,job,recovery,work,name,put,library:()=>library,fail:value=>{failure=value;},writes:()=>writes};
}

test('legacy bytes are discarded before a new source checkpoint gets resume credit',t=>{
  const f=fixture(t);const legacy=f.put('mp4.part',40);
  assert.equal(f.recovery.recover(f.job).resumable,false);
  assert.equal(f.recovery.prepare(f.job,{formatIds:['137','140'],expectedBytes:100}).retainedBytes,0);
  assert.equal(fs.existsSync(legacy),false);
});

test('postprocessing retains completed inputs and removes incomplete final/temporary MP4 outputs',t=>{
  const f=fixture(t);
  f.recovery.prepare(f.job,{formatIds:['137','140']});
  f.put('f137.mp4',100);f.put('f140.m4a',20);const merged=f.put('mp4',60),temporary=f.put('temp.mp4',10);
  f.recovery.checkpoint(f.job,{phase:'downloading'});
  f.recovery.checkpoint(f.job,{phase:'processing',completedFiles:[f.name('f137.mp4'),f.name('f140.m4a')]});
  const retained=f.recovery.retain(f.job,{status:'paused'});
  assert.equal(retained.retainedBytes,120);assert.equal(retained.resumable,true);
  assert.equal(fs.existsSync(merged),false);assert.equal(fs.existsSync(temporary),false);
  assert.equal(f.recovery.prepare(f.job,{formatIds:['137','140']}).retainedBytes,120);
  assert.equal(f.recovery.prepare(f.job,{formatIds:['other']}).retainedBytes,0);
});

test('changed saved-copy quality retains original input while clearing conversion output',t=>{
  const f=fixture(t);Object.assign(f.job,{provider:'plex',quality:'original',copyQuality:'original',serverId:'server',ratingKey:'42',sourceId:'plex:server:42',url:'plex://server/42'});
  f.recovery.prepare(f.job);f.put('original.mkv',100);const output=f.put('small.mp4',30);
  f.recovery.checkpoint(f.job,{phase:'processing',completedFiles:[f.name('original.mkv'),f.name('small.mp4')],outputFiles:[f.name('small.mp4')]});
  const result=f.recovery.prepare({...f.job,copyQuality:'720p'});
  assert.equal(result.retainedBytes,100);assert.equal(fs.existsSync(output),false);
});

test('server partials require a strong validator to advertise resume and receive storage credit',t=>{
  const f=fixture(t);Object.assign(f.job,{provider:'plex',quality:'original',sourceId:'plex:server:42',serverId:'server',ratingKey:'42',url:'plex://server/42'});
  f.recovery.prepare(f.job,{formatIds:['mkv','100'],expectedBytes:100});
  const partial=f.put('original.mkv',60);
  assert.equal(f.recovery.prepare(f.job,{formatIds:['mkv','100'],expectedBytes:100}).retainedBytes,0,'uncheckpointed crash bytes have no validator');
  assert.equal(fs.existsSync(partial),false);f.put('original.mkv',60);
  f.recovery.checkpoint(f.job,{phase:'downloading',transfer:{etag:'W/"weak"',totalBytes:100,offset:60}});
  const retained=f.recovery.retain(f.job,{status:'paused'});
  assert.equal(retained.retainedBytes,60);assert.equal(retained.resumable,false);
  assert.equal(f.recovery.recover(f.job).resumable,false);
  const prepared=f.recovery.prepare(f.job,{formatIds:['mkv','100'],expectedBytes:100});
  assert.equal(prepared.retainedBytes,0);assert.equal(fs.existsSync(partial),false);
  f.put('original.mkv',60);
  f.recovery.checkpoint(f.job,{phase:'downloading',transfer:{etag:'"strong"',totalBytes:100,offset:40}});
  assert.equal(f.recovery.recover(f.job).resumable,true);
  const resumed=f.recovery.prepare(f.job,{formatIds:['mkv','100'],expectedBytes:100});
  assert.equal(resumed.retainedBytes,40);assert.equal(fs.statSync(partial).size,40);assert.equal(resumed.resumable,true);
});

test('a changed completed input cannot be relabeled as a reusable partial during prepare',t=>{
  const f=fixture(t);f.recovery.prepare(f.job,{formatIds:['137']});
  const input=f.put('f137.mp4',100);
  f.recovery.checkpoint(f.job,{phase:'processing',completedFiles:[f.name('f137.mp4')]});
  fs.writeFileSync(input,Buffer.alloc(90));
  assert.equal(f.recovery.prepare(f.job,{formatIds:['137']}).retainedBytes,0);
  assert.equal(fs.existsSync(input),false);
});

test('commit moves owned media/assets and atomically inserts one complete library record',t=>{
  const f=fixture(t);f.recovery.prepare(f.job);const input=f.put('mp4',100),assetId=crypto.randomUUID(),subtitle=f.put(`${assetId}.vtt`,20);
  const thumbnail=path.join(f.thumbnailsDirectory,f.name('jpg'));fs.writeFileSync(thumbnail,Buffer.alloc(10));
  const record={id:f.job.id,sizeBytes:100,sourceId:f.job.sourceId,filePath:path.join(f.mediaDirectory,f.name('mp4')),thumbnailPath:thumbnail,title:'Example',playbackPositionSeconds:0,
    assets:[{id:assetId,kind:'subtitle',format:'vtt',filePath:subtitle,language:'en',sizeBytes:20}]};
  const saved=f.recovery.commit(f.job,record,input,{assetSources:[{sourcePath:subtitle,assetId}]});
  assert.equal(fs.statSync(saved.filePath).size,100);assert.equal(fs.statSync(saved.assets[0].filePath).size,20);
  assert.equal(saved.assets[0].filePath,path.join(f.assetsDirectory,`${f.job.id}.${assetId}.vtt`));
  assert.equal(f.writes(),1);assert.equal(f.library().length,1);assert.equal(fs.existsSync(f.work),false);
  f.library()[0].playbackPositionSeconds=44;
  assert.equal(f.recovery.recover(f.job).status,'complete');assert.equal(f.library()[0].playbackPositionSeconds,44);assert.equal(f.writes(),1);
});

test('recovery completes a crash after moving media but before saving the library',t=>{
  const f=fixture(t);f.recovery.prepare(f.job);const input=f.put('mp4',100);
  const record={id:f.job.id,sizeBytes:100,filePath:path.join(f.mediaDirectory,f.name('mp4')),assets:[],playbackPositionSeconds:0};
  f.fail(true);assert.throws(()=>f.recovery.commit(f.job,record,input),/Library disk write failed/);
  assert.equal(fs.existsSync(input),false);assert.equal(fs.statSync(record.filePath).size,100);assert.equal(f.library().length,0);
  f.fail(false);assert.equal(f.recovery.recover(f.job).status,'complete');assert.equal(f.writes(),1);
  assert.equal(f.recovery.recover(f.job).status,'complete');assert.equal(f.writes(),1);
});

test('recovery tolerates a crash between linking final media and unlinking the source',t=>{
  const f=fixture(t);f.recovery.prepare(f.job);const input=f.put('mp4',100);
  const record={id:f.job.id,sizeBytes:100,filePath:path.join(f.mediaDirectory,f.name('mp4')),assets:[]};
  f.fail(true);assert.throws(()=>f.recovery.commit(f.job,record,input),/disk write failed/);
  fs.linkSync(record.filePath,input); // Both names exist during the move boundary.
  f.fail(false);f.recovery.recover(f.job);
  assert.equal(fs.existsSync(input),false);assert.equal(f.library().length,1);
});

test('changed final media or a mismatched journal path never overwrites or publishes files',t=>{
  const f=fixture(t);f.recovery.prepare(f.job);const input=f.put('mp4',100);
  const record={id:f.job.id,sizeBytes:100,filePath:path.join(f.mediaDirectory,f.name('mp4')),assets:[]};
  f.fail(true);assert.throws(()=>f.recovery.commit(f.job,record,input),/disk write failed/);
  fs.writeFileSync(record.filePath,Buffer.alloc(99));f.fail(false);
  assert.throws(()=>f.recovery.recover(f.job),/differs/);assert.equal(f.library().length,0);assert.equal(fs.statSync(record.filePath).size,99);
  const manifest=path.join(f.work,'checkpoint.json');const data=JSON.parse(fs.readFileSync(manifest));
  data.finalization.record.filePath=path.join(f.root,'outside.mp4');fs.writeFileSync(manifest,JSON.stringify(data));
  assert.throws(()=>f.recovery.recover(f.job),/path|destination/);assert.equal(fs.existsSync(data.finalization.record.filePath),false);
});

test('future manifests remain untouched by prepare/recover/retention',t=>{
  const f=fixture(t);const partial=f.put('mp4.part',40),manifest=path.join(f.work,'checkpoint.json');
  const raw=JSON.stringify({version:99});fs.writeFileSync(manifest,raw);
  for(const action of [()=>f.recovery.recover(f.job),()=>f.recovery.prepare(f.job),()=>f.recovery.retain(f.job,{status:'paused'})]) assert.throws(action,/version/);
  assert.equal(fs.readFileSync(manifest,'utf8'),raw);assert.equal(fs.statSync(partial).size,40);
});
