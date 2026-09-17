// Renderer contract smoke test. Uses a disposable Electron app with explicit IPC fixtures.
// Complements real backend/provider tests; does not claim to exercise a live media server.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const net = require('node:net');
const root = path.resolve(__dirname,'..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-features-ui-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
function preloadFixture(){
  const {contextBridge} = require('electron');
  const listeners = {};
  const calls = [];
  const heldSeasons=new Map();let holdNextSeason=false;
  const settings = {version:1,defaultQuality:'720p',saveComments:false,maxLibraryBytes:null,autoDownload:false,checkIntervalHours:6,recentVideoCount:3,defaultSubtitleLanguage:'en',allowAutoCaptions:false};
  let captures = {items:[]};
  const queue = {paused:false,warning:null,jobs:[{id:'paused',title:'A journey to finish',status:'paused',quality:'720p',retainedBytes:12000000,resumable:true,progress:40}]};
  const videos = [{id:'saved',title:'Saved with subtitles',channel:'Offgrid fixture',duration:120,sizeBytes:20000000,assets:[{id:'vtt',kind:'subtitle',language:'en',format:'vtt'}],assetWarnings:['French subtitles were unavailable.'],savedAt:new Date().toISOString(),comments:[]}];
  const emit = (name,value) => listeners[name]?.(structuredClone(value));
  const api = {
    listVideos:async()=>videos,getSettings:async()=>settings,getStorage:async()=>({savedBytes:20000000,temporaryBytes:12000000,freeBytes:50000000000,queueProjection:{additionalPeakBytes:120000000,unknownCount:0,fits:false}}),listDownloads:async()=>queue,
    listSubscriptions:async()=>[],subscriptionSyncStatus:async()=>({status:'idle'}),toolStatus:async()=>({status:'ready'}),ffmpegStatus:async()=>({status:'ready'}),appVersion:async()=>'fixture',playerStatus:async()=>({available:false}),
    updateSettings:async patch=>{Object.assign(settings,patch);emit('Settings',settings);return settings;},
    estimateDownload:async()=>({title:'Draft video',duration:120,expectedBytes:12000000}),
    startDownload:async(...args)=>{calls.push(['single',...args]);return {accepted:true};},
    previewDownloads:async args=>{calls.push(['preview',args]);if(args.mode==='playlist') {
      const a={id:'pa',url:'https://youtube.com/watch?v=aaaaaaaaaaa',title:'Playlist first',available:true,expectedBytes:100};
      const b={id:'pb',url:'https://youtube.com/watch?v=bbbbbbbbbbb',title:'Playlist second',available:true,expectedBytes:200};
      const c={id:'pc',url:'https://youtube.com/watch?v=ccccccccccc',title:'Playlist third',available:true,expectedBytes:null};
      return {items:args.start===0?[a,a,b]:args.start===100?[b,c]:[],start:args.start,nextStart:args.start+100,total:201,complete:args.start>=200,hasMore:args.start<200};
    }return {items:[{id:'a',url:'https://youtube.com/watch?v=aaaaaaaaaaa',title:'First selected video',duration:90,expectedBytes:12000000,available:true},{id:'b',url:'https://youtube.com/watch?v=bbbbbbbbbbb',title:'Already in the library',available:true,outcome:'alreadySaved'},{id:'c',title:'Private video',available:false,reason:'Unavailable'}],total:3,complete:true,hasMore:false};},
    cancelPreview:async id=>{calls.push(['cancelPreview',id]);if(heldSeasons.has(id)){heldSeasons.get(id)(new Error('Preview canceled'));heldSeasons.delete(id);}},addDownloadBatch:async args=>{calls.push(['batch',args]);if(args.urls.length>1)return{results:[{outcome:'added',title:'Playlist first'},{outcome:'rejected',title:'Playlist second',reason:'Video became unavailable'},{outcome:'alreadyQueued',title:'Playlist third'}],counts:{added:1,rejected:1,alreadyQueued:1}};return {results:[{outcome:'added'}],counts:{added:1,alreadyQueued:0,alreadySaved:0,rejected:0}};},
    pauseDownload:async id=>{calls.push(['pause',id]);queue.jobs[0].status='paused';emit('Queue',queue);},
    resumeDownload:async id=>{calls.push(['resume',id]);queue.jobs[0].status='downloading';emit('Queue',queue);},
    retryDownload:async(...args)=>{calls.push(['retry',...args]);},cancelDownload:async id=>{calls.push(['cancel',id]);queue.jobs[0].status='canceled';queue.jobs[0].retainedBytes=0;emit('Queue',queue);},
    setQueuePaused:async value=>{queue.paused=value;emit('Queue',queue);},
    listCaptures:async()=>captures,acknowledgeCapture:async id=>{captures.items=captures.items.filter(item=>item.id!==id);emit('Captures',captures);},
    retrySubtitles:async id=>{calls.push(['subtitles',id]);videos[0].assetWarnings=[];emit('Library',videos);},
    videoUrl:()=>'',thumbnailUrl:()=>'',subtitleUrl:()=>'',savePlayback:async()=>{},
    getPlexConfig:async()=>({configured:true,serverName:'Home server',baseUrl:'http://127.0.0.1:32400'}),plexSections:async()=>[{id:'tv',title:'TV shows'},{id:'movies',title:'Movies'}],
    browsePlex:async args=>args.sectionId==='movies'?({items:Array.from({length:101},(_,index)=>({id:`movie-${index}`,title:`Movie ${index+1}`,type:'movie',downloadable:true,sizeBytes:1000})).slice(args.start || 0,(args.start || 0)+100),total:101}):({items:args.parentId ? [{id:'ep',title:'First episode',type:'episode',downloadable:true,episode:1,duration:100}] : [{id:'season',type:'season',title:'Season 1'}],total:1}),
    previewServerSeason:async(provider,id,requestId)=>{if(holdNextSeason){holdNextSeason=false;return new Promise((resolve,reject)=>heldSeasons.set(requestId,reject));}return({items:[{id:'ep',title:'First episode',available:true,episode:1,duration:100,sizeBytes:50000000}],total:1,complete:true});},
    downloadServerBatch:async(provider,args)=>{calls.push(['serverBatch',provider,args]);if(args.ids.length===101)return{results:args.ids.map((id,index)=>index===100?{outcome:'rejected',title:'Movie 101',reason:'Permission changed while adding'}:{outcome:'added',title:id}),counts:{added:100,rejected:1}};return {results:args.ids.map(()=>({outcome:'added'})),counts:{added:args.ids.length}};},
    serverSubtitleTracks:async()=>[{id:'s',language:'en',format:'srt',origin:'external'}],
  };
  for(const name of ['Queue','Settings','Storage','Library','Subscription','SubscriptionSync','Tool','Ffmpeg','SettingsOpen','Captures']) api[`on${name}${name==='SettingsOpen'?'':'Update'}`]=callback=>{listeners[name]=callback;return()=>delete listeners[name];};
  contextBridge.exposeInMainWorld('offgrid',api);
  contextBridge.exposeInMainWorld('fixture',{calls:()=>calls,holdSeason:()=>{holdNextSeason=true;},capture:()=>{captures={items:[{id:'capture',url:'https://youtube.com/watch?v=ccccccccccc'}]};emit('Captures',captures);}});
}
fs.writeFileSync(path.join(temporary,'preload.cjs'),`(${preloadFixture.toString()})();`);
fs.writeFileSync(path.join(temporary,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temporary,'data'))});app.whenReady().then(()=>{new BrowserWindow({width:1240,height:900,webPreferences:{preload:${JSON.stringify(path.join(temporary,'preload.cjs'))},contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(root,'dist/index.html'))});});app.on('window-all-closed',()=>app.quit());`);
async function main(){
  const portServer = net.createServer().listen(0,'127.0.0.1');await once(portServer,'listening');const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  const proc=spawn(require('electron'),[path.join(temporary,'main.cjs'),`--remote-debugging-port=${port}`],{env:{...process.env,OFFGRID_TEST_MODE:'1'},stdio:['ignore','pipe','pipe']});
  let output='';proc.stderr.on('data',chunk=>output+=chunk);let socket;
  try {
    let target;for(let i=0;i<100;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item=>item.type==='page');}catch{}if(target)break;if(proc.exitCode!==null)throw new Error(output);await sleep(100);}if(!target)throw new Error(output);
    socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');const pending=new Map();let next=0;const exceptions=[];
    socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.method==='Runtime.exceptionThrown')exceptions.push(value.params.exceptionDetails);if(value.id&&pending.has(value.id)){pending.get(value.id)(value);pending.delete(value.id);}});
    const call=(method,params={})=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const value=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(value.error||value.result.exceptionDetails)throw new Error(JSON.stringify(value));return value.result.result?.value;};
    const waitFor=async expression=>{for(let i=0;i<60;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error(`Timed out: ${expression}`);};
    const click=async label=>{assert(await evaluate(`(()=>{const el=[...document.querySelectorAll('button')].find(el=>el.checkVisibility() && (el.textContent.trim()===${JSON.stringify(label)} || el.classList.contains('nav-item')&&el.querySelector('span')?.textContent===${JSON.stringify(label)}));if(!el || el.disabled)return false;el.click();return true;})()`),`Clickable ${label}`);await sleep(120);};
    const set=async(selector,value)=>{await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const prototype=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);await sleep(100);};
    await call('Runtime.enable');await waitFor(`document.body.innerText.includes('Saved with subtitles')`);
    await click('Retry subtitles');assert((await evaluate('window.fixture.calls()')).some(call=>call[0]==='subtitles'));
    await click('Downloads');await waitFor(`document.body.innerText.includes('Some downloads will wait for more storage.')`);await set('input[type=url]','https://youtube.com/watch?v=ddddddddddd');await evaluate('window.fixture.capture()');await sleep(100);
    assert.equal(await evaluate(`document.querySelector('input[type=url]').value`),'https://youtube.com/watch?v=ddddddddddd');assert(await evaluate(`[...document.querySelectorAll('.capture-item button')].find(el=>el.textContent==='Open').disabled`));
    await click('Clear draft');await click('Open');assert.equal(await evaluate(`document.querySelector('input[type=url]').value`),'https://youtube.com/watch?v=ccccccccccc');
    await set('.download-form select','480p');await evaluate(`document.querySelector('.composer-options').open=true`);await set('.download-composer select[aria-label="Subtitle language"]','fr');await evaluate(`document.querySelector('.download-composer .inline-check input').click()`);await sleep(100);
    await call('Page.reload');await waitFor(`document.body?.innerText.includes('Saved with subtitles')`);await click('Downloads');assert.equal(await evaluate(`document.querySelector('input[type=url]').value`),'https://youtube.com/watch?v=ccccccccccc');assert.equal(await evaluate(`document.querySelector('.download-form select').value`),'480p');assert.equal(await evaluate(`document.querySelector('.download-composer select[aria-label="Subtitle language"]').value`),'fr');assert.equal(await evaluate(`document.querySelector('.download-composer .inline-check input').checked`),true);assert.equal(await evaluate(`document.querySelectorAll('.batch-preview').length`),0);
    await click('Resume');await click('Pause');await click('Discard…');await click('Keep progress');assert(!(await evaluate('window.fixture.calls()')).some(call=>call[0]==='cancel'));
    await set('select[aria-label="Link type"]','links');await set('textarea','https://youtube.com/watch?v=aaaaaaaaaaa\nhttps://youtube.com/watch?v=bbbbbbbbbbb');await click('Preview videos');await waitFor(`document.body.innerText.includes('First selected video')`);
    assert.equal(await evaluate(`document.querySelectorAll('.batch-item input:disabled').length`),2);await evaluate(`[...document.querySelectorAll('.batch-toolbar input')].find(el=>el.checkVisibility()).click()`);await sleep(100);await click('Add 1 to queue');await waitFor(`document.body.innerText.includes('1 added')`);
    await set('select[aria-label="Link type"]','playlist');await set('input[type=url]','https://youtube.com/playlist?list=PL_fixture');await click('Preview videos');await waitFor(`document.body.innerText.includes('Playlist first')`);
    assert.equal(await evaluate(`document.querySelectorAll('.batch-item').length`),2);await click('Load more');await waitFor(`document.body.innerText.includes('Playlist third')`);assert.equal(await evaluate(`document.querySelectorAll('.batch-item').length`),3);await click('Load more');
    const playlistStarts=(await evaluate('window.fixture.calls()')).filter(call=>call[0]==='preview'&&call[1].mode==='playlist').map(call=>call[1].start);assert.deepEqual(playlistStarts,[0,100,200]);assert.equal(await evaluate(`document.querySelectorAll('.batch-item').length`),3);
    await evaluate(`[...document.querySelectorAll('.batch-toolbar input')].find(el=>el.checkVisibility()).click()`);await sleep(100);await click('Add 3 to queue');await click('Close preview');await evaluate(`document.querySelector('.batch-results').open=true`);assert(await evaluate(`document.body.innerText.includes('Video became unavailable')`));
    await click('Servers');await waitFor(`document.body.innerText.includes('Season 1')`);await evaluate('window.fixture.holdSeason()');await click('Download season…');await click('Cancel preview');assert((await evaluate('window.fixture.calls()')).some(call=>call[0]==='cancelPreview'&&typeof call[1]==='string'));await click('Download season…');await waitFor(`document.body.innerText.includes('Choose episodes')`);
    await evaluate(`document.querySelector('.server-download-options').open=true`);await set('select[aria-label="Server download quality"]','720p');await evaluate(`[...document.querySelectorAll('.batch-toolbar input')].find(el=>el.checkVisibility()).click()`);await sleep(100);await click('Add 1 to queue');
    const serverCall=(await evaluate('window.fixture.calls()')).find(call=>call[0]==='serverBatch');assert.equal(serverCall[2].copyQuality,'720p');assert.deepEqual(serverCall[2].ids,['ep']);
    await set('select[aria-label="Plex library"]','movies');await waitFor(`document.body.innerText.includes('Movie 100')`);await evaluate(`document.querySelector('.server-selection input').click()`);await sleep(100);await click('Next');await waitFor(`document.body.innerText.includes('Movie 101')`);assert(await evaluate(`document.body.innerText.includes('100 selected across pages')`));await evaluate(`document.querySelector('input[aria-label="Select Movie 101"]').click()`);await sleep(100);await click('Review 101 selected');await click('Add 101 to queue');
    const pageBatch=(await evaluate('window.fixture.calls()')).filter(call=>call[0]==='serverBatch').at(-1);assert.equal(pageBatch[2].ids.length,101);assert.equal(new Set(pageBatch[2].ids).size,101);assert.equal(pageBatch[2].copyQuality,'720p');
    await click('Close preview');await evaluate(`[...document.querySelectorAll('.batch-results')].find(el=>el.checkVisibility()).open=true`);assert(await evaluate(`document.body.innerText.includes('Permission changed while adding')`));
    await click('Settings');await waitFor(`document.body.innerText.includes('Default subtitles')`);await evaluate(`document.querySelector('.incomplete-downloads').open=true`);await click('Discard…');await click('Discard download');assert((await evaluate('window.fixture.calls()')).some(call=>call[0]==='cancel'));
    await click('Downloads');const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(temporary,'downloads.png'),Buffer.from(screenshot.result.data,'base64'));
    assert.deepEqual(exceptions,[]);console.log(`PASS capture drafts and restart options, batch selection/outcomes, pause/resume/discard, season and cross-page selection, smaller-copy options, duplicate playlist cursor, queue space, subtitle retry, cleanup. Screenshot: ${temporary}/downloads.png`);
  }finally{socket?.close();proc.kill('SIGTERM');await Promise.race([once(proc,'exit'),sleep(2000)]);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
