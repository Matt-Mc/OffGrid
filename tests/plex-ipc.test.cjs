const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, eventually } = require('./backend-harness.cjs');

const token = 'test-plex-credential-not-for-logs';
async function plexFixture(t) {
  const state = {serverId:'fixture-server',size:128,hold:false,requests:[],streams:0};
  const server = http.createServer((req,res)=>{
    state.requests.push({url:req.url,token:req.headers['x-plex-token']});
    if(req.headers['x-plex-token']!==token) {res.writeHead(401); res.end(); return;}
    const json=data=>{res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({MediaContainer:data}));};
    if(req.url==='/') return json({machineIdentifier:state.serverId,friendlyName:'Fixture Plex'});
    if(req.url==='/library/sections') return json({Directory:[{key:'1',type:'movie',title:'Movies'}]});
    if(req.url.startsWith('/library/parts/')) {
      state.streams++;
      res.writeHead(200,{'Content-Length':state.size});
      if(state.hold) {res.write(Buffer.alloc(Math.min(32,state.size))); return;}
      return res.end(Buffer.alloc(state.size,42));
    }
    const id=req.url.match(/\/metadata\/(\d+)/)?.[1] || '42';
    return json({totalSize:1,Metadata:[{ratingKey:id,type:'movie',title:`Plex film ${id}`,duration:120000,
      Media:[{container:'mkv',Part:[{key:'/library/parts/1/2/file.mkv',size:state.size}]}]}]});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject); server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));});
  return {...state,state,baseUrl:`http://127.0.0.1:${server.address().port}`};
}
async function harnessFor(t,options) {const h=await createHarness(options); t.after(()=>h.dispose()); return h;}
async function jobState(h,id,status) {
  return eventually(async()=>{const job=(await h.api.listDownloads()).jobs.find(job=>job.id===id); return job?.status===status && job;},`Job did not reach ${status}`);
}

test('Plex credentials are encrypted, excluded from IPC/state, and survive restart',async t=>{
  const fixture=await plexFixture(t);
  let h=await createHarness(); t.after(()=>h.dispose());
  const status=await h.api.connectPlex({baseUrl:fixture.baseUrl,token});
  assert.equal(status.serverId,'fixture-server');
  assert.ok(!JSON.stringify(status).includes(token));
  const saved=h.read('plex-connection.json');
  assert.ok(saved.encryptedToken);
  assert.ok(!JSON.stringify(saved).includes(token));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(h.dataDir,'plex-connection.json')).mode&0o777,0o600);
  const directory=h.dataDir;
  await h.dispose({remove:false}); h=await createHarness({directory});
  assert.equal((await h.api.getPlexConfig()).configured,true);
  assert.equal((await h.api.plexSections())[0].title,'Movies');
  await assert.rejects(()=>h.api.connectPlex({baseUrl:fixture.baseUrl,token:'wrong'}),/authentication failed/);
  assert.equal((await h.api.plexSections()).length,1,'failed reconnect preserves good credentials');
  assert.ok(fixture.state.requests.every(req=>!req.url.includes(token)));
});

test('Plex connection refuses saving a token when keychain encryption is unavailable',async t=>{
  const fixture=await plexFixture(t),h=await harnessFor(t,{encryptionAvailable:false});
  await assert.rejects(()=>h.api.connectPlex({baseUrl:fixture.baseUrl,token}),/keychain/);
  assert.equal(fixture.state.requests.length,0);
  assert.equal(fs.existsSync(path.join(h.dataDir,'plex-connection.json')),false);
});

