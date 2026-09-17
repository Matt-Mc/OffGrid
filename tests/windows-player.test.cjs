const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMpvPlayer } = require('../electron/mpv-player.cjs');
const { killProcessTree } = require('../electron/process-tree.cjs');

function harness(t, { delayed = false, unavailable = false, connectError } = {}) {
  const children = [], pipes = [], launches = [];
  let attempts = 0;
  const player = createMpvPlayer({ platform:'win32', env:{Path:'relative;C:\\Player folder'},
    fs:{promises:{ access:async file => { if (file !== 'C:\\Player folder\\mpv.exe') throw new Error('Missing'); }, stat:async()=>({isFile:()=>true}), realpath:async file=>file }},
    startupTimeoutMs:250, shutdownTimeoutMs:5,
    spawn(executable,args,options) {
      const child = new EventEmitter();
      child.kill = () => queueMicrotask(()=>child.emit('close',0));
      children.push(child); launches.push({executable,args,options}); return child;
    },
    connect(pipe) {
      pipes.push(pipe);
      const child = children.at(-1);
      const ipc = new EventEmitter();
      ipc.destroy = () => {ipc.destroyed=true;};
      ipc.commands=[];
      ipc.write = value => {
        const command=JSON.parse(value).command; ipc.commands.push(command);
        if(command[0]==='loadfile') queueMicrotask(()=>ipc.emit('data',Buffer.from('{"event":"file-loaded"}\n')));
        if(command[0]==='quit') queueMicrotask(()=>child.emit('close',0));
      };
      child.ipc=ipc;
      queueMicrotask(()=> {
        if(unavailable || (delayed && attempts++===0) || connectError) ipc.emit('error',Object.assign(new Error('pipe'),{code:connectError || 'ENOENT'}));
        else ipc.emit('connect');
      });
      return ipc;
    },
  });
  t.after(()=>player.stop());
  return {player,children,pipes,launches};
}
const video={id:'one',filePath:'C:\\Library with spaces\\Movie — 1.mkv',duration:100,playbackPositionSeconds:20};
test('Windows discovers mpv.exe and subscribes before loading through a unique named pipe',async t=>{
  const f=harness(t,{delayed:true});
  assert.equal((await f.player.status()).path,'C:\\Player folder\\mpv.exe');
  await f.player.open(video);
  assert.equal(f.launches[0].options.shell,false);
  assert.equal(f.launches[0].options.windowsHide,true);
  assert.equal(f.launches[0].args.includes('--input-ipc-client=fd://3'),false);
  assert.match(f.pipes[0],/^\\\\\.\\pipe\\offgrid-[a-f0-9-]+$/);
  assert.deepEqual(f.children[0].ipc.commands,[['observe_property',1,'time-pos'],['observe_property',2,'duration'],['observe_property',3,'pause'],['loadfile',video.filePath]]);
  await f.player.control('toggle-pause');
  assert.deepEqual(f.children[0].ipc.commands.at(-1),['cycle','pause']);
  await f.player.stop();
  await f.player.open(video);
  assert.notEqual(f.pipes[0],f.pipes.at(-1));
});
test('Windows pipe startup times out and cleans the child; unexpected errors fail immediately',async t=>{
  for(const options of [{unavailable:true},{connectError:'EACCES'}]) {
    const f=harness(t,options);
    await assert.rejects(f.player.open(video),/in time|could not be created/);
    await f.player.stop();
    assert.equal(f.children[0].ipc.destroyed,true);
  }
});
test('closing the player window reports a normal stop when the pipe closes before the process',async t=>{
  const f=harness(t);await f.player.open(video);
  f.children[0].ipc.emit('close');
  f.children[0].emit('close',0);
  assert.equal(f.player.state().status,'stopped');
  assert.equal(f.player.state().error,null);
});
test('Windows process cancellation waits for taskkill and targets the entire tree without a shell',async()=>{
  let finish, call;
  const pending=killProcessTree({pid:4321},{platform:'win32',execute:(...args)=>{call=args;finish=args[3];}});
  let done=false;pending.then(()=>{done=true;});
  await Promise.resolve();assert.equal(done,false);
  assert.deepEqual(call[1],['/PID','4321','/T','/F']);assert.equal(call[2].windowsHide,true);
  finish(null);await pending;assert.equal(done,true);
  await assert.rejects(killProcessTree({pid:4321},{platform:'win32',execute:(_a,_b,_c,cb)=>cb({code:1})}),/Could not stop/);
});
