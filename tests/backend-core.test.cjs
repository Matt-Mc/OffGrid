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
  fs.symlinkSync(path.join(directory,'video.mp4'),path.join(directory,'linked.mp4'));
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
  assert.equal(queue.jobs[0].status,'error');
  assert.match(queue.jobs[0].message,/Interrupted/);
  assert.equal(queue.jobs[1].status,'complete');
  assert.deepEqual(cleanup,[interrupted.id]);
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
