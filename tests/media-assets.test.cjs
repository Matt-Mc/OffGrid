const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {readSubtitle,subtitleAsset,ownedAssetPath,MAX_SUBTITLE_BYTES}=require('../electron/media-assets.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-subtitles-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
test('SRT becomes normalized WebVTT with valid retained cues',t=>{
  const file=path.join(fixture(t),'captions.srt');fs.writeFileSync(file,'\ufeff1\r\n00:00:01,000 --> 00:00:02,500\r\nA quiet journey.\r\n');const result=readSubtitle(file,'srt');assert(result.startsWith('WEBVTT\n\n'));assert.match(result,/00:00:01.000 --> 00:00:02.500/);assert(!result.includes('\r'));
});
test('invalid timing, response HTML, empty and oversized subtitles are rejected',t=>{
  const file=path.join(fixture(t),'captions.vtt');const invalid=['','<html>login</html>','WEBVTT\n\n00:00.000 --> garbage\nWords','WEBVTT\n\n00:02.000 --> 00:01.000\nWords','WEBVTT\n\n00:70.000 --> 00:80.000\nWords','WEBVTT\n\n00:00.000 --> 00:01.000\n\0', 'WEBVTT\n\n00:00.000 --> 00:01.000\n<script>x</script>'];
  for(const text of invalid){fs.writeFileSync(file,text);assert.throws(()=>readSubtitle(file,'vtt'),undefined,text);}
  fs.writeFileSync(file,Buffer.alloc(MAX_SUBTITLE_BYTES+1));assert.throws(()=>readSubtitle(file,'vtt'),/5 MB/);
});
test('subtitle assets are owner-scoped and cannot follow a source symlink',t=>{
  const directory=fixture(t);const source=path.join(directory,'source.vtt');fs.writeFileSync(source,'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n');const link=path.join(directory,'link.vtt');fs.symlinkSync(source,link);assert.throws(()=>readSubtitle(link,'vtt'),/unsafe/);
  const ownerId=crypto.randomUUID();const asset=subtitleAsset({file:source,format:'vtt',language:'en',origin:'manual',outputDirectory:directory,ownerId});assert.equal(asset.sizeBytes,fs.statSync(asset.filePath).size);assert.equal(ownedAssetPath(directory,ownerId,asset),asset.filePath);assert.equal(ownedAssetPath(directory,crypto.randomUUID(),asset),null);assert.equal(ownedAssetPath(directory,ownerId,{...asset,filePath:source}),null);assert.throws(()=>subtitleAsset({file:source,format:'vtt',language:'../../en',outputDirectory:directory,ownerId}));
});
