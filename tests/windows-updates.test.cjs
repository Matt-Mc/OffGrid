const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAppUpdates } = require('../electron/app-updates.cjs');
const { createUpdateDownload } = require('../electron/update-download.cjs');
const base='https://github.com/Matt-Mc/OffGrid/releases';
function fixture(data) {
  const name='Offgrid-0.4.0-win-x64.exe';
  const digest=crypto.createHash('sha256').update(data).digest('hex');
  const checksums=`${digest}  ${name}\n`;
  const metadata={tag_name:'v0.4.0',draft:false,prerelease:false,html_url:`${base}/tag/v0.4.0`,assets:[
    {name,size:data.length,digest:`sha256:${digest}`},
    {name:'SHA256SUMS-windows',size:Buffer.byteLength(checksums)},
  ].map(asset=>({...asset,state:'uploaded',browser_download_url:`${base}/download/v0.4.0/${asset.name}`}))};
  return {metadata,checksums};
}
test('Windows selects only its installer and verifies PE/checksums before opening or reusing it',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'offgrid-win-update-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const data=Buffer.alloc(1024);
  data.write('MZ');data.writeUInt32LE(128,60);data.writeUInt32LE(0x4550,128);data.writeUInt16LE(0x14c,132);
  const f=fixture(data);
  const checker=createAppUpdates({currentVersion:'0.3.1',platform:'win32',arch:'x64',systemVersion:'10.0.26200',fetch:async()=>new Response(JSON.stringify(f.metadata))});
  const available=await checker.check();assert.equal(available.state,'available');
  assert.equal(available.release.runtimeManifest,undefined,'Mac runtime manifest is not required');
  const opened=[];
  const downloader=createUpdateDownload({directory,platform:'win32',arch:'x64',fetch:async url=>new Response(url.endsWith('SHA256SUMS-windows')?f.checksums:data),openPath:async file=>{opened.push(file);return '';}});
  t.after(()=>downloader.dispose());
  assert.equal((await downloader.download(available.release)).state,'ready');
  assert.match(downloader.status().message,/setup prompts/);
  assert.equal((await downloader.download(available.release)).state,'ready');assert.equal(opened.length,2);
  await fs.appendFile(opened[0],'tampered');
  assert.equal((await downloader.download(available.release)).state,'error');assert.equal(opened.length,2);
  await assert.rejects(downloader.download({...available.release,asset:{...available.release.asset,name:'Offgrid-0.4.0-arm64.dmg'}}),/invalid/);
});
test('a checksum-valid non-PE Windows asset cannot launch',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'offgrid-win-update-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  for(const malformed of [Buffer.alloc(1024),Buffer.from('MZ'+'x'.repeat(1022))]) {
    const f=fixture(malformed);
    const checker=createAppUpdates({currentVersion:'0.3.1',platform:'win32',arch:'x64',fetch:async()=>new Response(JSON.stringify(f.metadata))});
    let opened=0;
    const downloader=createUpdateDownload({directory,platform:'win32',arch:'x64',fetch:async url=>new Response(url.endsWith('SHA256SUMS-windows')?f.checksums:malformed),openPath:async()=>{opened++;}});
    assert.equal((await downloader.download((await checker.check()).release)).state,'error');assert.equal(opened,0);
    await downloader.dispose();
  }
});