test('Plex original download works without internet, persists MKV and uses independent source IDs',async t=>{
  const fixture=await plexFixture(t),h=await harnessFor(t);
  await h.api.connectPlex({baseUrl:fixture.baseUrl,token}); h.setOnline(false);
  const accepted=await h.api.downloadPlex('42');
  const completed=await jobState(h,accepted.id,'complete');
  const [video]=await h.api.listVideos();
  assert.equal(video.sourceId,'plex:fixture-server:42');
  assert.equal(video.provider,'plex'); assert.equal(path.extname(video.filePath),'.mkv');
  assert.equal(video.duration,120); assert.equal(video.sizeBytes,128);
  assert.equal(completed.quality,'original'); assert.equal(h.calls.length,0,'no yt-dlp or FFmpeg needed');
  assert.deepEqual(fs.readFileSync(video.filePath),Buffer.alloc(128,42));
  assert.ok(!JSON.stringify(h.events).includes(token));
  assert.ok(!JSON.stringify(h.read('downloads.json')).includes(token));
  assert.equal((await h.api.downloadPlex('42')).alreadySaved,true);
  await h.api.disconnectPlex();
  assert.equal((await h.api.getPlexConfig()).configured,false);
  assert.equal(fs.existsSync(video.filePath),true);
});

test('Plex reserves original-file workspace and holds before transfer when storage is insufficient',async t=>{
  const fixture=await plexFixture(t),h=await harnessFor(t);
  await h.api.connectPlex({baseUrl:fixture.baseUrl,token});
  fixture.state.size=1_000_000;
  await h.api.updateSettings({maxLibraryBytes:17_100_000});
  const fits=await h.api.downloadPlex('42'); await jobState(h,fits.id,'complete');
  assert.equal(fixture.state.streams,1,'1x original reservation admits a file 3x would block');
  await h.api.updateSettings({maxLibraryBytes:1_000_001});
  const blocked=await h.api.downloadPlex('43'); await jobState(h,blocked.id,'waiting-storage');
  assert.equal(fixture.state.streams,1);
  assert.equal((await h.api.listVideos()).length,1);
});

test('Plex cancellation closes an active stream, cleans partials, and retries original quality',async t=>{
  const fixture=await plexFixture(t),h=await harnessFor(t);
  await h.api.connectPlex({baseUrl:fixture.baseUrl,token}); fixture.state.hold=true;
  const accepted=await h.api.downloadPlex('42'); await jobState(h,accepted.id,'downloading');
  await eventually(()=>fixture.state.streams===1);
  await h.api.cancelDownload(accepted.id); await jobState(h,accepted.id,'canceled');
  assert.equal((await h.api.getStorage()).temporaryBytes,0);
  await assert.rejects(()=>h.api.retryDownload(accepted.id,{quality:'720p'}),/original quality/);
  fixture.state.hold=false;
  await h.api.retryDownload(accepted.id); await jobState(h,accepted.id,'complete');
  assert.equal((await h.api.listDownloads()).jobs.length,1);
});

test('queued Plex jobs reject a changed server identity before downloading bytes',async t=>{
  const fixture=await plexFixture(t),h=await harnessFor(t);
  await h.api.connectPlex({baseUrl:fixture.baseUrl,token}); await h.api.setQueuePaused(true);
  const accepted=await h.api.downloadPlex('42'); fixture.state.serverId='different-server';
  await h.api.setQueuePaused(false); const failed=await jobState(h,accepted.id,'error');
  assert.match(failed.error,/different Plex server/); assert.equal(fixture.state.streams,0);
});

test('disconnect cancels active and queued Plex downloads while preserving YouTube jobs',async t=>{
  const fixture=await plexFixture(t),h=await harnessFor(t);
  await h.api.connectPlex({baseUrl:fixture.baseUrl,token}); fixture.state.hold=true;
  const active=await h.api.downloadPlex('42'); await jobState(h,active.id,'downloading');
  await h.api.setQueuePaused(true);
  const pending=await h.api.downloadPlex('43');
  const youtube=await h.api.startDownload('https://youtu.be/preserved');
  await h.api.disconnectPlex();
  await jobState(h,active.id,'canceled'); await jobState(h,pending.id,'canceled');
  await jobState(h,youtube.id,'queued');
  assert.equal((await h.api.getStorage()).temporaryBytes,0);
});

