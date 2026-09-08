const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHarness, eventually } = require('./backend-harness.cjs');

async function harnessFor(t, options) {
  const harness=await createHarness(options);
  t.after(()=>harness.dispose());
  return harness;
}
async function waitForJob(harness, id, status) {
  return eventually(async()=>{
    const job=(await harness.api.listDownloads()).jobs.find(item=>item.id===id);
    return job?.status===status && job;
  },`Job ${id} did not reach ${status}`);
}
function downloadCalls(harness) { return harness.calls.filter(call=>call.args.includes('--output')); }

test('settings IPC validates values and survives restart with an intact legacy library', async (t) => {
  let harness=await createHarness({seed:{'library.json':[],'subscriptions.json':[{id:'legacy-follow',channel:'Legacy channel',channelUrl:'https://www.youtube.com/@legacy'}]}});
  t.after(()=>harness.dispose());
  const legacy=await harness.api.getSettings();
  assert.equal(legacy.saveComments,true);
  assert.equal(legacy.autoDownload,true);
  assert.equal(legacy.maxLibraryBytes,null);
  const saved=await harness.api.updateSettings({defaultQuality:'480p',saveComments:false,maxLibraryBytes:20_000_000_000,checkIntervalHours:12});
  assert.equal(saved.defaultQuality,'480p');
  await assert.rejects(()=>harness.api.updateSettings({maxLibraryBytes:-1}),/Invalid/);
  assert.equal((await harness.api.getSettings()).maxLibraryBytes,20_000_000_000);
  const directory=harness.dataDir;
  await harness.dispose({remove:false});
  harness=await createHarness({directory});
  assert.equal((await harness.api.getSettings()).defaultQuality,'480p');
  assert.equal((await harness.api.getSettings()).checkIntervalHours,12);
  assert.equal((await harness.api.listSubscriptions()).length,1);
  assert.equal(harness.networkRequests,0);
});

test('download IPC honors recorded quality and comments, persists a local video and plays offline', async (t) => {
  const harness=await harnessFor(t);
  await harness.api.updateSettings({defaultQuality:'480p',saveComments:true});
  const accepted=await harness.api.startDownload('https://www.youtube.com/watch?v=local');
  const ready=await waitForJob(harness,accepted.id,'complete');
  const [video]=await harness.api.listVideos();
  assert.equal(video.sourceId,'local');
  assert.equal(video.deletionBytes,160,'storage removal estimate must include the thumbnail');
  assert.equal(video.comments[0].text,'Saved locally');
  assert.equal(ready.quality,'480p');
  assert.ok(fs.existsSync(video.filePath));
  assert.ok(fs.existsSync(video.thumbnailPath));
  const args=downloadCalls(harness)[0].args;
  assert.match(args[args.indexOf('--format')+1],/height<=480/);
  const response=await harness.media(harness.api.videoUrl(video.id));
  assert.equal(response.status,200);
  assert.equal((await response.arrayBuffer()).byteLength,128);
  const thumbnail=await harness.media(harness.api.thumbnailUrl(video.id));
  assert.equal(thumbnail.status,200);
  assert.equal(harness.networkRequests,0);
});

test('failed and canceled downloads clean partials without disturbing other jobs, and retry uses the same job', async (t) => {
  const harness=await harnessFor(t,{fixtures:{failed:{error:true},held:{hold:true}}});
  await harness.api.setQueuePaused(true);
  const failed=await harness.api.startDownload('https://youtu.be/failed');
  const healthy=await harness.api.startDownload('https://youtu.be/healthy');
  await harness.api.setQueuePaused(false);
  await waitForJob(harness,failed.id,'error');
  await waitForJob(harness,healthy.id,'complete');
  assert.equal((await harness.api.listDownloads()).jobs.length,2);
  harness.fixtures.failed.error=false;
  await harness.api.retryDownload(failed.id,{quality:'1080p'});
  await waitForJob(harness,failed.id,'complete');
  assert.equal((await harness.api.listDownloads()).jobs.length,2);
  const held=await harness.api.startDownload('https://youtu.be/held');
  await waitForJob(harness,held.id,'downloading');
  await harness.api.cancelDownload(held.id);
  await waitForJob(harness,held.id,'canceled');
  assert.equal((await harness.api.getStorage()).temporaryBytes,0);
  assert.equal((await harness.api.listVideos()).length,2);
});

test('unknown sizes wait under a cap and can be explicitly retried after removing it', async (t) => {
  const harness=await harnessFor(t,{fixtures:{unknown:{expectedBytes:null}}});
  await harness.api.updateSettings({maxLibraryBytes:20_000_000_000});
  const accepted=await harness.api.startDownload('https://youtu.be/unknown');
  const waiting=await waitForJob(harness,accepted.id,'waiting-storage');
  assert.match(waiting.message,/Size unavailable/);
  assert.equal(downloadCalls(harness).length,0);
  await harness.api.updateSettings({maxLibraryBytes:null});
  await harness.api.retryDownload(accepted.id);
  await waitForJob(harness,accepted.id,'complete');
});

