const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createCheckpointStore}=require('../electron/download-checkpoints.cjs');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-checkpoint-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workDirectory=path.join(root,'work');fs.mkdirSync(workDirectory);
  const job={id:crypto.randomUUID(),provider:'plex',sourceId:'plex:server:42',serverId:'server',ratingKey:'42',url:'plex://server/42',quality:'original',copyQuality:'original'};
  const store=createCheckpointStore({workDirectory});
  fs.mkdirSync(path.join(workDirectory,job.id));
  const put=(name,size)=>fs.writeFileSync(store.path(job,name),Buffer.alloc(size,7));
  return {root,workDirectory,job,store,put};
}

test('checkpoint recovers actual partial growth and rejects truncated or changed completed inputs',t=>{
  const {job,store,put}=fixture(t);
  put('source.part',40);put('input.mkv',100);
  store.write(job,{files:[{name:'source.part',kind:'partial'},{name:'input.mkv',kind:'input',complete:true}],transfer:{etag:'"v1"',totalBytes:100,offset:40}});
  put('source.part',60);
  assert.equal(store.inspect(job).retainedBytes,160);
  put('input.mkv',99);assert.equal(store.inspect(job).retainedBytes,60);
  put('source.part',10);assert.equal(store.inspect(job).retainedBytes,0);
});

test('source changes invalidate all artifacts; conversion changes retain complete original inputs',t=>{
  const {job,store,put}=fixture(t);
  put('source.mkv',100);put('copy.mp4',40);put('broken.mp4',10);
  store.write(job,{phase:'processing',files:[{name:'source.mkv',kind:'input',complete:true},{name:'copy.mp4',kind:'output',complete:true},{name:'broken.mp4',kind:'output'}]});
  assert.equal(store.inspect(job).retainedBytes,140);
  assert.equal(store.inspect({...job,copyQuality:'720p'}).retainedBytes,100);
  assert.equal(store.inspect({...job,serverId:'another'}).retainedBytes,0);
  assert.equal(store.inspect({...job,quality:'720p'}).resumable,false);
});

test('unknown or malformed checkpoint cannot be overwritten and keeps media untouched',t=>{
  const {job,store,put}=fixture(t);put('source.part',40);
  const file=store.path(job,'checkpoint.json');
  for(const content of ['{broken',JSON.stringify({version:99})]) {
    fs.writeFileSync(file,content);
    assert.throws(()=>store.write(job,{files:[]}),/checkpoint/);
    assert.equal(fs.readFileSync(file,'utf8'),content);
    assert.equal(fs.statSync(store.path(job,'source.part')).size,40);
  }
});

test('checkpoint paths reject traversal and symlinked files or job directories',t=>{
  const {root,job,store,put,workDirectory}=fixture(t);put('source.part',40);
  assert.throws(()=>store.path(job,'../outside'),/Unsafe/);
  assert.throws(()=>store.path({...job,id:'../outside'},'source.part'),/identity/);
  const external=path.join(root,'external');fs.writeFileSync(external,'untouched');
  fs.symlinkSync(external,store.path(job,'linked.part'));
  assert.throws(()=>store.write(job,{files:[{name:'linked.part'}]}),/unsafe/);
  store.write(job,{files:[{name:'source.part'}]});
  fs.unlinkSync(store.path(job,'source.part'));fs.symlinkSync(external,store.path(job,'source.part'));
  assert.throws(()=>store.inspect(job),/unsafe/);
  const other={...job,id:crypto.randomUUID()};fs.symlinkSync(root,path.join(workDirectory,other.id));
  assert.throws(()=>store.discard(other),/unsafe/);
  assert.equal(fs.readFileSync(external,'utf8'),'untouched');
});

test('finalization journal preserves a library record and enforces UUID ownership',t=>{
  const {job,store}=fixture(t);
  const record={id:job.id,title:'Saved film',playbackPositionSeconds:34,assets:[],filePath:`/derived/videos/${job.id}.mkv`};
  const result=store.write(job,{phase:'finalizing',files:[],finalization:{stage:'media-moved',mediaName:`${job.id}.mkv`,record}});
  assert.deepEqual(store.read(job).finalization.record,record);
  assert.equal(result.phase,'finalizing');
  assert.throws(()=>store.write(job,{finalization:{stage:'prepared',mediaName:'someone-else.mkv'}}),/belong/);
  assert.throws(()=>store.write(job,{finalization:{stage:'prepared',record:{...record,token:'secret'}}}),/Credentials/);
});

test('checkpoints freeze caption options and never persist arbitrary transfer URLs or credentials',t=>{
  const {job,store}=fixture(t);
  const result=store.write({...job,subtitleLanguages:['en','fr'],allowAutoCaptions:true},{files:[],transfer:{etag:'"original"',totalBytes:100,url:'https://signed.invalid/?token=secret',token:'secret'}});
  assert.deepEqual(result.options.subtitleLanguages,['en','fr']);assert.equal(result.options.allowAutoCaptions,true);
  assert.deepEqual(result.transfer,{etag:'"original"',totalBytes:100});
});
