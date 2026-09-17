const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultSettings, validateSettings, getExpectedSize, checkStorageAdmission, directoryBytes, readJson, DurableQueue } = require('../electron/backend-core.cjs');
const { eventually } = require('./backend-harness.cjs');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-core-test-'));
  t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
  return directory;
}

test('new defaults require opt-in; migration preserves comments and automatic downloads without a cap', () => {
  assert.equal(defaultSettings().saveComments, false);
  assert.equal(defaultSettings().autoDownload, false);
  assert.equal(defaultSettings(true).saveComments, true);
  assert.equal(defaultSettings(true).autoDownload, true);
  assert.equal(defaultSettings(true).maxLibraryBytes, null);
  assert.equal(validateSettings({defaultQuality:'480p'}).defaultQuality, '480p');
  for (const patch of [{maxLibraryBytes:0}, {maxLibraryBytes:-1}, {maxLibraryBytes:NaN}, {saveComments:'yes'}, {defaultQuality:'4K'}, {checkIntervalHours:1}, {recentVideoCount:100}, {unexpected:true}]) {
    assert.throws(() => validateSettings(patch), /Invalid/);
  }
});

test('estimates require every requested stream and never report a partial sum as complete', () => {
  assert.equal(getExpectedSize({requested_formats:[{filesize:100},{filesize_approx:25}]}),125);
  assert.equal(getExpectedSize({requested_formats:[{filesize:100},{}]}),null);
  assert.equal(getExpectedSize({filesize:0}),null);
  assert.equal(getExpectedSize({filesize:NaN}),null);
  assert.equal(getExpectedSize({}),null);
});

test('storage reserves processing workspace and free disk independently of the library cap', () => {
  const storage = {savedBytes:100_000_000,temporaryBytes:50_000_000,maxLibraryBytes:1_000_000_000,freeBytes:10_000_000_000};
  assert.equal(checkStorageAdmission(storage,100_000_000),null);
  assert.match(checkStorageAdmission(storage,300_000_000),/library limit/);
  assert.match(checkStorageAdmission(storage,null),/Size unavailable/);
  assert.equal(checkStorageAdmission({...storage,maxLibraryBytes:null},null),null);
  assert.match(checkStorageAdmission({...storage,maxLibraryBytes:null,freeBytes:1_999_999_999},null),/2 GB/);
  assert.match(checkStorageAdmission({...storage,maxLibraryBytes:null,freeBytes:2_100_000_000},100_000_000),/processing/);
  assert.match(checkStorageAdmission({...storage,freeBytes:null},100),/could not be checked/);
  assert.match(checkStorageAdmission({...storage,maxLibraryBytes:1},100),/library limit/);
});

test('disk accounting includes nested working files and thumbnails without following symlinks', (t) => {
  const directory=temporaryDirectory(t);
  fs.mkdirSync(path.join(directory,'working'));
  fs.writeFileSync(path.join(directory,'video.mp4'),Buffer.alloc(100));
  fs.writeFileSync(path.join(directory,'working','video.part'),Buffer.alloc(30));
  fs.symlinkSync(path.join(directory,'working'),path.join(directory,'linked'),process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(directoryBytes(directory),130);
});

test('malformed state is retained for recovery', (t) => {
  const directory=temporaryDirectory(t), file=path.join(directory,'settings.json');
  fs.writeFileSync(file,'{broken');
  assert.deepEqual(readJson(file,{fallback:true}),{fallback:true});
  const backup=fs.readdirSync(directory).find(name=>name.startsWith('settings.json.corrupt-'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(directory,backup),'utf8'),'{broken');
});

test('queue is serial, prioritizes pending manual jobs, deduplicates, and records options', async (t) => {
  const directory=temporaryDirectory(t);
  const execution=[];
  let concurrent=0, maxConcurrent=0;
  const queue=new DurableQueue({file:path.join(directory,'downloads.json'),cleanup(){},notify(){},execute:async(job)=>{
    concurrent++; maxConcurrent=Math.max(maxConcurrent,concurrent); execution.push(job.sourceId);
    await new Promise(resolve=>setTimeout(resolve,5));
    queue.update(job.id,{status:'complete'}); concurrent--;
  }});
  queue.pause(true);
  const automatic=queue.add({source:'subscription',sourceId:'auto',url:'https://youtu.be/auto',quality:'720p',saveComments:false});
  assert.equal(queue.add({source:'subscription',sourceId:'auto',url:'https://www.youtube.com/watch?v=auto'}).id,automatic.id);
  queue.add({source:'manual',sourceId:'manual',url:'https://youtu.be/manual',quality:'480p',saveComments:true});
  queue.pause(false);
  await eventually(()=>queue.jobs.every(job=>job.status==='complete'));
  assert.deepEqual(execution,['manual','auto']);
  assert.equal(maxConcurrent,1);
  assert.equal(queue.jobs[1].quality,'480p');
  assert.equal(queue.jobs[1].saveComments,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'downloads.json'))).jobs.length,2);
});

