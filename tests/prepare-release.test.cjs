'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { nextVersion, prepareRelease } = require('../scripts/prepare-release.cjs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-release-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const remote = path.join(root,'remote.git');
  const checkout = path.join(root,'checkout');
  git(root,'init','--bare',remote);
  git(root,'clone',remote,checkout);
  git(checkout,'checkout','-b','main');
  git(checkout,'config','user.name','Release test');
  git(checkout,'config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(checkout,'package.json'),JSON.stringify({name:'fixture',version:'0.3.1'}));
  fs.writeFileSync(path.join(checkout,'package-lock.json'),JSON.stringify({version:'0.3.1',packages:{'':{version:'0.3.1'},dependency:{version:'1.2.3'}}}));
  git(checkout,'add','.');git(checkout,'commit','-m','Merged source');
  const source = git(checkout,'rev-parse','HEAD');
  git(checkout,'tag','v0.3.1');git(checkout,'push','origin','main','--tags');
  return {root,remote,checkout,source};
}
test('automatic versions advance stable tags and respect an explicit minor/major bump',()=>{
  assert.equal(nextVersion('0.3.1',['v0.3.1']),'0.3.2');
  assert.equal(nextVersion('0.3.1',['v0.3.9','v0.3.10','v99.0.0-beta','notes']),'0.3.11');
  assert.equal(nextVersion('0.4.0',['v0.3.10']),'0.4.0');
  assert.equal(nextVersion('1.0.0',[]),'1.0.0');
  assert.throws(()=>nextVersion('1.0.0-beta',[]),/stable/);
});
test('reserves a matching source/version tag without changing main; reruns reuse it',t=>{
  const f=fixture(t);
  const release=prepareRelease({directory:f.checkout,source:f.source});
  assert.equal(release.tag,'v0.3.2');
  assert.equal(git(f.remote,'rev-parse','main'),f.source);
  assert.equal(git(f.checkout,'rev-parse',`${release.sha}^`),f.source);
  const locked=JSON.parse(git(f.checkout,'show',`${release.sha}:package-lock.json`));
  assert.equal(locked.version,'0.3.2');assert.equal(locked.packages[''].version,'0.3.2');
  assert.equal(locked.packages.dependency.version,'1.2.3');
  git(f.checkout,'checkout','--detach',f.source);
  assert.deepEqual(prepareRelease({directory:f.checkout,source:f.source}),release);
});
test('a concurrent tag reservation retries without replacing the winning tag',t=>{
  const f=fixture(t);
  let collision=false;
  const result=prepareRelease({directory:f.checkout,source:f.source,beforePush:({tag})=>{
    if(collision)return;collision=true;
    git(f.remote,'update-ref',`refs/tags/${tag}`,f.source);
  }});
  assert.equal(result.tag,'v0.3.3');assert.equal(git(f.remote,'rev-parse','v0.3.2'),f.source);
});
test('an unmerged commit cannot create a release tag',t=>{
  const f=fixture(t);
  git(f.checkout,'commit','--allow-empty','-m','Not merged');
  const source=git(f.checkout,'rev-parse','HEAD');
  assert.throws(()=>prepareRelease({directory:f.checkout,source}));
  assert.equal(git(f.remote,'tag','--list'),'v0.3.1');
});
test('manual runs build without publishing; tagged runs require a matching version',t=>{
  const f=fixture(t);
  const eventFile=path.join(f.root,'event.json'),output=path.join(f.root,'outputs');
  fs.writeFileSync(eventFile,'{}');
  const run=ref=>execFileSync(process.execPath,[path.resolve(__dirname,'../scripts/prepare-release.cjs')],{
    cwd:f.checkout,encoding:'utf8',stdio:['ignore','pipe','pipe'],
    env:{...process.env,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_EVENT_PATH:eventFile,GITHUB_OUTPUT:output,GITHUB_REF:ref},
  });
  run('refs/heads/main');assert.match(fs.readFileSync(output,'utf8'),/publish=false/);
  fs.writeFileSync(output,'');run('refs/tags/v0.3.1');assert.match(fs.readFileSync(output,'utf8'),/tag=v0.3.1/);
  assert.match(fs.readFileSync(output,'utf8'),/publish=true/);
  assert.throws(()=>run('refs/tags/v0.3.2'),/Tag must match/);
});
