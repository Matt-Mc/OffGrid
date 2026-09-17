const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');const {spawnSync}=require('node:child_process');
const {parseMediaInfo,smallerCopy,inspectMedia}=require('../electron/media-conversion.cjs');
const {readSubtitle}=require('../electron/media-assets.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'offgrid-conversion-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
function info({codec='h264',height=1080,duration='00:00:10.000',audio=1,extra=''}={}){return `Input #0\n  Duration: ${duration}, start: 0.0\n  Stream #0:0: Video: ${codec}, yuv420p, 1920x${height}, 30 fps\n${Array.from({length:audio},(_,i)=>`  Stream #0:${i+1}(eng): Audio: aac, 48000 Hz\n`).join('')}${extra}`;}
function fakeConversion(source,result,{encoders='libx264 aac',outputBytes=100}={}){const calls=[];let inspectCount=0;return{calls,spawnProcess:(command,args)=>{calls.push(args);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('close',null);setImmediate(()=>{let data='';if(args.includes('-encoders'))data=encoders;else if(args.includes('-t'))data=inspectCount++===0?source:result;else if(args.includes('-c:v'))fs.writeFileSync(args.at(-1),Buffer.alloc(outputBytes));child.stderr.write(data);child.emit('close',0);});return child;}};}
test('inspection counts input tracks once and detects HDR metadata',()=>{
  const value=parseMediaInfo(info({extra:'  Stream #0:2(eng): Subtitle: subrip\n'})+'Stream mapping:\nOutput #0\n  Stream #0:1: Audio: pcm_s16le\n');assert.equal(value.audioCount,1);assert.equal(value.subtitles[0].language,'eng');assert.equal(value.subtitles[0].index,2);assert.equal(parseMediaInfo(info({extra:'color_transfer=smpte2084'})).hdr,true);assert.throws(()=>parseMediaInfo('Duration: N/A\nno video'),/inspected/);
});
test('smaller-copy refuses unsupported HDR and image subtitles before transcoding',async t=>{
  const directory=fixture(t);const input=path.join(directory,'original.mkv');fs.writeFileSync(input,Buffer.alloc(1000));
  for(const extra of ['smpte2084\n','  Stream #0:2: Subtitle: hdmv_pgs_subtitle\n']){const fake=fakeConversion(info({extra}),info({height:720}));await assert.rejects(smallerCopy({command:'ffmpeg',input,output:path.join(directory,'out.mp4'),jobId:crypto.randomUUID(),...fake,assertActive:()=>{}}),/original/i);assert(!fake.calls.some(args=>args.includes('-c:v')));}
});
test('smaller-copy rejects missing audio, wrong resolution, duration drift, and non-smaller output',async t=>{
  const directory=fixture(t);const input=path.join(directory,'original.mkv');fs.writeFileSync(input,Buffer.alloc(1000));
  for(const [result,outputBytes] of [[info({height:720,audio:0}),100],[info({height:1080}),100],[info({height:720,duration:'00:00:04.000'}),100],[info({height:720}),1000]]){const fake=fakeConversion(info(),result,{outputBytes});await assert.rejects(smallerCopy({command:'ffmpeg',input,output:path.join(directory,'out.mp4'),jobId:crypto.randomUUID(),...fake,assertActive:()=>{}}),/media checks|smaller file/);}
});
test('cancellation after inspection cannot advance into encoding',async t=>{
  const directory=fixture(t);const input=path.join(directory,'original.mkv');fs.writeFileSync(input,Buffer.alloc(1000));const fake=fakeConversion(info(),info({height:720}));await assert.rejects(smallerCopy({command:'ffmpeg',input,output:path.join(directory,'out.mp4'),jobId:crypto.randomUUID(),...fake,assertActive:()=>{throw new Error('Canceled');}}),/Canceled/);assert.equal(fake.calls.length,1);
});
const ffmpeg=process.env.OFFGRID_TEST_FFMPEG_PATH || 'ffmpeg';const ffmpegAvailable=spawnSync(ffmpeg,['-version'],{stdio:'ignore'}).status===0;
test('local FFmpeg makes a smaller decodable 720p copy preserving two audio tracks and text subtitle', {skip:!ffmpegAvailable,timeout:60000},async t=>{
  const directory=fixture(t);const input=path.join(directory,'original.mkv');const output=path.join(directory,'small.mp4');const subtitle=path.join(directory,'source.srt');fs.writeFileSync(subtitle,'1\n00:00:00,000 --> 00:00:01,500\nLocal fixture caption.\n');
  const generated=spawnSync(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=1280x800:rate=15:duration=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2','-i',subtitle,'-map','0:v','-map','1:a','-map','2:a','-map','3:s','-c:v','ffv1','-c:a','pcm_s16le','-c:s','srt','-metadata:s:s:0','language=eng',input],{encoding:'utf8',timeout:30000});assert.equal(generated.status,0,generated.stderr);
  const result=await smallerCopy({command:ffmpeg,input,output,jobId:crypto.randomUUID(),assertActive:()=>{}});assert(result.sizeBytes<result.sourceBytes);const inspected=await inspectMedia(ffmpeg,output);assert.equal(inspected.height,720);assert.equal(inspected.audioCount,2);assert.equal(inspected.codec,'h264');assert.equal(result.subtitles.length,1);assert.match(readSubtitle(result.subtitles[0].file,'vtt'),/Local fixture caption/);assert(Math.abs(inspected.duration-2)<.1);
});
test('progress persistence failure stops processing and rejects after child closure',async()=>{
  const {runFfmpeg}=require('../electron/media-conversion.cjs');
  let closed=false;
  const spawnProcess=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{setImmediate(()=>{closed=true;child.emit('close',null);});};setImmediate(()=>child.stdout.write('progress=continue'));return child;};
  await assert.rejects(runFfmpeg('ffmpeg',[],{spawnProcess,onProgress:()=>{throw new Error('Checkpoint write failed');}}),/Checkpoint write failed/);assert.equal(closed,true);
});
