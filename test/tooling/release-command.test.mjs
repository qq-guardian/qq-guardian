import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { bumpVersion, prepareRelease, requestRelease } from '../../scripts/release.mjs';

const root = mkdtempSync(join(tmpdir(), 'qq-guardian-release-command-'));
const git = process.env.GIT_EXECUTABLE || 'git';
after(() => rmSync(root, { recursive: true, force: true }));

describe('guarded release version preparation', () => {
  it('calculates patch, minor, and major versions', () => {
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
    assert.throws(() => bumpVersion('1.2.3-rc.1', 'patch'), /stable SemVer/);
  });

  it('updates every tracked release manifest only from a clean synchronized main', () => {
    const fixture = createRepository('success');
    const result = prepareRelease({ root: fixture.repository, bump: 'minor', git });
    assert.equal(result.nextVersion, '1.4.0');
    for (const name of ['package.json', 'plugin.json', 'dist/package.json', 'dist/plugin.json']) {
      assert.equal(JSON.parse(readFileSync(join(fixture.repository, name), 'utf8')).version, '1.4.0');
    }
  });

  it('fails closed for a dirty tree, wrong branch, unsynchronized main, and conflicting tag', () => {
    const dirty = createRepository('dirty');
    writeFileSync(join(dirty.repository, 'untracked.txt'), 'dirty\n');
    assert.throws(
      () => prepareRelease({ root: dirty.repository, bump: 'patch', dryRun: true, git }),
      /Working tree is dirty/,
    );

    const branch = createRepository('branch');
    gitRun(branch.repository, ['switch', '-c', 'feature/not-main']);
    assert.throws(
      () => prepareRelease({ root: branch.repository, bump: 'patch', dryRun: true, git }),
      /must be prepared from main/,
    );

    const behind = createRepository('behind');
    const second = join(root, 'behind-second');
    gitRun(root, ['clone', behind.remote, second]);
    gitRun(second, ['config', 'user.email', 'release-test@example.invalid']);
    gitRun(second, ['config', 'user.name', 'Release Test']);
    writeFileSync(join(second, 'remote-change.txt'), 'remote\n');
    gitRun(second, ['add', 'remote-change.txt']);
    gitRun(second, ['commit', '-m', 'remote change']);
    gitRun(second, ['push', 'origin', 'main']);
    assert.throws(
      () => prepareRelease({ root: behind.repository, bump: 'patch', dryRun: true, git }),
      /not synchronized/,
    );

    const tagged = createRepository('tagged');
    gitRun(tagged.repository, ['tag', 'v1.3.1']);
    gitRun(tagged.repository, ['push', 'origin', 'v1.3.1']);
    assert.throws(
      () => prepareRelease({ root: tagged.repository, bump: 'patch', dryRun: true, git }),
      /already exists/,
    );
  });

  it('dispatches the immutable main SHA and refuses a concurrent release request', () => {
    const fixture = createRepository('dispatch');
    const calls = [];
    const result = requestRelease({
      root: fixture.repository,
      bump: 'patch',
      git,
      listOpenRequests: () => [],
      dispatch: (request) => calls.push(request),
    });
    assert.equal(result.nextVersion, '1.3.1');
    assert.match(result.commitSha, /^[a-f0-9]{40}$/);
    assert.deepEqual(calls, [{
      bump: 'patch',
      expectedSha: result.commitSha,
      nextVersion: '1.3.1',
    }]);

    assert.throws(() => requestRelease({
      root: fixture.repository,
      bump: 'patch',
      git,
      listOpenRequests: () => ['https://github.example/release/1'],
      dispatch: () => assert.fail('concurrent release must not dispatch'),
    }), /open release request already exists/);

    assert.throws(() => prepareRelease({
      root: fixture.repository,
      bump: 'patch',
      dryRun: true,
      git,
      expectedSha: '0'.repeat(40),
    }), /Release request expected/);
  });
});

function createRepository(name) {
  const remote = join(root, `${name}-remote.git`);
  const repository = join(root, `${name}-repo`);
  gitRun(root, ['init', '--bare', remote]);
  mkdirSync(repository, { recursive: true });
  gitRun(repository, ['init', '-b', 'main']);
  gitRun(repository, ['config', 'user.email', 'release-test@example.invalid']);
  gitRun(repository, ['config', 'user.name', 'Release Test']);
  mkdirSync(join(repository, 'dist'), { recursive: true });
  for (const file of ['package.json', 'plugin.json', 'dist/package.json', 'dist/plugin.json']) {
    writeFileSync(join(repository, file), `${JSON.stringify({ name: 'fixture', version: '1.3.0' }, null, 2)}\n`);
  }
  gitRun(repository, ['add', '.']);
  gitRun(repository, ['commit', '-m', 'initial']);
  gitRun(repository, ['remote', 'add', 'origin', remote]);
  gitRun(repository, ['push', '-u', 'origin', 'main']);
  gitRun(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { remote, repository };
}

function gitRun(cwd, args) {
  const result = spawnSync(git, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}
