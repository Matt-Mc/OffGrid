const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCaptureStore,parseCaptureUri,MAX_CAPTURES} = require('../electron/link-capture.cjs');
const uri = url => 'offgrid://add?url=' + encodeURIComponent(url);
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-capture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'captures.json');}
test('capture canonicalizes videos and keeps playlist context for an explicit choice',()=>{
  assert.equal(parseCaptureUri(uri('https://youtu.be/abcdefghijk?list=PL_example&si=tracking')),'https://www.youtube.com/watch?v=abcdefghijk&list=PL_example');
  assert.equal(parseCaptureUri(uri('https://youtube.com/playlist?list=PL_example')),'https://www.youtube.com/playlist?list=PL_example');
  assert.equal(parseCaptureUri(uri('https://youtube.com/shorts/abcdefghijk')),'https://www.youtube.com/watch?v=abcdefghijk');
});
test('capture rejects malformed, oversized and privileged URLs',()=>{
  const bad=['offgrid://delete?url=x','offgrid://add/else?url=x','offgrid://user@add?url=x','offgrid://add:80?url=x','offgrid://add?url=x#fragment','offgrid://add?url=%zz','offgrid://add?url=x&url=y','offgrid://add?url=x&action=download','offgrid://add?url='+ 'a'.repeat(16384),uri('file:///etc/passwd'),uri('javascript:alert(1)'),uri('https://youtube.com.evil.test/watch?v=abcdefghijk'),uri('https://evil.test@youtube.com/watch?v=abcdefghijk'),uri('https://youtube.com:444/watch?v=abcdefghijk'),uri('https://youtube.com/watch?v=a&v=b'),uri('https://youtube.com/@channel'),uri('https://youtube.com/watch?v=abcdefghijk\n'),uri('https://youtube.com/watch?v=hello%0aworld')];
  for(const value of bad)assert.throws(()=>parseCaptureUri(value),value);
});
test('capture persists drafts, deduplicates, bounds bursts, and acknowledges',t=>{
  const file=fixture(t);const events=[];const store=createCaptureStore({file,onChange:snapshot=>events.push(snapshot)});
  for(let i=0;i<MAX_CAPTURES;i++)store.receive(uri(`https://youtube.com/watch?v=fixture${i}`));
  const initial=store.list();store.receive(uri('https://youtu.be/fixture0'));assert.equal(store.list().items.length,20);assert.equal(events.length,20);
  store.receive(uri('https://youtube.com/watch?v=overflow'));assert.equal(store.list().items.length,20);assert.match(store.list().warning,/20 links/);
  const restored=createCaptureStore({file});assert.deepEqual(restored.list().items,initial.items);
  restored.acknowledge(initial.items[0].id);assert.equal(restored.list().items.length,19);
  assert.equal(createCaptureStore({file}).list().items.length,19);
  restored.receive(uri('https://youtube.com/watch?v=overflow'));assert.equal(restored.list().items.length,20);assert.equal(restored.list().warning,null);
});
test('capture list is isolated from callers and write failures preserve in-memory drafts',t=>{
  const file=fixture(t);const store=createCaptureStore({file});store.receive(uri('https://youtube.com/watch?v=first'));const initial=store.list();initial.items[0].url='file:///bad';assert.match(store.list().items[0].url,/youtube/);
  fs.rmSync(file);fs.mkdirSync(file);assert.throws(()=>store.acknowledge(initial.items[0].id));assert.equal(store.list().items.length,1);
});
test('invalid saved captures are not surfaced as trusted input',t=>{
  const file=fixture(t);fs.writeFileSync(file,JSON.stringify({version:1,items:[{id:'12345678-1234-1234-1234-123456789012',url:'file:///tmp/bad',createdAt:new Date().toISOString()}]}));const store=createCaptureStore({file});assert.equal(store.list().items.length,0);assert.match(store.list().warning,/could not be restored/);
  fs.writeFileSync(file,'{broken');assert.match(createCaptureStore({file}).list().warning,/could not be restored/);
});