test('player IPC resolves only library files, persists progress and stops before deletion',async t=>{
  let callbacks,opened,stopped=0,state={videoId:null,status:'idle'};
  const h=await harnessFor(t,{playerFactory:options=>{
    callbacks=options;
    return {status:async()=>({available:true}),state:()=>state,
      open:async video=>{opened=video;state={videoId:video.id,status:'playing'};options.onState(state);return state;},
      stop:async()=>{stopped++;state={videoId:null,status:'stopped'};},control:async()=>{}};
  }});
  const accepted=await h.api.startDownload('https://youtu.be/player-fixture'); await jobState(h,accepted.id,'complete');
  await assert.rejects(()=>h.api.openPlayer('/etc/passwd'),/could not be found/);
  await assert.rejects(()=>h.api.controlPlayer('run'),/Invalid player action/);
  await h.api.openPlayer(accepted.id);
  assert.equal(opened.filePath,(await h.api.listVideos())[0].filePath);
  callbacks.onProgress(accepted.id,{positionSeconds:47,watched:false});
  assert.equal(h.read('library.json')[0].playbackPositionSeconds,47);
  assert.ok(h.events.some(event=>event.channel==='player:update'));
  await h.api.deleteVideo(accepted.id); assert.equal(stopped,1);
  assert.equal(fs.existsSync(opened.filePath),false);
  assert.doesNotThrow(()=>callbacks.onProgress(accepted.id,{positionSeconds:48,watched:false}));
});

test('local access check works before authentication without saving or sending a token',async t=>{
  const fixture=await plexFixture(t),h=await harnessFor(t,{encryptionAvailable:false});
  const result=await h.api.requestPlexLocalAccess(fixture.baseUrl);
  assert.equal(result.status,'reachable');
  assert.equal(fixture.state.requests.length,0,'TCP probe sends no HTTP requests or credentials');
  assert.equal(fs.existsSync(path.join(h.dataDir,'plex-connection.json')),false);
  await assert.rejects(()=>h.api.requestPlexLocalAccess({baseUrl:fixture.baseUrl}),/server address/);
  await assert.rejects(()=>h.api.requestPlexLocalAccess('http://8.8.8.8:32400'),/local network/);
  assert.equal((await h.api.getPlexConfig()).platform,process.platform);
});

test('local access can check the saved server without unlocking stored credentials',async t=>{
  const fixture=await plexFixture(t),h=await harnessFor(t,{encryptionAvailable:false,seed:{
    'plex-connection.json':{baseUrl:fixture.baseUrl,serverId:'saved',serverName:'Saved server',encryptedToken:'unreadable-without-keychain'}
  }});
  const result=await h.api.requestPlexLocalAccess();
  assert.equal(result.status,'reachable');
  assert.equal(fixture.state.requests.length,0);
  assert.equal(h.read('plex-connection.json').encryptedToken,'unreadable-without-keychain');
});

test('local access checks reject overlap, abort on quit, and open only the fixed Settings destination',async t=>{
  let attempts=0;
  const h=await harnessFor(t,{localAccessRequest:(_url,{signal})=>{
    attempts++;
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}));
  }});
  const pending=h.api.requestPlexLocalAccess('http://192.168.1.10:32400');
  pending.catch(()=>{});
  await assert.rejects(()=>h.api.requestPlexLocalAccess('http://192.168.1.10:32400'),/already running/);
  assert.equal(attempts,1);
  h.app.emit('before-quit');
  await assert.rejects(pending,/Aborted/);
  if(process.platform==='darwin') {
    await h.invoke('plex:open-local-settings','https://untrusted.example');
    assert.deepEqual(h.externalUrls,['x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork']);
  } else await assert.rejects(()=>h.api.openLocalNetworkSettings(),/macOS/);
});
