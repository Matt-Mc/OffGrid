'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { compareVersions } = require('../electron/app-updates.cjs');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
function nextVersion(current, tags) {
  if (!VERSION.test(current)) throw new Error('A stable package version is required.');
  const versions = tags.filter(tag => tag.startsWith('v') && VERSION.test(tag.slice(1))).map(tag => tag.slice(1));
  const highest = versions.sort(compareVersions).at(-1);
  if (!highest || compareVersions(current, highest) > 0) return current;
  const parts = highest.split('.');
  parts[2] = String(BigInt(parts[2]) + 1n);
  return parts.join('.');
}

function prepareRelease({ directory = process.cwd(), source, remote = 'origin', beforePush = () => {} }) {
  if (!SHA.test(source)) throw new Error('Expected a full merge commit SHA.');
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('status', '--porcelain')) throw new Error('Release preparation requires a clean checkout.');
  git('fetch', remote, 'main', '--tags');
  git('merge-base', '--is-ancestor', source, 'FETCH_HEAD');
  if (git('rev-parse', 'HEAD') !== source) throw new Error('Checkout must match the merged PR commit.');
  const packageFile = path.join(directory, 'package.json');
  const lockFile = path.join(directory, 'package-lock.json');
  const packageData = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  if (lockData.version !== packageData.version || lockData.packages?.['']?.version !== packageData.version) throw new Error('Package and lockfile versions must match.');
  const current = packageData.version;
  const marker = `Offgrid-Merge: ${source}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
    // A rerun reuses its reserved tag, including after a failed platform build.
    for (const tag of tags.filter(tag => VERSION.test(tag.slice(1)))) {
      if (!git('for-each-ref', '--format=%(contents)', `refs/tags/${tag}`).split('\n').includes(marker)) continue;
      const sha = git('rev-parse', `${tag}^{commit}`);
      if (git('rev-parse', `${sha}^`) !== source || JSON.parse(git('show', `${sha}:package.json`)).version !== tag.slice(1)) throw new Error('Invalid existing release reservation.');
      return { tag, sha };
    }
    const version = nextVersion(current, tags);
    const tag = `v${version}`;
    packageData.version = version;
    lockData.version = version;
    lockData.packages[''].version = version;
    fs.writeFileSync(packageFile, JSON.stringify(packageData, null, 2) + '\n');
    fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2) + '\n');
    git('add', '--', 'package.json', 'package-lock.json');
    // Release-only commit: main and the merged source remain untouched.
    git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '--allow-empty', '-m', `Release ${tag}\n\n${marker}`);
    const sha = git('rev-parse', 'HEAD');
    git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'tag', '-a', tag, '-m', `Offgrid ${version}\n\n${marker}`);
    beforePush({ tag, sha });
    try {
      // The server atomically reserves a unique version. Never force a tag.
      git('push', remote, `refs/tags/${tag}:refs/tags/${tag}`);
      return { tag, sha };
    } catch (error) {
      const published = git('ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
      if (published.split('\n').some(line => line === `${sha}\trefs/tags/${tag}^{}`)) return { tag, sha };
      if (!published) throw error; // Authentication/network errors are not collisions.
      git('tag', '-d', tag); // Only discard the losing tag created in this attempt.
      git('checkout', '--detach', source);
      git('fetch', remote, '--tags');
    }
  }
  throw new Error('Could not reserve a release version after 10 concurrent attempts.');
}

function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let release;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
    if (event.pull_request?.merged !== true || event.pull_request.base?.ref !== 'main') throw new Error('Only merged PRs targeting main can release.');
    release = prepareRelease({ source: event.pull_request.merge_commit_sha });
  } else {
    const ref = process.env.GITHUB_REF || '';
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    if (!VERSION.test(version)) throw new Error('A stable package version is required.');
    const tag = ref.startsWith('refs/tags/') ? ref.slice(10) : '';
    if (tag && tag !== `v${version}`) throw new Error('Tag must match package.json version.');
    release = { tag, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${release.tag}\nsha=${release.sha}\npublish=${Boolean(release.tag)}\n`);
  console.log(release.tag ? `Prepared ${release.tag} at ${release.sha}` : `Build-only run at ${release.sha}`);
}
if (require.main === module) main();
module.exports = { nextVersion, prepareRelease };
