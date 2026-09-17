// Exercise the packaged executable with disposable data and local CDP only.
// This does not register or invoke a global URL scheme, or contact YouTube.
// Usage: OFFGRID_SMOKE_APP=/path/to/Offgrid.app node scripts/smoke-packaged-capture.cjs
'use strict';

const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');

const root=path.resolve(__dirname,'..');
const application=path.resolve(process.env.OFFGRID_SMOKE_APP || path.join(root,'release/mac-arm64/Offgrid.app'));
const executable=application.endsWith('.app') ? path.join(application,'Contents/MacOS/Offgrid') : application;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const capture=url=>`offgrid://add?url=${encodeURIComponent(url)}`;
const firstUrl='https://www.youtube.com/watch?v=packaged_first&list=PLpackaged';
const secondUrl='https://www.youtube.com/watch?v=packaged_second';
const typedDraft='https://www.youtube.com/watch?v=packaged_unsent_draft';

async function availablePort() {
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
function connectSocket(url) {
  const socket=new WebSocket(url),pending=new Map(),exceptions=[];
  let sequence=0;
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const task=pending.get(message.id);
    if(task) {pending.delete(message.id);clearTimeout(task.timer);message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);}
  });
  socket.addEventListener('close',()=>{
    for(const task of pending.values()) {clearTimeout(task.timer);task.reject(new Error('The packaged renderer closed.'));}
    pending.clear();
  });
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timed out: ${method}`));},10000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{
    const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
    if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const until=async(expression,message=expression)=>{
    for(let attempt=0;attempt<100;attempt++) {
      if(await evaluate(`(async()=>Boolean(await (${expression})))()`)) return;
      await wait(100);
    }
    throw new Error(`Packaged capture check timed out: ${message}`);
  };
  return {socket,call,evaluate,until,exceptions};
}

async function main() {
  if(!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}. Build the app or set OFFGRID_SMOKE_APP.`);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-packaged-capture-'));
  const screenshots=path.join(directory,'screenshots');fs.mkdirSync(screenshots);
  const env={...process.env,OFFGRID_DATA_DIR:directory,OFFGRID_TEST_MODE:'1',
    OFFGRID_YTDLP_PATH:path.join(directory,'disabled-test-downloader'),OFFGRID_FFMPEG_PATH:path.join(directory,'disabled-test-ffmpeg')};
  delete env.ELECTRON_RUN_AS_NODE;
  fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({version:1,defaultQuality:'720p',saveComments:false,maxLibraryBytes:null,
    autoDownload:false,checkIntervalHours:0,recentVideoCount:3,defaultSubtitleLanguage:'',allowAutoCaptions:false}));
  fs.writeFileSync(path.join(directory,'downloads.json'),JSON.stringify({version:2,paused:true,jobs:[]}));
  fs.writeFileSync(path.join(directory,'library.json'),'[]');fs.writeFileSync(path.join(directory,'subscriptions.json'),'[]');
  console.log(`Isolated packaged capture fixture: ${directory}`);
  const processes=new Set();let session;
  function launch(args) {
    const child=spawn(executable,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
    const processState={child,output:'',error:null};processes.add(processState);
    child.on('error',error=>{processState.error=error;});
    child.stdout.on('data',chunk=>{processState.output=(processState.output+chunk.toString()).slice(-30000);});
    child.stderr.on('data',chunk=>{processState.output=(processState.output+chunk.toString()).slice(-30000);});
    child.once('exit',()=>processes.delete(processState));return processState;
  }
  async function exited(state,timeout=10000) {
    const deadline=Date.now()+timeout;
    while(state.child.exitCode===null && state.child.signalCode===null && !state.error && Date.now()<deadline) await wait(50);
    if(state.error) throw state.error;
    if(state.child.exitCode===null && state.child.signalCode===null) throw new Error(`Packaged process did not exit after ${timeout}ms.\n${state.output}`);
  }
  async function start(uri) {
    const port=await availablePort();
    const processState=launch([`--remote-debugging-address=127.0.0.1`,`--remote-debugging-port=${port}`,'--disable-background-networking',...(uri?[uri]:[])]);
    let target;
    for(let attempt=0;attempt<150;attempt++) {
      if(processState.error) throw processState.error;
      if(processState.child.exitCode!==null || processState.child.signalCode!==null) throw new Error(`Packaged app exited during startup.\n${processState.output}`);
      try {
        target=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(500)})).json()).find(item=>item.type==='page' && item.url.startsWith('file:'));
      }catch{}
      if(target) break;await wait(100);
    }
    if(!target) throw new Error(`Packaged renderer/CDP did not appear.\n${processState.output}`);
    const browser=connectSocket(target.webSocketDebuggerUrl);await once(browser.socket,'open',{signal:AbortSignal.timeout(5000)});await browser.call('Runtime.enable');
    await browser.until(`window.offgrid?.listCaptures && document.querySelector('.nav-item')`,'preload and renderer readiness');
    const storage=await browser.evaluate('window.offgrid.getStorage()');assert.equal(storage.libraryPath,directory,'Only disposable app data is used');
    await browser.evaluate(`(()=>{const button=[...document.querySelectorAll('button.nav-item')].find(item=>item.querySelector('span')?.textContent.trim()==='Downloads');if(!button) throw new Error('Downloads navigation is missing');button.click();})()`);
    await browser.until(`document.querySelector('.download-composer input[type="url"]')`,'Downloads composer');
    return {...browser,processState};
  }
  async function stop(current) {
    if(!current) return;
    assert.equal(current.exceptions.length,0,`No renderer exceptions: ${JSON.stringify(current.exceptions)}`);
    current.socket.close();current.processState.child.kill('SIGTERM');await exited(current.processState);
    assert.equal(current.processState.child.exitCode,0,'The isolated app drains and exits cleanly');
  }
  async function warm(uri) {
    const second=launch([uri]);await exited(second,10000);
    assert.equal(second.child.exitCode,0,`The second instance hands off and exits.\n${second.output}`);
  }
  async function screenshot(name) {
    const image=await session.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(screenshots,`${name}.png`),Buffer.from(image.data,'base64'));
  }
  const inputValue=`document.querySelector('.download-composer input[type="url"]')?.value`;
  const noQueue=async()=>assert.equal((await session.evaluate('window.offgrid.listDownloads()')).jobs.length,0,'Capturing/editing drafts never enqueues media');
  try {
    session=await start(capture(firstUrl));
    await session.until(`window.offgrid.listCaptures().then(value=>value.items.length===1)`,'cold argv capture');
    await session.until(`document.querySelector('.capture-inbox')?.textContent.includes('packaged_first')`,'capture rendered in inbox');
    await noQueue();await screenshot('cold-capture');
    await session.evaluate(`(()=>{const input=document.querySelector('.download-composer input[type="url"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(typedDraft)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await session.until(`${inputValue}===${JSON.stringify(typedDraft)}`,'typed draft');
    await warm(capture(secondUrl));
    await wait(150);
    await session.until(`window.offgrid.listCaptures().then(value=>value.items.length===2)`,'warm second-instance capture');
    assert.equal(await session.evaluate(inputValue),typedDraft,'A warm capture preserves the current draft');
    assert.equal(await session.evaluate(`[...document.querySelectorAll('.capture-item button')].filter(button=>button.textContent==='Open').every(button=>button.disabled)`),true,'New captures cannot replace an unfinished draft');
    await warm(capture(secondUrl));
    assert.equal((await session.evaluate('window.offgrid.listCaptures()')).items.length,2,'Repeated warm delivery is deduplicated');
    await noQueue();await screenshot('warm-capture-with-draft');
    await wait(300);await stop(session);session=null;

    session=await start();
    await session.until(`${inputValue}===${JSON.stringify(typedDraft)}`,'typed draft restored after restart');
    assert.equal((await session.evaluate('window.offgrid.listCaptures()')).items.length,2,'Pending captures survive app restart');
    await noQueue();await screenshot('restored-draft-and-captures');
    await session.evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent==='Clear draft');if(!button) throw new Error('Clear draft action is missing');button.click();})()`);
    await session.until(`${inputValue}===''`,'draft cleared explicitly');
    await session.evaluate(`(()=>{const row=[...document.querySelectorAll('.capture-item')].find(item=>item.textContent.includes('packaged_first'));const button=[...row.querySelectorAll('button')].find(item=>item.textContent==='Open');button.click();})()`);
    await session.until(`${inputValue}===${JSON.stringify(firstUrl)}`,'opened capture becomes draft');
    await session.until(`window.offgrid.listCaptures().then(value=>value.items.length===1)`,'opened capture acknowledged');
    await noQueue();await wait(300);await stop(session);session=null;

    session=await start();
    await session.until(`${inputValue}===${JSON.stringify(firstUrl)}`,'opened captured draft survives restart');
    const pending=await session.evaluate('window.offgrid.listCaptures()');assert.deepEqual(pending.items.map(item=>item.url),[secondUrl]);
    await noQueue();await screenshot('restored-opened-capture');
    const report={ok:true,executable,fixtureDirectory:directory,screenshots,
      checks:['Cold packaged argv capture','Warm second-instance handoff','Warm duplicate suppression','Draft preserved while new links arrive','Typed draft and pending captures survive restart','Opened captured draft survives restart','Capture and draft actions never enqueue media','No renderer exceptions'],
      boundary:'Packaged executable argv and Electron second-instance lifecycle only. Global URL registration, OS/browser handoff, and minimized-window behavior are not exercised.'};
    await stop(session);session=null;
    fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {
    session?.socket.close();
    for(const state of [...processes]) {
      state.child.kill('SIGTERM');
      try {await exited(state,10000);} catch {state.child.kill('SIGKILL');}
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