test('low disk space holds downloads even without a library limit', async (t) => {
  const harness=await harnessFor(t,{freeBytes:1_500_000_000});
  const accepted=await harness.api.startDownload('https://youtu.be/lowspace');
  const waiting=await waitForJob(harness,accepted.id,'waiting-storage');
  assert.match(waiting.message,/2 GB/);
  assert.equal(downloadCalls(harness).length,0);
  assert.equal((await harness.api.listVideos()).length,0);
});

test('an underestimated completed download cannot be published over budget', async (t) => {
  const harness=await harnessFor(t,{fixtures:{growth:{expectedBytes:128,actualBytes:18_000_000}}});
  await harness.api.updateSettings({maxLibraryBytes:17_000_000});
  const accepted=await harness.api.startDownload('https://youtu.be/growth');
  await waitForJob(harness,accepted.id,'waiting-storage');
  assert.equal(downloadCalls(harness).length,1);
  assert.equal((await harness.api.listVideos()).length,0);
  assert.equal((await harness.api.getStorage()).temporaryBytes,0);
});

test('playback progress survives restart; lowering the cap preserves existing files', async (t) => {
  let harness=await createHarness();
  t.after(()=>harness.dispose());
  const accepted=await harness.api.startDownload('https://youtu.be/watching');
  await waitForJob(harness,accepted.id,'complete');
  const [video]=await harness.api.listVideos();
  await harness.api.savePlayback(video.id,{positionSeconds:47,watched:false});
  await harness.api.updateSettings({maxLibraryBytes:1});
  assert.ok(fs.existsSync(video.filePath));
  assert.ok((await harness.api.getStorage()).savedBytes>1);
  const directory=harness.dataDir;
  await harness.dispose({remove:false});
  harness=await createHarness({directory});
  const [restored]=await harness.api.listVideos();
  assert.equal(restored.playbackPositionSeconds,47);
  assert.ok(fs.existsSync(restored.filePath));
  assert.equal((await harness.api.getSettings()).maxLibraryBytes,1);
});

test('deletion removes video and thumbnail, blocks automatic rediscovery, and allows manual re-add', async (t) => {
  const harness=await harnessFor(t,{fixtures:{feed:[{id:'deleted',title:'Deleted video'}]}});
  const accepted=await harness.api.startDownload('https://youtu.be/deleted');
  await waitForJob(harness,accepted.id,'complete');
  const [video]=await harness.api.listVideos();
  const channel=await harness.api.subscribe({channelUrl:'https://www.youtube.com/@test',autoDownload:true,initialFetchCount:0});
  await harness.api.deleteVideo(video.id);
  assert.equal(fs.existsSync(video.filePath),false);
  assert.equal(fs.existsSync(video.thumbnailPath),false);
  assert.ok(harness.read('deleted-sources.json').includes('deleted'));
  await harness.api.syncSubscriptions(channel.id);
  assert.equal((await harness.api.listVideos()).length,0);
  assert.equal((await harness.api.listDownloads()).jobs.length,1);
  const readded=await harness.api.startDownload('https://youtu.be/deleted');
  await waitForJob(harness,readded.id,'complete');
  assert.equal((await harness.api.listVideos()).length,1);
});

test('live storage monitoring stops an underestimated active download and cleans its files', async (t) => {
  const harness=await harnessFor(t,{fixtures:{growing:{expectedBytes:128,actualBytes:18_000_000,hold:true}}});
  await harness.api.updateSettings({maxLibraryBytes:17_000_000});
  const accepted=await harness.api.startDownload('https://youtu.be/growing');
  await waitForJob(harness,accepted.id,'waiting-storage');
  assert.equal((await harness.api.getStorage()).temporaryBytes,0);
  assert.equal((await harness.api.listVideos()).length,0);
});

test('lowering the cap during a download safely stops affected work and keeps saved videos', async (t) => {
  const harness=await harnessFor(t,{fixtures:{held:{hold:true}}});
  const ready=await harness.api.startDownload('https://youtu.be/ready');
  await waitForJob(harness,ready.id,'complete');
  const [video]=await harness.api.listVideos();
  const held=await harness.api.startDownload('https://youtu.be/held');
  await waitForJob(harness,held.id,'downloading');
  await harness.api.updateSettings({maxLibraryBytes:1});
  await waitForJob(harness,held.id,'waiting-storage');
  assert.ok(fs.existsSync(video.filePath));
  assert.equal((await harness.api.getStorage()).temporaryBytes,0);
  assert.equal((await harness.api.listVideos()).length,1);
});

