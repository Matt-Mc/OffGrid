const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const http=require('node:http');
const {createHarness,eventually}=require('./backend-harness.cjs');

async function jobState(h,id,status) {
  return eventually(async()=>{const job=(await h.api.listDownloads()).jobs.find(job=>job.id===id);return job?.status===status && job;},`Download did not become ${status}`);
}
function mediaCalls(h) {return h.calls.filter(call=>call.args.includes('--output') && !call.args.includes('--skip-download'));}
function capture(url) {return `offgrid://add?url=${encodeURIComponent(url)}`;}

async function conversionFixture(t,fixtures={}) {
  const body=Buffer.alloc(1024,37),streams=[];
  const server=http.createServer((request,response)=>{
    const json=value=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({MediaContainer:value}));};
    if(request.url==='/') return json({machineIdentifier:'conversion-server',friendlyName:'Fixture server'});
    if(request.url.startsWith('/library/parts/')) {streams.push(request.url);response.writeHead(200,{'Content-Length':body.length,ETag:'"original"'});return response.end(body);}
    const id=request.url.match(/\/metadata\/(\d+)/)?.[1] || '42';
    return json({Metadata:[{ratingKey:id,type:'movie',title:'Conversion fixture',duration:120000,Media:[{container:'mkv',Part:[{key:`/library/parts/${id}/2/file.mkv`,size:body.length}]}]}]});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const h=await createHarness({fixtures});
  t.after(async()=>{await h.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await h.api.connectPlex({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'fixture-token'});
  return {h,body,streams};
}

test('server smaller-copy IPC validates and saves a smaller output with its original size',async t=>{
  const {h,body,streams}=await conversionFixture(t);
  const accepted=await h.api.downloadPlex('42',{copyQuality:'720p'});await jobState(h,accepted.id,'complete');
  const [video]=await h.api.listVideos();assert.equal(video.copyQuality,'720p');
  assert.equal(video.sourceBytes,body.length);assert.equal(video.sizeBytes,body.length/2);assert.match(video.filePath,/\.mp4$/);
  assert.ok(h.calls.some(call=>call.args.includes('-xerror')),'converted output must pass decode validation');
  assert.equal(streams.length,1);assert.equal((await h.api.getStorage()).temporaryBytes,0);
});

test('pausing conversion keeps the completed original and Keep original needs no second transfer',async t=>{
  const {h,body,streams}=await conversionFixture(t,{ffmpeg:{hold:true}});
  const accepted=await h.api.downloadPlex('42',{copyQuality:'720p'});
  const directory=path.join(h.dataDir,'videos','.work',accepted.id),output=path.join(directory,`${accepted.id}.smaller.mp4`);
  await eventually(()=>fs.existsSync(output));await h.api.pauseDownload(accepted.id);
  const paused=await jobState(h,accepted.id,'paused');assert.equal(paused.retainedBytes,body.length);assert.equal(fs.existsSync(output),false);
  await h.api.resumeDownload(accepted.id,{copyQuality:'original'});await jobState(h,accepted.id,'complete');
  const [video]=await h.api.listVideos();assert.equal(video.copyQuality,'original');assert.deepEqual(fs.readFileSync(video.filePath),body);
  assert.equal(streams.length,1);assert.equal(h.calls.filter(call=>call.args.includes('-c:v')).length,1);
});

test('failed conversion can keep the completed original; cancel discards a separate interrupted conversion',async t=>{
  const {h,body,streams}=await conversionFixture(t,{ffmpeg:{error:true}});
  const failed=await h.api.downloadPlex('42',{copyQuality:'720p'});
  const error=await jobState(h,failed.id,'error');assert.equal(error.retainedBytes,body.length);
  await h.api.retryDownload(failed.id,{copyQuality:'original'});await jobState(h,failed.id,'complete');assert.equal(streams.length,1);
  h.fixtures.ffmpeg={hold:true};
  const canceled=await h.api.downloadPlex('43',{copyQuality:'720p'});
  const directory=path.join(h.dataDir,'videos','.work',canceled.id);
  await eventually(()=>fs.existsSync(path.join(directory,`${canceled.id}.smaller.mp4`)));
  await h.api.cancelDownload(canceled.id);await jobState(h,canceled.id,'canceled');
  assert.equal(fs.existsSync(directory),false);assert.equal((await h.api.getStorage()).temporaryBytes,0);
  assert.equal((await h.api.listVideos()).length,1);
});

test('Plex pause/reopen resumes its durable validated byte range through real IPC',async t=>{
  const body=Buffer.alloc(256,42),requests=[];let hold=true,h;
  const server=http.createServer((request,response)=>{
    if(request.headers['x-plex-token']!=='fixture-token') {response.writeHead(401);response.end();return;}
    const json=value=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({MediaContainer:value}));};
    if(request.url==='/') return json({machineIdentifier:'fixture-resume',friendlyName:'Fixture server'});
    if(request.url.startsWith('/library/parts/')) {
      requests.push({range:request.headers.range,ifRange:request.headers['if-range']});
      const offset=Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] || 0);
      response.writeHead(offset?206:200,{'Content-Length':body.length-offset,ETag:'"stable-original"',...(offset?{'Content-Range':`bytes ${offset}-${body.length-1}/${body.length}`}:{})});
      if(hold) {response.write(body.subarray(offset,64));return;}
      return response.end(body.subarray(offset));
    }
    return json({Metadata:[{ratingKey:'42',type:'movie',title:'Range fixture',duration:120000,Media:[{container:'mkv',Part:[{key:'/library/parts/1/2/file.mkv',size:body.length}]}]}]});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{await h?.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  h=await createHarness();await h.api.connectPlex({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'fixture-token'});
  const accepted=await h.api.downloadPlex('42');
  const partial=path.join(h.dataDir,'videos','.work',accepted.id,`${accepted.id}.original.mkv`);
  await eventually(()=>fs.existsSync(partial) && fs.statSync(partial).size===64);
  await h.api.pauseDownload(accepted.id);assert.equal((await jobState(h,accepted.id,'paused')).retainedBytes,64);
  const directory=h.dataDir;await h.dispose({remove:false});h=await createHarness({directory});h.setOnline(false);hold=false;
  assert.equal((await jobState(h,accepted.id,'paused')).resumable,true);
  await h.api.resumeDownload(accepted.id);await jobState(h,accepted.id,'complete');
  const [video]=await h.api.listVideos();assert.deepEqual(fs.readFileSync(video.filePath),body);
  assert.deepEqual(requests,[{range:undefined,ifRange:undefined},{range:'bytes=64-',ifRange:'"stable-original"'}]);
  assert.equal((await h.api.getStorage()).temporaryBytes,0);
});

test('YouTube pause retains bytes across reopen and resumes the same job without replacing its prefix',async t=>{
  let h=await createHarness({fixtures:{resume:{hold:true,partialBytes:64,byte:7}}});t.after(()=>h.dispose());
  const accepted=await h.api.startDownload('https://youtu.be/resume');
  const partial=path.join(h.dataDir,'videos','.work',accepted.id,`${accepted.id}.mp4.part`);
  await eventually(()=>fs.existsSync(partial));
  await h.api.pauseDownload(accepted.id);
  const paused=await jobState(h,accepted.id,'paused');
  assert.equal(paused.retainedBytes,64);assert.equal(paused.resumable,true);
  assert.ok((await h.api.getStorage()).temporaryBytes>=64);
  const directory=h.dataDir;await h.dispose({remove:false});
  h=await createHarness({directory,fixtures:{resume:{byte:9}}});
  assert.equal((await jobState(h,accepted.id,'paused')).retainedBytes,64);assert.equal(mediaCalls(h).length,0);
  await h.api.resumeDownload(accepted.id);await jobState(h,accepted.id,'complete');
  const [video]=await h.api.listVideos();const bytes=fs.readFileSync(video.filePath);
  assert.equal(video.id,accepted.id);assert.equal(bytes.length,128);
  assert.ok(bytes.subarray(0,64).every(byte=>byte===7));assert.ok(bytes.subarray(64).every(byte=>byte===9));
  assert.equal(mediaCalls(h)[0].resumedBytes,64);assert.equal((await h.api.listDownloads()).jobs.length,1);
  assert.equal((await h.api.getStorage()).temporaryBytes,0);
});

test('shutdown checkpoints an active job as paused and preserves its reusable bytes',async t=>{
  let h=await createHarness({fixtures:{shutdown:{hold:true,partialBytes:80}}});t.after(()=>h.dispose());
  const accepted=await h.api.startDownload('https://youtu.be/shutdown');
  const partial=path.join(h.dataDir,'videos','.work',accepted.id,`${accepted.id}.mp4.part`);
  await eventually(()=>fs.existsSync(partial));
  const directory=h.dataDir;await h.dispose({remove:false});assert.equal(h.app.exitCode,0);h=await createHarness({directory});
  const paused=await jobState(h,accepted.id,'paused');assert.equal(paused.retainedBytes,80);
  assert.equal(mediaCalls(h).length,0);await h.api.cancelDownload(accepted.id);
  assert.equal(fs.existsSync(partial),false);assert.equal((await h.api.getStorage()).temporaryBytes,0);
});

test('future queue state blocks downloads through IPC while preserving saved video files',async t=>{
  const savedId=crypto.randomUUID();
  const h=await createHarness({seed:{'downloads.json':{version:99,paused:false,jobs:[]},'library.json':[],[`videos/${savedId}.mp4`]:Buffer.alloc(24)}});t.after(()=>h.dispose());
  assert.match((await h.api.listDownloads()).warning,/preserved/);
  await assert.rejects(()=>h.api.startDownload('https://youtu.be/a'),/preserved/);
  assert.equal(h.read('downloads.json').version,99);assert.equal(fs.statSync(path.join(h.dataDir,'videos',`${savedId}.mp4`)).size,24);
  assert.equal(mediaCalls(h).length,0);
});

test('playlist preview paginates without enqueueing and batches report canonical duplicate outcomes',async t=>{
  const entries=Array.from({length:102},(_,index)=>({id:`entry${index}`,title:`Entry ${index}`}));
  entries[1]={id:'entry1',title:'[Private video]',availability:'private'};
  const h=await createHarness({fixtures:{PLfixture:{entries}}});t.after(()=>h.dispose());
  const first=await h.api.previewDownloads({requestId:'page-one',input:'https://www.youtube.com/playlist?list=PLfixture',mode:'playlist'});
  assert.equal(first.items.length,100);assert.equal(first.hasMore,true);assert.equal(first.items[1].available,false);
  const last=await h.api.previewDownloads({requestId:'page-two',input:'https://www.youtube.com/playlist?list=PLfixture',mode:'playlist',start:100});
  assert.equal(last.items.length,2);assert.equal(last.complete,true);assert.equal(last.items[0].id,'entry100');
  assert.equal((await h.api.listDownloads()).jobs.length,0);
  await h.api.setQueuePaused(true);
  const result=await h.api.addDownloadBatch({urls:[first.items[0].url,'https://youtu.be/entry0',last.items[0].url,'https://example.com/invalid'],quality:'480p'});
  assert.deepEqual(result.counts,{added:2,alreadyQueued:1,alreadySaved:0,rejected:1});
  assert.deepEqual((await h.api.listDownloads()).jobs.map(job=>job.sourceId),['entry0','entry100']);
  const repeat=await h.api.startDownload('https://youtu.be/entry0');assert.equal(repeat.accepted,false);assert.equal(repeat.outcome,'alreadyQueued');
});

test('canceling a metadata preview closes its process and never queues media',async t=>{
  const h=await createHarness({fixtures:{slowpreview:{metadataHold:true}}});t.after(()=>h.dispose());
  const preview=h.api.previewDownloads({requestId:'cancel-me',input:'https://youtu.be/slowpreview'});
  const rejection=assert.rejects(preview,/cancel/i);
  await eventually(()=>h.calls.some(call=>call.args.includes('--dump-single-json')));
  await h.api.cancelPreview('cancel-me');await rejection;
  assert.equal((await h.api.listDownloads()).jobs.length,0);
  assert.equal(mediaCalls(h).length,0);
});

test('offline captions are saved, served and deleted with their video; asset-only retry leaves media untouched',async t=>{
  const h=await createHarness({fixtures:{captions:{metadata:{subtitles:{en:[{ext:'vtt'}]}}}}});t.after(()=>h.dispose());
  const added=await h.api.startDownload('https://youtu.be/captions','720p',{subtitleLanguages:['en']});
  await jobState(h,added.id,'complete');let [video]=await h.api.listVideos();
  assert.equal(video.assets.length,1);assert.equal(video.assetWarnings.length,0);
  const originalAsset=video.assets[0].filePath,mediaStat=fs.statSync(video.filePath),initialCalls=mediaCalls(h).length;
  h.setOnline(false);
  const response=await h.media(h.api.subtitleUrl(video.id,video.assets[0].id));assert.equal(response.status,200);assert.match(await response.text(),/Fixture offline caption/);
  assert.equal((await h.api.getStorage()).savedBytes,mediaStat.size+fs.statSync(video.thumbnailPath).size+fs.statSync(originalAsset).size);
  h.setOnline(true);
  h.fixtures.captions.captionErrorAfterWrite=true;
  const failedRetry=await h.api.retrySubtitles(video.id);await jobState(h,failedRetry.id,'complete');
  [video]=await h.api.listVideos();assert.equal(video.assets[0].filePath,originalAsset);assert.equal(fs.existsSync(originalAsset),true);
  assert.ok(video.assetWarnings.length>0);assert.equal((await h.api.getStorage()).temporaryBytes,0);
  assert.equal(fs.existsSync(path.join(h.dataDir,'videos','.work',failedRetry.id)),false);
  h.fixtures.captions.captionErrorAfterWrite=false;
  const retry=await h.api.retrySubtitles(video.id);await jobState(h,retry.id,'complete');[video]=await h.api.listVideos();
  assert.equal(mediaCalls(h).length,initialCalls);assert.equal(fs.statSync(video.filePath).ino,mediaStat.ino);
  assert.equal(video.assets.length,1);assert.equal(fs.existsSync(originalAsset),false);
  const files=[video.filePath,video.thumbnailPath,...video.assets.map(asset=>asset.filePath)];
  await h.api.deleteVideo(video.id);for(const file of files) assert.equal(fs.existsSync(file),false);
});

test('captures survive cold launch, warm delivery and reopen until explicitly acknowledged',async t=>{
  const first=capture('https://www.youtube.com/watch?v=one&list=PLfixture');
  let h=await createHarness({beforeReady:app=>app.emit('open-url',{preventDefault(){}},first)});t.after(()=>h.dispose());
  let pending=await h.api.listCaptures();assert.equal(pending.items.length,1);assert.match(pending.items[0].url,/list=PLfixture/);
  h.window.minimized=true;
  h.app.emit('open-url',{preventDefault(){}},capture('https://youtu.be/two'));
  assert.equal(h.window.minimized,false);assert.equal(h.window.focused,true);
  h.app.emit('second-instance',{},[capture('https://youtu.be/two')]);
  pending=await h.api.listCaptures();assert.equal(pending.items.length,2);assert.equal((await h.api.listDownloads()).jobs.length,0);
  const originalWindow=h.window;originalWindow.close();
  h.app.emit('open-url',{preventDefault(){}},capture('https://youtu.be/three'));assert.notEqual(h.window,originalWindow);
  const directory=h.dataDir;await h.dispose({remove:false});h=await createHarness({directory});
  pending=await h.api.listCaptures();assert.equal(pending.items.length,3);
  const acknowledged=await h.api.acknowledgeCapture(pending.items[0].id);assert.equal(acknowledged.items.length,2);
  assert.equal(h.read('captures.json').items.length,2);
});

test('capture and download IPC reject untrusted senders and malformed captures without starting work',async t=>{
  const h=await createHarness();t.after(()=>h.dispose());
  for(const channel of ['capture:list','downloads:list','download:start']) {
    await assert.rejects(()=>h.invokeWithEvent(channel,{sender:{},senderFrame:{url:'https://untrusted.invalid'}},{url:'https://youtu.be/a'}),/Offgrid window/);
    await assert.rejects(()=>h.invokeWithEvent(channel,{sender:h.window.webContents,senderFrame:{url:h.window.webContents.mainFrame.url}},{url:'https://youtu.be/a'}),/Offgrid window/);
  }
  h.app.emit('open-url',{preventDefault(){}},capture('file:///tmp/private'));
  assert.equal((await h.api.listCaptures()).items.length,0);assert.ok((await h.api.listCaptures()).warning);
  assert.equal(mediaCalls(h).length,0);assert.equal(h.networkRequests,0);
  assert.equal(h.window.windowOpenHandler({url:'https://untrusted.invalid'}).action,'deny');
});
