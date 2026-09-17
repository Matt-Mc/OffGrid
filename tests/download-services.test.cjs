const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DurableQueue,defaultSettings} = require('../electron/backend-core.cjs');
const {createDownloadServices,subtitleOptions,youtubeTracks} = require('../electron/download-services.cjs');
const {projectQueue} = require('../electron/batch-downloads.cjs');
function harness(t,overrides={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-services-'));const queue=new DurableQueue({file:path.join(directory,'queue.json'),execute:async()=>{},canRun:()=>false});queue.paused=true;
  const library=[];const settings=defaultSettings();const deleted=[];const status={serverId:'server-one',baseUrl:'http://127.0.0.1:8096'};
  const client={metadata:async id=>({id,title:`Episode ${id}`,sizeBytes:1e8}),browse:async()=>({items:[],total:0})};
  const server={revision:0,busy:false,connection:{status:()=>({...status}),client:()=>client}};
  const service=createDownloadServices({settings:()=>settings,library:()=>library,queue:()=>queue,servers:{jellyfin:server},metadata:async()=>({title:'Video',duration:100,filesize:1e6}),ytCommand:async()=>'fixture',isOnline:()=>true,clearDeleted:ids=>deleted.push(...ids),...overrides});
  t.after(()=>{service.dispose();queue.shuttingDown=true;clearTimeout(queue.retryTimer);fs.rmSync(directory,{recursive:true,force:true});});
  return {service,queue,library,settings,deleted,server,status,client};
}
const url=id=>`https://www.youtube.com/watch?v=${id}`;
test('mixed YouTube batch freezes options, deduplicates within submission, and counts every input',t=>{
  const h=harness(t);h.library.push({id:'saved',sourceId:'saved'});h.queue.addMany([{url:url('queued'),sourceId:'queued'}]);
  const result=h.service.addDownloadBatch({urls:[url('new'), 'https://youtu.be/new',url('saved'),url('queued'),'file:///bad'],quality:'480p',subtitleLanguages:['fr'],allowAutoCaptions:true});
  assert.deepEqual(result.counts,{added:1,alreadyQueued:2,alreadySaved:1,rejected:1});assert.equal(result.results.length,5);assert.deepEqual(h.deleted,['new']);
  h.settings.defaultSubtitleLanguage='ja';h.settings.defaultQuality='1080p';const added=h.queue.jobs.find(job=>job.sourceId==='new');assert.equal(added.quality,'480p');assert.deepEqual(added.subtitleLanguages,['fr']);assert.equal(added.allowAutoCaptions,true);
  assert.throws(()=>h.service.addDownloadBatch({urls:[]}),/between/);assert.throws(()=>h.service.addDownloadBatch({urls:Array(501).fill(url('a'))}),/500/);
});
test('server batch is atomic against reconnect during metadata preparation',async t=>{
  const h=harness(t);let release;const pending=new Promise(resolve=>release=resolve);h.client.metadata=async id=>{await pending;return{id,title:id,sizeBytes:12};};
  const request=h.service.downloadServerBatch('jellyfin',{ids:['a','b'],copyQuality:'720p'});h.server.revision++;release();await assert.rejects(request,/connection changed/);assert.equal(h.queue.jobs.length,0);
});
test('server batch deduplicates repeated ids and retains per-item metadata failure',async t=>{
  const h=harness(t);h.library.push({sourceId:'jellyfin:server-one:saved'});h.client.metadata=async id=>{if(id==='denied')throw new Error('Download permission denied');return{id,title:id,sizeBytes:12};};
  const result=await h.service.downloadServerBatch('jellyfin',{ids:['new','new','saved','denied'],copyQuality:'720p',subtitleLanguages:['en']});assert.deepEqual(result.counts,{added:1,alreadyQueued:1,alreadySaved:1,rejected:1});assert.equal(h.queue.jobs[0].copyQuality,'720p');assert.equal(h.queue.jobs[0].serverId,'server-one');assert.match(result.results[3].reason,/permission/);
});
test('season preview enumerates beyond 100 and orders numeric episode values',async t=>{
  const h=harness(t);const items=Array.from({length:207},(_,i)=>({id:`episode-${i}`,type:'episode',seasonNumber:1,episodeNumber:207-i,title:`Episode ${207-i}`,downloadable:true,sizeBytes:100}));const starts=[];
  h.client.browse=async({start})=>{starts.push(start);return{items:items.slice(start,start+100),total:207};};
  const result=await h.service.previewServerSeason('jellyfin','season');assert.deepEqual(starts,[0,100,200]);assert.equal(result.items.length,207);assert.equal(result.complete,true);assert.equal(result.items[0].episodeNumber,1);assert.equal(result.items[206].episodeNumber,207);
});
test('repeated and changing season pages produce incomplete previews without unbounded reads',async t=>{
  const h=harness(t);const items=[{id:'one',type:'episode',episodeNumber:1,downloadable:true}];let reads=0;h.client.browse=async()=>{reads++;return{items,total:200};};
  const repeated=await h.service.previewServerSeason('jellyfin','season');assert.equal(reads,2);assert.equal(repeated.complete,false);assert.equal(repeated.items.length,1);assert.match(repeated.warning,/repeated/);
  reads=0;h.client.browse=async()=>({items,total:++reads===1?200:201});const changed=await h.service.previewServerSeason('jellyfin','season');assert.equal(changed.complete,false);assert.match(changed.warning,/changed/);
});
test('invalid preview requests do not exhaust valid preview capacity',async t=>{
  const h=harness(t);for(let i=0;i<5;i++)await assert.rejects(h.service.previewDownloads({requestId:`invalid-${i}`,input:url('a'),quality:'bad'}),/quality/);
  const result=await h.service.previewDownloads({requestId:'valid',input:url('a')});assert.equal(result.items[0].title,'Video');
});
test('preview cancellation cannot return late metadata as a completed preview',async t=>{
  let release;const pending=new Promise(resolve=>release=resolve);const h=harness(t,{metadata:async()=>{await pending;return{title:'Late metadata'};}});
  const preview=h.service.previewDownloads({requestId:'cancel-me',input:url('a')});await new Promise(resolve=>setImmediate(resolve));h.service.cancelPreview('cancel-me');release();await assert.rejects(preview,/cancel/i);
});
test('unknown-size queued items never produce a confident storage fit',()=>{
  const storage={freeBytes:1e12,diskReserveBytes:2e9,maxLibraryBytes:null,savedBytes:0,temporaryBytes:0};const result=projectQueue([{status:'paused',expectedBytes:null},{status:'queued',provider:'jellyfin',copyQuality:'720p',expectedBytes:1e8,retainedBytes:5e7}],storage);assert.equal(result.fits,null);assert.equal(result.unknownCount,1);assert.ok(result.additionalPeakBytes>=15e7);
  assert.equal(projectQueue([{status:'queued',expectedBytes:1e9}],{...storage,freeBytes:2e9}).fits,false);
});
test('subtitle choices are bounded and track discovery keeps origins distinct',()=>{
  assert.deepEqual(subtitleOptions({subtitleLanguages:['en','en']},{defaultSubtitleLanguage:'fr'}),{subtitleLanguages:['en'],allowAutoCaptions:false});
  for(const subtitleLanguages of [['../../en'],['en','fr','es'],[''],['all']]) {if(subtitleLanguages[0]==='all')continue;assert.throws(()=>subtitleOptions({subtitleLanguages}));}
  const tracks=youtubeTracks({subtitles:{en:[{ext:'vtt'}],fr:[{ext:'json3'}]},automatic_captions:{en:[{ext:'vtt'}]}});assert.deepEqual(tracks.map(track=>track.origin),['manual','auto']);assert.equal(tracks.length,2);
});
test('queued batches use trusted quality-specific preview estimates in cumulative space projection',async t=>{
  const h=harness(t);await h.service.previewDownloads({requestId:'estimate',input:url('first')+'\n'+url('second'),quality:'720p'});
  h.service.addDownloadBatch({urls:[url('first'),url('second')],quality:'720p'});
  assert.deepEqual(h.queue.jobs.map(job=>job.expectedBytes),[1e6,1e6]);
  const projected=projectQueue(h.queue.jobs,{freeBytes:50e9,diskReserveBytes:2e9,maxLibraryBytes:19.5e6,savedBytes:0,temporaryBytes:0});assert.equal(projected.additionalPeakBytes,20e6);assert.equal(projected.fits,false);
  h.service.addDownloadBatch({urls:[url('third')],quality:'480p',expectedBytes:1});assert.equal(h.queue.jobs[2].expectedBytes,undefined);
});
test('canceling a season preview aborts the provider request and cannot publish a late page',async t=>{
  const h=harness(t);let release,signal;h.client.browse=async options=>{signal=options.signal;return new Promise(resolve=>{release=()=>resolve({items:[{id:'one',type:'episode',downloadable:true}],total:200});});};
  const pending=h.service.previewServerSeason('jellyfin','season','cancel-season');await new Promise(resolve=>setImmediate(resolve));h.service.cancelPreview('cancel-season');assert.equal(signal.aborted,true);release();await assert.rejects(pending,/canceled/);
});
