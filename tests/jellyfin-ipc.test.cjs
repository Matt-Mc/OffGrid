const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, eventually } = require('./backend-harness.cjs');

const token = 'fixture-jellyfin-token-not-for-logs';
const password = 'fixture-jellyfin-password-not-for-storage';
const userId = 'cccccccccccccccccccccccccccccccc';
const movieId = '00000000000000000000000000000042';
const secondMovieId = '00000000000000000000000000000043';
const libraryId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function jellyfinFixture(t) {
  const state = {serverId:'fixture-jellyfin-server',size:128,hold:false,requests:[],streams:0};
  const server = http.createServer(async (req,res)=>{
    const url = new URL(req.url,'http://fixture.invalid');
    const authorization = req.headers.authorization || req.headers['x-emby-authorization'] || '';
    state.requests.push({url:req.url,method:req.method,authorization});
    const json = (data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(url.pathname==='/Users/AuthenticateByName' && req.method==='POST') {
      let body=''; for await (const chunk of req) body+=chunk;
      const credentials=JSON.parse(body);
      if(credentials.Username!=='fixture-user' || credentials.Pw!==password) return json({Message:'Invalid credentials'},401);
      return json({AccessToken:token,ServerId:state.serverId,User:{Id:userId,Name:'Fixture user',Policy:{EnableMediaPlayback:true,EnableContentDownloading:true}}});
    }
    if(url.pathname==='/System/Info/Public') return json({Id:state.serverId,ServerName:'Fixture Jellyfin',Version:'10.11.0'});
    if(!authorization.includes(`Token="${token}"`) && req.headers['x-emby-token']!==token) return json({Message:'Unauthorized'},401);
    if(url.pathname===`/Users/${userId}` || url.pathname==='/Users/Me') return json({Id:userId,Name:'Fixture user',Policy:{EnableMediaPlayback:true,EnableContentDownloading:true}});
    if(url.pathname===`/Users/${userId}/Views`) return json({Items:[{Id:libraryId,Name:'Movies',CollectionType:'movies',Type:'CollectionFolder'}],TotalRecordCount:1,StartIndex:0});
    const downloadMatch=url.pathname.match(/^\/Items\/([a-f0-9]+)\/Download$/);
    if(downloadMatch) {
      state.streams++;
      res.writeHead(200,{'Content-Length':state.size,'Content-Type':'video/x-matroska'});
      if(state.hold) {res.write(Buffer.alloc(Math.min(32,state.size)));return;}
      return res.end(Buffer.alloc(state.size,42));
    }
    const item=id=>({Id:id,Name:`Jellyfin film ${id}`,Type:'Movie',MediaType:'Video',RunTimeTicks:1_200_000_000,CanDownload:true,Path:'/media/private-file.mkv',
      MediaSources:[{Id:`source-${id}`,Type:'Default',Protocol:'File',Container:'mkv',Size:state.size,SupportsDirectPlay:true,SupportsDirectStream:true,Path:'/media/private-file.mkv'}]});
    const metadataMatch=url.pathname.match(new RegExp(`^/Users/${userId}/Items/([a-f0-9]+)$`));
    if(metadataMatch) return json(item(metadataMatch[1]));
    if(url.pathname===`/Users/${userId}/Items` || url.pathname==='/Items') return json({Items:[item(movieId)],TotalRecordCount:1,StartIndex:0});
    return json({Message:`Unexpected fixture endpoint ${url.pathname}`},404);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {state,baseUrl:`http://127.0.0.1:${server.address().port}`};
}

async function plexFixture(t) {
  const token='fixture-plex-independent-token';
  const server=http.createServer((req,res)=>{
    if(req.headers['x-plex-token']!==token) {res.writeHead(401);res.end();return;}
    const data=req.url==='/' ? {machineIdentifier:'fixture-plex-server',friendlyName:'Fixture Plex'} :
      {Metadata:[{ratingKey:'42',type:'movie',title:'Plex film',duration:120000,Media:[{container:'mkv',Part:[{key:'/library/parts/1/2/file.mkv',size:128}]}]}]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({MediaContainer:data}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {baseUrl:`http://127.0.0.1:${server.address().port}`,token};
}

async function harnessFor(t,options) {const h=await createHarness(options);t.after(()=>h.dispose());return h;}
async function connect(h,fixture) {return h.api.connectJellyfin({baseUrl:fixture.baseUrl,username:'fixture-user',password});}
async function jobState(h,id,status) {
  return eventually(async()=>{const job=(await h.api.listDownloads()).jobs.find(job=>job.id===id);return job?.status===status && job;},`Jellyfin job did not reach ${status}`);
}
function assertNoSecrets(value) {
  const serialized=JSON.stringify(value);
  assert.ok(!serialized.includes(token),'Jellyfin token is absent from public or persisted data');
  assert.ok(!serialized.includes(password),'Jellyfin password is absent from public or persisted data');
}

test('Jellyfin login stores only an encrypted token, survives restart and preserves credentials after failed reconnect',async t=>{
  const fixture=await jellyfinFixture(t);
  let h=await createHarness();t.after(()=>h.dispose());
  const status=await connect(h,fixture);
  assert.equal(status.configured,true);assert.equal(status.serverId,fixture.state.serverId);
  assertNoSecrets(status);
  const saved=h.read('jellyfin-connection.json');
  assert.ok(saved.encryptedToken);assertNoSecrets(saved);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(h.dataDir,'jellyfin-connection.json')).mode&0o777,0o600);
  const directory=h.dataDir;
  await h.dispose({remove:false});h=await createHarness({directory});
  assert.equal((await h.api.getJellyfinConfig()).configured,true);
  const sections=await h.api.jellyfinSections();
  assert.equal(sections[0].title,'Movies');assertNoSecrets(sections);
  const page=await h.api.browseJellyfin({sectionId:sections[0].id});
  assert.equal(page.items[0].id,movieId);assert.equal(page.items[0].downloadable,true);
  assertNoSecrets(page);assert.ok(!JSON.stringify(page).includes('/media/private-file.mkv'));
  await assert.rejects(()=>h.api.connectJellyfin({baseUrl:fixture.baseUrl,username:'fixture-user',password:'wrong-password'}),/authentication|username|password|sign in/i);
  assert.equal((await h.api.jellyfinSections()).length,1);
  assert.equal(h.read('jellyfin-connection.json').encryptedToken,saved.encryptedToken,'failed reconnection preserves saved credentials');
  assert.ok(fixture.state.requests.every(req=>!req.url.includes(token) && !req.url.includes(password)));
  assertNoSecrets(h.events);
});

test('Jellyfin rejects unavailable keychain before sending login credentials',async t=>{
  const fixture=await jellyfinFixture(t),h=await harnessFor(t,{encryptionAvailable:false});
  await assert.rejects(()=>connect(h,fixture),/keychain/);
  assert.equal(fixture.state.requests.length,0);
  assert.equal(fs.existsSync(path.join(h.dataDir,'jellyfin-connection.json')),false);
});

test('paused Jellyfin downloads survive restart and resume offline with encrypted saved credentials',async t=>{
  const fixture=await jellyfinFixture(t);
  let h=await createHarness();t.after(()=>h.dispose());
  await connect(h,fixture);await h.api.setQueuePaused(true);
  const accepted=await h.api.downloadJellyfin(movieId);
  assert.equal((await h.api.downloadJellyfin(movieId)).id,accepted.id,'queued original downloads are deduplicated');
  const directory=h.dataDir;
  await h.dispose({remove:false});h=await createHarness({directory});h.setOnline(false);
  assert.equal((await h.api.listDownloads()).paused,true);
  const queued=await jobState(h,accepted.id,'queued');
  assert.equal(queued.provider,'jellyfin');assert.equal(queued.quality,'original');
  await h.api.setQueuePaused(false);await jobState(h,accepted.id,'complete');
  assert.equal(fixture.state.requests.filter(request=>request.url==='/Users/AuthenticateByName').length,1,'restart reuses the stored access token without a password');
  assertNoSecrets(h.read('downloads.json'));
});

test('Jellyfin saves original MKV while offline, never exposes credentials, and retains media after disconnect',async t=>{
  const fixture=await jellyfinFixture(t),h=await harnessFor(t);
  await connect(h,fixture);h.setOnline(false);
  const accepted=await h.api.downloadJellyfin(movieId);
  const completed=await jobState(h,accepted.id,'complete');
  const [video]=await h.api.listVideos();
  assert.equal(video.provider,'jellyfin');assert.equal(video.sourceId,`jellyfin:${fixture.state.serverId}:${movieId}`);
  assert.equal(path.extname(video.filePath),'.mkv');assert.equal(video.duration,120);assert.equal(video.sizeBytes,128);
  assert.equal(completed.quality,'original');assert.equal(h.calls.length,0,'original file download needs no yt-dlp or FFmpeg');
  assert.deepEqual(fs.readFileSync(video.filePath),Buffer.alloc(128,42));
  assertNoSecrets([video,completed,h.events,h.read('downloads.json'),h.read('library.json')]);
  assert.equal((await h.api.downloadJellyfin(movieId)).alreadySaved,true);
  await h.api.disconnectJellyfin();
  assert.equal((await h.api.getJellyfinConfig()).configured,false);
  assert.equal(fs.existsSync(path.join(h.dataDir,'jellyfin-connection.json')),false);
  assert.equal(fs.existsSync(video.filePath),true);
});

test('Jellyfin reserves original size and holds new work before transfer at the storage cap',async t=>{
  const fixture=await jellyfinFixture(t),h=await harnessFor(t);
  await connect(h,fixture);fixture.state.size=1_000_000;
  await h.api.updateSettings({maxLibraryBytes:17_100_000});
  const fits=await h.api.downloadJellyfin(movieId);await jobState(h,fits.id,'complete');
  assert.equal(fixture.state.streams,1,'original-file reservation must not use the YouTube 3x workspace estimate');
  await h.api.updateSettings({maxLibraryBytes:1_000_001});
  const blocked=await h.api.downloadJellyfin(secondMovieId);await jobState(h,blocked.id,'waiting-storage');
  assert.equal(fixture.state.streams,1);assert.equal((await h.api.listVideos()).length,1);
});

test('Jellyfin cancellation removes partials and retry only accepts original quality',async t=>{
  const fixture=await jellyfinFixture(t),h=await harnessFor(t);
  await connect(h,fixture);fixture.state.hold=true;
  const accepted=await h.api.downloadJellyfin(movieId);await jobState(h,accepted.id,'downloading');
  await eventually(()=>fixture.state.streams===1);
  await h.api.cancelDownload(accepted.id);await jobState(h,accepted.id,'canceled');
  assert.equal((await h.api.getStorage()).temporaryBytes,0);
  await assert.rejects(()=>h.api.retryDownload(accepted.id,{quality:'720p'}),/original quality/);
  fixture.state.hold=false;
  await h.api.retryDownload(accepted.id);await jobState(h,accepted.id,'complete');
  assert.equal((await h.api.listDownloads()).jobs.length,1);
});

test('Jellyfin verifies queued server identity before transferring media bytes',async t=>{
  const fixture=await jellyfinFixture(t),h=await harnessFor(t);
  await connect(h,fixture);await h.api.setQueuePaused(true);
  const accepted=await h.api.downloadJellyfin(movieId);fixture.state.serverId='different-jellyfin-server';
  await h.api.setQueuePaused(false);
  const failed=await jobState(h,accepted.id,'error');
  assert.match(failed.error,/different Jellyfin server/);assert.equal(fixture.state.streams,0);
});

test('disconnecting Jellyfin cancels its work and preserves independently configured Plex and YouTube jobs',async t=>{
  const fixture=await jellyfinFixture(t),plex=await plexFixture(t),h=await harnessFor(t);
  await connect(h,fixture);await h.api.connectPlex(plex);fixture.state.hold=true;
  const active=await h.api.downloadJellyfin(movieId);await jobState(h,active.id,'downloading');
  await h.api.setQueuePaused(true);
  const pending=await h.api.downloadJellyfin(secondMovieId);
  const plexJob=await h.api.downloadPlex('42');
  const youtube=await h.api.startDownload('https://youtu.be/independently-preserved');
  await h.api.disconnectJellyfin();
  await jobState(h,active.id,'canceled');await jobState(h,pending.id,'canceled');
  await jobState(h,plexJob.id,'queued');await jobState(h,youtube.id,'queued');
  assert.equal((await h.api.getPlexConfig()).configured,true);
  assert.equal((await h.api.getJellyfinConfig()).configured,false);
  assert.equal((await h.api.getStorage()).temporaryBytes,0);
});

test('Jellyfin local access probe works before login with no HTTP or credential storage',async t=>{
  const fixture=await jellyfinFixture(t),h=await harnessFor(t,{encryptionAvailable:false});
  assert.equal((await h.api.requestJellyfinLocalAccess(`${fixture.baseUrl}/jellyfin`)).status,'reachable');
  assert.equal(fixture.state.requests.length,0);
  assert.equal(fs.existsSync(path.join(h.dataDir,'jellyfin-connection.json')),false);
  await assert.rejects(()=>h.api.requestJellyfinLocalAccess({baseUrl:fixture.baseUrl}),/server address/);
  await assert.rejects(()=>h.api.requestJellyfinLocalAccess('http://8.8.8.8:8096'),/local network/);
  assert.equal((await h.api.getJellyfinConfig()).platform,process.platform);
});

test('Jellyfin local access probe can use the saved address without decrypting a token',async t=>{
  const fixture=await jellyfinFixture(t),h=await harnessFor(t,{encryptionAvailable:false,seed:{
    'jellyfin-connection.json':{baseUrl:fixture.baseUrl,serverId:fixture.state.serverId,serverName:'Fixture Jellyfin',userId,encryptedToken:'keychain-unavailable'}
  }});
  assert.equal((await h.api.requestJellyfinLocalAccess()).status,'reachable');
  assert.equal(fixture.state.requests.length,0);
  assert.equal(h.read('jellyfin-connection.json').encryptedToken,'keychain-unavailable');
});
