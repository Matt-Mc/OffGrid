const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {readPlaylist,runYtdlpJson,mapBounded} = require('../electron/youtube-playlists.cjs');
const {parseYouTubeUrl,parseLinkInput} = require('../electron/youtube-links.cjs');
function spawnFixture(feed,{hold=false}={}){const calls=[];const children=[];const spawnProcess=(command,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;setImmediate(()=>child.emit('close',null));};calls.push({command,args});children.push(child);if(!hold)setImmediate(()=>{child.stdout.write(typeof feed==='string'?feed:JSON.stringify(feed));child.emit('close',0);});return child;};return{spawnProcess,calls,children};}
test('playlist pagination uses a lookahead and preserves unavailable rows',async()=>{
  const entries=Array.from({length:101},(_,i)=>({id:`video${i}`,title:`Video ${i}`}));entries[1]={id:'private',title:'[Private video]',availability:'private'};entries[2]=null;
  const fixture=spawnFixture({entries,playlist_count:220});const page=await readPlaylist('yt-dlp','https://youtube.com/playlist?list=PL_fixture',{start:100,...fixture});
  assert.equal(page.items.length,100);assert.equal(page.hasMore,true);assert.equal(page.complete,false);assert.equal(page.total,220);assert.equal(page.items[1].available,false);assert.equal(page.items[2].available,false);assert.equal(page.items[2].url,null);
  const args=fixture.calls[0].args;assert.equal(args[args.indexOf('--playlist-start')+1],'101');assert.equal(args[args.indexOf('--playlist-end')+1],'201');assert(args.includes('--ignore-config'));
});
test('unknown playlist totals are explicitly qualified',async()=>{
  const page=await readPlaylist('yt-dlp','https://youtube.com/playlist?list=PL_fixture',spawnFixture({entries:[{id:'one',title:'One'}]}));assert.match(page.warning,/could not be confirmed/);assert.equal(page.hasMore,false);
});
test('playlist cancellation kills child and rejects rather than reporting an empty playlist',async()=>{
  const fixture=spawnFixture(null,{hold:true});const controller=new AbortController();const pending=readPlaylist('yt-dlp','https://youtube.com/playlist?list=PL_fixture',{...fixture,signal:controller.signal});controller.abort();await assert.rejects(pending,/cancel/i);assert.equal(fixture.children[0].killed,true);
});
test('oversized metadata and process timeout fail closed',async()=>{
  const large=spawnFixture('a'.repeat(40));await assert.rejects(runYtdlpJson('yt-dlp',[],{...large,maxBytes:16}),/too large/);assert(large.children[0].killed);
  const held=spawnFixture(null,{hold:true});await assert.rejects(runYtdlpJson('yt-dlp',[],{...held,timeoutMs:5}),/timed out/);assert(held.children[0].killed);
});
test('metadata mapping is bounded and preserves order despite completion order',async()=>{
  let active=0,peak=0;const result=await mapBounded([4,3,2,1],async value=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,value));active--;return value*10;},{concurrency:2});assert.equal(peak,2);assert.deepEqual(result,[40,30,20,10]);
});
test('YouTube URLs choose video or playlist deliberately and reject spoofed sources',()=>{
  const url='https://youtube.com/watch?v=video&list=PL_fixture';assert.equal(parseYouTubeUrl(url).type,'video');assert.equal(parseYouTubeUrl(url,'playlist').type,'playlist');assert.equal(parseYouTubeUrl('https://youtu.be/video?t=123').url,'https://www.youtube.com/watch?v=video');
  for(const value of ['https://youtube.com.evil/watch?v=a','https://youtube.com:999/watch?v=a','https://user@youtube.com/watch?v=a','https://youtube.com/watch?v=a&v=b','https://youtube.com/watch?v=a&list=p&list=q','file:///a','https://youtube.com/@channel'])assert.throws(()=>parseYouTubeUrl(value),value);
  assert.deepEqual(parseLinkInput(' \nhttps://youtu.be/a\r\n https://youtu.be/b '),['https://youtu.be/a','https://youtu.be/b']);assert.throws(()=>parseLinkInput(Array(501).fill('https://youtu.be/a').join('\n')),/500/);
});