test('a failed job does not clear unrelated queue history; retry keeps its stable ID', async (t) => {
  const directory=temporaryDirectory(t);
  let fail=true;
  const queue=new DurableQueue({file:path.join(directory,'downloads.json'),cleanup(){},notify(){},execute:async(job)=>{
    if(job.sourceId==='failure' && fail) throw new Error('Video is unavailable');
    queue.update(job.id,{status:'complete'});
  }});
  queue.pause(true);
  const failed=queue.add({source:'manual',sourceId:'failure',url:'https://youtu.be/failure',quality:'720p'});
  const healthy=queue.add({source:'manual',sourceId:'healthy',url:'https://youtu.be/healthy',quality:'720p'});
  queue.pause(false);
  await eventually(()=>queue.jobs.find(job=>job.id===healthy.id).status==='complete');
  assert.equal(queue.jobs.find(job=>job.id===failed.id).status,'error');
  assert.equal(queue.jobs.length,2);
  fail=false;
  queue.retry(failed.id,{quality:'480p'});
  await eventually(()=>queue.jobs.find(job=>job.id===failed.id).status==='complete');
  assert.equal(queue.jobs.find(job=>job.id===failed.id).quality,'480p');
  assert.equal(queue.jobs.length,2);
});

test('Stop after current preserves queued work; cancellation waits for child cleanup', async (t) => {
  const directory=temporaryDirectory(t);
  const cleanup=[];
  let release;
  const queue=new DurableQueue({file:path.join(directory,'downloads.json'),cleanup:job=>cleanup.push(job.id),notify(){},execute:async(job,active)=>{
    await new Promise(resolve=>{release=resolve;active.children.add({kill:resolve});});
    if(!active.stopReason) queue.update(job.id,{status:'complete'});
  }});
  const first=queue.add({source:'manual',url:'https://youtu.be/first'});
  const second=queue.add({source:'manual',url:'https://youtu.be/second'});
  queue.pause(true);
  release();
  await eventually(()=>!queue.running);
  assert.equal(first.status,'complete');
  assert.equal(second.status,'queued');
  queue.pause(false);
  await eventually(()=>second.status==='preparing');
  await queue.cancel(second.id);
  assert.equal(second.status,'canceled');
  assert.ok(cleanup.includes(second.id));
});

test('restart reconciles interrupted files, preserves completed records and paused state', (t) => {
  const directory=temporaryDirectory(t),file=path.join(directory,'downloads.json');
  const interrupted={id:crypto.randomUUID(),status:'processing'};
  const completed={id:crypto.randomUUID(),status:'complete'};
  fs.writeFileSync(file,JSON.stringify({jobs:[interrupted,completed],paused:true}));
  const cleanup=[];
  const queue=new DurableQueue({file,execute:async()=>{},cleanup:job=>cleanup.push(job.id),notify(){}});
  assert.equal(queue.paused,true);
  assert.equal(queue.jobs[0].status,'paused');
  assert.match(queue.jobs[0].message,/Interrupted/);
  assert.equal(queue.jobs[1].status,'complete');
  assert.deepEqual(cleanup,[interrupted.id]);
});

test('queue preserves unsupported or corrupt state without cleanup, persistence or execution', async t=>{
  for(const content of ['{broken',JSON.stringify({version:999,jobs:[],paused:false}),JSON.stringify({version:2,jobs:[{id:'bad',status:'queued'}],paused:false})]) {
    const directory=temporaryDirectory(t),file=path.join(directory,'downloads.json');
    fs.writeFileSync(file,content);
    let executed=false,cleaned=false;
    const queue=new DurableQueue({file,execute:async()=>{executed=true;},cleanup:()=>{cleaned=true;}});
    assert.match(queue.snapshot().warning,/preserved/);
    await queue.pump();await queue.shutdown();
    assert.throws(()=>queue.add({url:'https://youtu.be/example'}),/preserved/);
    assert.equal(fs.readFileSync(file,'utf8'),content);
    assert.equal(cleaned,false);assert.equal(executed,false);
  }
});

