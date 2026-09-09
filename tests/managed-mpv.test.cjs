const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createManagedMpv}=require('../electron/managed-mpv.cjs');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'offgrid-managed-mpv-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const archive=Buffer.from('archive fixture'),binary=Buffer.from('executable fixture');
  const runtime={version:'fixture',url:'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/test/mpv.7z',size:archive.length,sha256:hash(archive),files:{'mpv.exe':hash(binary)}};
  let fetched=0,extracted=0;
  const config={directory,runtime,fetch:async()=>{fetched++;return new Response(archive);},extract:async(_cmd,args,opts)=>{
    extracted++;assert.equal(opts.windowsHide,true);assert.deepEqual(args.slice(4),['mpv.exe']);await fs.writeFile(path.join(args[3],'mpv.exe'),binary);
  },...options};
  const manager=createManagedMpv(config);t.after(()=>manager.dispose());
  return {manager,config,directory,get fetched(){return fetched;},get extracted(){return extracted;}};
}
test('player setup coalesces callers, verifies extracted files, and survives restart without network',async t=>{
  const f=await fixture(t);
  const first=f.manager.ensure();assert.equal(first,f.manager.ensure());
  assert.equal((await first).available,true);assert.equal(f.fetched,1);assert.equal(f.extracted,1);
  const offline=createManagedMpv({...f.config,fetch:async()=>{throw new Error('offline');}});
  assert.equal((await offline.ensure()).available,true);
  await fs.appendFile(offline.status().path,'tampered');
  assert.equal((await offline.ensure()).available,false);await offline.dispose();
});
test('corrupt archives, foreign redirects and unexpected extracted bytes fail closed',async t=>{
  for(const options of [
    {fetch:async()=>new Response('corrupt')},
    {fetch:async()=>new Response(null,{status:302,headers:{location:'https://evil.example/player.7z'}})},
    {extract:async(_cmd,args)=>fs.writeFile(path.join(args[3],'mpv.exe'),'wrong binary')},
  ]) {
    const f=await fixture(t,options);assert.equal((await f.manager.ensure()).available,false);
    assert.deepEqual(await fs.readdir(f.directory),[]);
  }
});
test('quitting aborts setup and prevents later retries',async t=>{
  let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{fetch:async(_url,{signal})=>new Promise((_resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})});
  const pending=f.manager.ensure();await ready;await f.manager.dispose();
  assert.equal((await pending).available,false);assert.equal((await f.manager.ensure()).available,false);
  assert.deepEqual(await fs.readdir(f.directory),[]);
});
test('offline reuse accepts a legitimate alias in the parent directory',async t=>{
  const f=await fixture(t);assert.equal((await f.manager.ensure()).available,true);
  const alias=f.directory+'-alias';
  await fs.symlink(f.directory,alias,process.platform==='win32'?'junction':'dir');
  t.after(()=>fs.unlink(alias));
  const offline=createManagedMpv({...f.config,directory:alias,fetch:async()=>{throw new Error('offline');}});
  assert.equal((await offline.ensure()).available,true);await offline.dispose();
});