test('channel downloads use the configured default options and the same storage checks', async (t) => {
  const harness=await harnessFor(t,{fixtures:{feed:[{id:'channelvideo',title:'Channel video'}]}});
  await harness.api.updateSettings({defaultQuality:'480p',saveComments:true,maxLibraryBytes:1});
  const channel=await harness.api.subscribe({channelUrl:'https://www.youtube.com/@test',autoDownload:true,initialFetchCount:0});
  assert.equal((await harness.api.listDownloads()).jobs.length,0,'following alone should not start a download');
  await harness.api.syncSubscriptions(channel.id);
  const [job]=(await harness.api.listDownloads()).jobs;
  await waitForJob(harness,job.id,'waiting-storage');
  assert.equal(job.source,'subscription');
  assert.equal(job.quality,'480p');
  assert.equal(job.saveComments,true);
  assert.equal(downloadCalls(harness).length,0);
});

test('restart removes interrupted working files while preserving user-paused queued work', async (t) => {
  const interruptedId=crypto.randomUUID(),queuedId=crypto.randomUUID();
  const harness=await harnessFor(t,{seed:{
    'downloads.json':{paused:true,jobs:[{id:interruptedId,status:'processing',url:'https://youtu.be/interrupted'},{id:queuedId,status:'queued',url:'https://youtu.be/queued'}]},
    [`videos/.work/${interruptedId}/${interruptedId}.mp4.part`]:Buffer.alloc(100),
    'videos/unrelated-file.txt':Buffer.from('keep'),
  }});
  const snapshot=await harness.api.listDownloads();
  assert.equal(snapshot.paused,true);
  assert.equal(snapshot.jobs[0].status,'error');
  assert.equal(snapshot.jobs[1].status,'queued');
  assert.equal(fs.existsSync(path.join(harness.dataDir,'videos','.work',interruptedId)),false);
  assert.equal(fs.readFileSync(path.join(harness.dataDir,'videos','unrelated-file.txt'),'utf8'),'keep');
  assert.equal(downloadCalls(harness).length,0);
});

test('offline download errors remain attached to their jobs while local playback stays available', async (t) => {
  const harness=await harnessFor(t);
  const ready=await harness.api.startDownload('https://youtu.be/offlinevideo');
  await waitForJob(harness,ready.id,'complete');
  const [video]=await harness.api.listVideos();
  harness.setOnline(false);
  const waiting=await harness.api.startDownload('https://youtu.be/newvideo');
  await waitForJob(harness,waiting.id,'waiting-network');
  assert.equal((await harness.media(harness.api.videoUrl(video.id))).status,200);
  assert.equal((await harness.api.listDownloads()).jobs.length,2);
  assert.equal(harness.networkRequests,0);
});

test('disabling automatic downloads cancels scheduled work while preserving explicitly requested jobs', async (t) => {
  const automaticId=crypto.randomUUID(),explicitId=crypto.randomUUID();
  const subscriptionId='test-follow';
  const harness=await harnessFor(t,{seed:{
    'subscriptions.json':[{id:subscriptionId,channel:'Test channel',channelUrl:'https://www.youtube.com/@test',autoDownload:true}],
    'downloads.json':{paused:true,jobs:[
      {id:automaticId,status:'queued',source:'subscription',subscriptionId,manualTrigger:false,url:'https://youtu.be/automatic'},
      {id:explicitId,status:'queued',source:'subscription',subscriptionId,manualTrigger:true,url:'https://youtu.be/explicit'},
    ]},
  }});
  await harness.api.updateSubscription(subscriptionId,{autoDownload:false});
  const snapshot=await harness.api.listDownloads();
  assert.equal(snapshot.jobs.find(job=>job.id===automaticId).status,'canceled');
  assert.equal(snapshot.jobs.find(job=>job.id===explicitId).status,'queued');
  assert.equal(snapshot.paused,true);
  assert.equal(downloadCalls(harness).length,0);
});

test('canceling while a thumbnail request hangs releases the queue and rejects late file writes', async (t) => {
  const thumbnailUrl='https://fixture.invalid/delayed-thumbnail.jpg';
  const harness=await harnessFor(t,{fixtures:{
    delayed:{metadata:{thumbnail:thumbnailUrl}},
    http:{[thumbnailUrl]:{hold:true}},
  }});
  const delayed=await harness.api.startDownload('https://youtu.be/delayed');
  await eventually(()=>harness.networkRequests===1,'Thumbnail HTTP request never started');
  const next=await harness.api.startDownload('https://youtu.be/next');
  let canceled=false;
  const cancellation=harness.api.cancelDownload(delayed.id).then(()=>{canceled=true;});
  await eventually(()=>canceled,'Cancellation waited for a hung thumbnail response',1000);
  await cancellation;
  await waitForJob(harness,delayed.id,'canceled');
  await waitForJob(harness,next.id,'complete');
  harness.respondHttp(thumbnailUrl,Buffer.alloc(32));
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(harness.dataDir,'thumbnails',`${delayed.id}.jpg`)),false);
  assert.equal(fs.existsSync(path.join(harness.dataDir,'videos',`${delayed.id}.mp4`)),false);
  assert.equal((await harness.api.getStorage()).temporaryBytes,0);
  assert.deepEqual((await harness.api.listVideos()).map(video=>video.sourceId),['next']);
});