test('migration reconciles checkpoints before cleanup and preserves paused options and completed history',t=>{
  const file=path.join(temporaryDirectory(t),'downloads.json');
  const jobs=[{id:crypto.randomUUID(),status:'downloading',quality:'720p'},
    {id:crypto.randomUUID(),status:'paused',quality:'480p'},
    {id:crypto.randomUUID(),status:'complete',videoId:'saved',playbackPositionSeconds:73}];
  fs.writeFileSync(file,JSON.stringify({jobs,paused:true}));
  const seen=[];
  const queue=new DurableQueue({file,execute:async()=>{},cleanup(){assert.fail('Migration must reconcile before discarding files');},
    recover(job){seen.push(job.id);return {retainedBytes:100,resumable:true};}});
  assert.deepEqual(seen,jobs.slice(0,2).map(job=>job.id));
  assert.equal(queue.jobs[0].status,'paused');assert.equal(queue.jobs[0].retainedBytes,100);
  assert.equal(queue.jobs[1].quality,'480p');assert.deepEqual(queue.jobs[2],jobs[2]);
  assert.equal(JSON.parse(fs.readFileSync(file)).version,2);
});

test('batch admission persists once before execution and rolls back a failed commit', async t=>{
  const directory=temporaryDirectory(t),file=path.join(directory,'downloads.json');
  const queue=new DurableQueue({file,execute:async()=>{},cleanup(){}});queue.pause(true);
  let writes=0;const original=queue._write.bind(queue);
  queue._write=(...args)=>{writes++;original(...args);};
  const data=[{url:'https://youtu.be/a',sourceId:'a'},{url:'https://youtu.be/b',sourceId:'b'},{url:'https://www.youtube.com/watch?v=a',sourceId:'a'}];
  const result=queue.addMany(data);
  assert.deepEqual(result.map(item=>item.outcome),['added','added','alreadyQueued']);
  assert.equal(result[0].id,result[2].id);assert.equal(writes,1);
  assert.deepEqual(queue.jobs.map(job=>job.sourceId),['a','b']);
  queue._write=()=>{throw new Error('Disk write failed');};
  assert.throws(()=>queue.addMany([{url:'https://youtu.be/c',sourceId:'c'}]),/Disk write failed/);
  assert.equal(queue.jobs.length,2);assert.equal(JSON.parse(fs.readFileSync(file)).jobs.length,2);
  assert.throws(()=>queue.addMany([{url:'https://youtu.be/c'},null]),/Invalid download entry/);
  assert.equal(queue.jobs.length,2);
});

test('resume credits only reusable bytes already counted in current disk usage',()=>{
  const storage={savedBytes:0,temporaryBytes:95_000_000,maxLibraryBytes:116_000_000,freeBytes:2_030_000_000};
  assert.match(checkStorageAdmission(storage,100_000_000,1),/library limit/);
  assert.equal(checkStorageAdmission(storage,100_000_000,1,95_000_000),null);
  assert.match(checkStorageAdmission({...storage,maxLibraryBytes:110_000_000},100_000_000,1,95_000_000),/library limit/);
  assert.match(checkStorageAdmission({...storage,freeBytes:2_010_000_000},100_000_000,1,95_000_000),/processing/);
  assert.match(checkStorageAdmission(storage,100_000_000,1,-1),/workspace/);
  assert.match(checkStorageAdmission(storage,100_000_000,1,95_000_000,32_000_000),/library limit/);
});

test('queue persistence failure stops execution and surfaces a recoverable warning', async t=>{
  let executed=false;
  const queue=new DurableQueue({file:path.join(temporaryDirectory(t),'downloads.json'),execute:async()=>{executed=true;},cleanup(){}});
  queue.pause(true);queue.add({url:'https://youtu.be/a'});
  queue._write=()=>{throw new Error('Disk is full');};queue.paused=false;
  await queue.pump();
  assert.equal(executed,false);assert.equal(queue.active,null);assert.equal(queue.running,false);
  assert.match(queue.snapshot().warning,/Disk is full/);
});

