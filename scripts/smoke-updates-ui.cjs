// Renderer-only update fixtures. No network release requests, installer launches,
// or access to the user's library; backend behavior has separate tests.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-updates-ui-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function preloadFixture() {
  const {contextBridge}=require('electron');
  const listeners=new Set(), calls={download:0,cancel:0,check:0};
  let update={check:{state:'available',release:{version:'9.0.0'}},download:{state:'idle'}};
  const emit=value=>{update=value;listeners.forEach(listener=>listener(update));return update;};
  const api={
    listVideos:async()=>[],getSettings:async()=>({defaultQuality:'720p',saveComments:false,maxLibraryBytes:null,autoDownload:false,checkIntervalHours:6,recentVideoCount:3}),
    getStorage:async()=>({savedBytes:0,temporaryBytes:0,freeBytes:1e11,maxLibraryBytes:null}),listDownloads:async()=>({jobs:[],paused:false}),listSubscriptions:async()=>[],
    subscriptionSyncStatus:async()=>({status:'idle'}),toolStatus:async()=>({status:'ready'}),ffmpegStatus:async()=>({status:'ready'}),
    appVersion:async()=> '0.3.1',playerStatus:async()=>({available:true,source:'bundled'}),playerState:async()=>({status:'idle'}),
    getPlexConfig:async()=>({configured:false,platform:'darwin'}),getJellyfinConfig:async()=>({configured:false,platform:'darwin'}),
    appUpdateStatus:async()=>update,onAppUpdate:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    downloadAppUpdate:async()=>{calls.download++;return emit({...update,download:{state:'downloading',progress:0.42}});},
    cancelAppUpdate:async()=>{calls.cancel++;return emit({...update,download:{state:'idle'}});},
    checkAppUpdate:async()=>{calls.check++;return emit({check:{state:'up-to-date'},download:{state:'idle'}});},
  };
  for(const name of ['onQueueUpdate','onSettingsUpdate','onStorageUpdate','onLibraryUpdate','onSubscriptionUpdate','onSubscriptionSyncUpdate','onToolUpdate','onFfmpegUpdate','onSettingsOpen','onPlayerUpdate']) api[name]=()=>()=>{};
  contextBridge.exposeInMainWorld('offgrid',api);
  contextBridge.exposeInMainWorld('updateFixture',{set:emit,calls:()=>calls});
}

async function main() {
  const server=net.createServer().listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const preload=path.join(temporary,'preload.cjs'),launcher=path.join(temporary,'main.cjs');
  fs.writeFileSync(preload,`(${preloadFixture.toString()})();`);
  fs.writeFileSync(launcher,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temporary,'data'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1240,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(preload)}}});w.loadFile(${JSON.stringify(path.join(root,'dist/index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const proc=spawn(require('electron'),[launcher,`--remote-debugging-port=${port}`],{stdio:['ignore','pipe','pipe']});
  let output='',socket;
  proc.stdout.on('data',chunk=>output+=chunk);proc.stderr.on('data',chunk=>output+=chunk);
  try {
    let target;
    for(let i=0;i<100;i++) {try{target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(value=>value.type==='page');}catch{}if(target)break;if(proc.exitCode!==null)throw new Error(output);await sleep(100);}
    if(!target)throw new Error(`No fixture window: ${output}`);
    socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');
    let id=0;const pending=new Map(),exceptions=[];
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails);if(pending.has(message.id)){const [resolve,reject]=pending.get(message.id);pending.delete(message.id);message.error?reject(new Error(JSON.stringify(message.error))):resolve(message.result);}});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,[resolve,reject]);socket.send(JSON.stringify({id:next,method,params}));});
    const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await sleep(50);}throw new Error(`Condition failed: ${expression}`);};
    const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.offsetParent!==null&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.querySelector('span')?.textContent.trim()===${JSON.stringify(label)}));if(!b)throw new Error('Button missing');b.click();})()`);
    const set=state=>evaluate(`window.updateFixture.set(${JSON.stringify(state)})`);
    const available={check:{state:'available',release:{version:'9.0.0'}},download:{state:'idle'}};
    await call('Runtime.enable');
    await waitFor(`document.querySelector('.app-update-banner')?.textContent.includes('9.0.0')`);
    await click('Update to 9.0.0');await waitFor(`document.querySelector('.app-update-banner').textContent.includes('42%')`);
    assert.equal((await evaluate('window.updateFixture.calls()')).download,1);
    await click('Cancel download');await waitFor(`document.querySelector('.app-update-banner').textContent.includes('Update to 9.0.0')`);
    assert.equal((await evaluate('window.updateFixture.calls()')).cancel,1);
    await set({...available,download:{state:'error',message:'The update could not be verified. Please try downloading it again.'}});
    await waitFor(`document.querySelector('.app-update-banner').textContent.includes('could not be verified')`);
    await click('Update to 9.0.0');assert.equal((await evaluate('window.updateFixture.calls()')).download,2);
    await set({...available,download:{state:'ready',progress:1}});
    await waitFor(`document.querySelector('.app-update-banner').textContent.includes('Quit Offgrid')`);
    assert.equal(await evaluate(`document.querySelector('.app-update-banner').textContent.includes('Open installer')`),true);
    await set(available);
    const capture=async name=>{const result=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(temporary,name+'.png'),Buffer.from(result.data,'base64'));};
    await capture('update-available');
    await call('Emulation.setDeviceMetricsOverride',{width:820,height:760,deviceScaleFactor:1,mobile:false});
    await sleep(100);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.main-content').scrollWidth<=document.querySelector('.main-content').clientWidth`),true);
    await capture('update-narrow');
    await click('Remind me next time');await waitFor(`!document.querySelector('.app-update-banner')`);
    await click('Settings');await waitFor(`document.querySelector('section[aria-label="Settings"]:not([hidden])')?.textContent.includes('Update to 9.0.0')`);
    await set({check:{state:'unavailable'},download:{state:'idle'}});
    await evaluate(`Object.defineProperty(navigator,'onLine',{value:false,configurable:true});window.dispatchEvent(new Event('offline'));`);
    await waitFor(`document.querySelector('.offline-banner')`);
    assert.equal(await evaluate(`!!document.querySelector('.app-error')||!!document.querySelector('.app-update-banner')`),false);
    await evaluate(`(()=>{const row=[...document.querySelectorAll('.setting-row')].find(row=>row.querySelector('h3')?.textContent==='App updates');row.querySelector('button').click();})()`);
    await waitFor(`document.body.innerText.includes('You have the latest release.')`);
    assert.equal((await evaluate('window.updateFixture.calls()')).check,1);
    assert.deepEqual(exceptions,[]);
    console.log(JSON.stringify({ok:true,screenshots:temporary,checks:['update banner','download progress','cancel','verification error and retry','installer instructions','dismiss and Settings access','quiet offline failure','manual check','820px layout','no renderer exceptions']},null,2));
  } finally {socket?.close();proc.kill();await Promise.race([once(proc,'exit'),sleep(3000)]);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