test('pause waits for child close and tracked writers before retaining files; stale completion is ignored', async t=>{
  const {EventEmitter}=require('node:events');
  const child=new EventEmitter();let closeChild,closeWriter,retained=false;
  child.kill=()=>{closeChild=()=>child.emit('close',null,'SIGKILL');};
  const queue=new DurableQueue({file:path.join(temporaryDirectory(t),'downloads.json'),cleanup(){},
    retain(){retained=true;return {retainedBytes:42,resumable:true};},execute:async(job,active)=>{
      active.children.add(child);
      active.trackWriter(new Promise(resolve=>{closeWriter=resolve;}));
      await new Promise(()=>{}); // A hung metadata response must not block pause.
    }});
  const job=queue.add({source:'manual',url:'https://youtu.be/a'});
  const pausing=queue.pauseJob(job.id);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(retained,false);closeChild();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(retained,false);closeWriter();await pausing;
  assert.equal(job.status,'paused');assert.equal(job.retainedBytes,42);
  queue.update(job.id,{status:'complete'});assert.equal(job.status,'paused');
  await queue.shutdown();
});

test('bounded network retries respect global stop and manual pause', async t=>{
  let queue;t.after(()=>queue?.shutdown());
  queue=new DurableQueue({file:path.join(temporaryDirectory(t),'downloads.json'),cleanup(){},retryDelays:[10,10,10],
    retain(){return {resumable:true,retainedBytes:2};},execute:async()=>{throw new Error('Connection interrupted');}});
  const job=queue.add({source:'manual',url:'https://youtu.be/a'});
  await eventually(()=>job.status==='waiting-network');queue.pause(true);
  const count=job.retryCount;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(job.retryCount,count);
  queue.pause(false);
  await eventually(()=>job.retryCount===3 && job.status==='waiting-network' && job.nextRetryAt===null);
  queue.retry(job.id);await eventually(()=>job.status==='waiting-network');await queue.pauseJob(job.id);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(job.status,'paused');assert.equal(job.nextRetryAt,null);
});

test('failed quality cleanup preserves held state; smaller-copy changes preserve original input', t=>{
  const queue=new DurableQueue({file:path.join(temporaryDirectory(t),'downloads.json'),cleanup(){throw new Error('Cannot remove files');},execute:async()=>{}});
  queue.pause(true);
  const youtube=queue.add({url:'https://youtu.be/a',quality:'720p'});
  queue.update(youtube.id,{status:'paused',retainedBytes:50,resumable:true});
  assert.throws(()=>queue.retry(youtube.id,{quality:'480p'}),/Cannot remove files/);
  assert.equal(youtube.quality,'720p');assert.equal(youtube.status,'paused');assert.equal(youtube.retainedBytes,50);
  const server=queue.add({provider:'plex',url:'plex://server/1',quality:'original',copyQuality:'original'});
  queue.update(server.id,{status:'paused',retainedBytes:100,resumable:true});
  queue.retry(server.id,{copyQuality:'720p'});
  assert.equal(server.copyQuality,'720p');assert.equal(server.retainedBytes,100);
});

test('waiting jobs deduplicate and old canceled jobs cannot be retried beside a duplicate', async (t) => {
  const directory=temporaryDirectory(t);
  const queue=new DurableQueue({file:path.join(directory,'downloads.json'),execute:async()=>{},cleanup(){},notify(){}});
  queue.pause(true);
  const first=queue.add({source:'manual',sourceId:'same-video',url:'https://youtu.be/same-video'});
  queue.update(first.id,{status:'waiting-storage'});
  assert.equal(queue.add({source:'manual',sourceId:'same-video',url:'https://www.youtube.com/watch?v=same-video'}).id,first.id);
  queue.update(first.id,{status:'waiting-network'});
  assert.equal(queue.add({source:'manual',sourceId:'same-video',url:'https://youtu.be/same-video'}).id,first.id);
  await queue.cancel(first.id);
  queue.add({source:'manual',sourceId:'same-video',url:'https://youtu.be/same-video'});
  assert.throws(()=>queue.retry(first.id),/already has a download/);
  assert.equal(first.status,'canceled');
  assert.equal(queue.jobs.length,2);
});
