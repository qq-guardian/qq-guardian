import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const request = readFileSync(join(ROOT, '.github/workflows/release-request.yml'), 'utf8');
const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
const releaseGuide = readFileSync(join(ROOT, 'docs/operations/release.md'), 'utf8');

describe('release workflow governance', () => {
  it('uses an immutable expected SHA and a CI-gated focused version PR', () => {
    assert.match(request, /expected_sha:/);
    assert.match(request, /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/);
    assert.match(request, /\^\[0-9a-f\]\{40\}\$/);
    assert.match(request, /"--expected-sha=\$EXPECTED_SHA"/);
    assert.doesNotMatch(request, /--expected-sha=\$\{\{ inputs\.expected_sha \}\}/);
    assert.match(request, /branch: release\/version-/);
    assert.match(request, /gh pr merge --auto --squash/);
    assert.match(request, /^permissions: \{\}$/m);
  });

  it('uses a dedicated event-producing token for version PR writes and auto-merge', () => {
    assert.match(request, /secrets\.RELEASE_AUTOMATION_TOKEN/);
    assert.match(request, /token: \$\{\{ secrets\.RELEASE_AUTOMATION_TOKEN \}\}/);
    assert.match(request, /GH_TOKEN: \$\{\{ secrets\.RELEASE_AUTOMATION_TOKEN \}\}[\s\S]*?gh pr merge --auto --squash/);
    assert.match(request, /GITHUB_TOKEN cannot trigger downstream release workflows/);
    assert.match(releaseGuide, /fine-grained PAT or GitHub App\s+token/);
    assert.match(releaseGuide, /Do not set it to `GITHUB_TOKEN`/);
  });

  it('allows publication only after the gated version PR merges', () => {
    assert.doesNotMatch(release, /^\s*push:\s*$/m);
    assert.match(
      release,
      /github\.event\.pull_request\.merged == true[\s\S]*?startsWith\(github\.event\.pull_request\.head\.ref, 'release\/version-'\)[\s\S]*?head\.repo\.full_name == github\.repository/,
    );
    assert.match(release, /if \[\[ "\$EVENT_NAME" == pull_request \]\]; then/);
    assert.doesNotMatch(release, /EVENT_NAME" == push/);
    assert.doesNotMatch(release, /PUSH_TAG|PUSH_SHA/);
  });

  it('resolves a manual source ref once and validates a matching dry-run version', () => {
    assert.match(release, /if: github\.event_name == 'workflow_dispatch'[\s\S]*?ref: \$\{\{ inputs\.source_ref \}\}/);
    assert.match(release, /source_sha="\$\(git rev-parse HEAD\)"/);
    assert.match(release, /source_ref="\$source_sha"/);
    assert.doesNotMatch(release, /source_sha=""/);
    assert.match(release, /X\.Y\.Z must match package\.json at source_ref/);
    assert.match(releaseGuide, /core version exactly matches `package\.json`/);
    assert.match(releaseGuide, /require\('\.\/package\.json'\)\.version \+ '-test\.1'/);
    assert.doesNotMatch(releaseGuide, /v1\.3\.1-test\.1/);
    assert.match(release, /publish.*true[\s\S]*?tag.*!=.*v\$version[\s\S]*?Test tags are dry-run only/);
  });

  it('builds generated targets before running release-layout tests and permits safe tag retries', () => {
    const gates = release.match(/- name: Run required release gates[\s\S]*?(?=\n\s+- name:)/)?.[0] ?? '';
    assert.ok(gates.indexOf('pnpm run build') < gates.indexOf('pnpm run test:ci'));
    assert.match(release, /existing_sha=.*commits\/\$RELEASE_TAG.*--jq \.sha/);
    assert.match(release, /existing_sha.*!=.*SOURCE_SHA/);
    assert.match(release, /already resolves to the gated source; reusing it/);
    assert.match(release, /HTTP 404/);
  });

  it('keeps a release draft until every expected asset is repairably uploaded', () => {
    const prepareDraft = release.match(/- name: Prepare resumable draft GitHub Release[\s\S]*?(?=\n\s+- name:)/)?.[0] ?? '';
    assert.match(prepareDraft, /gh api --method POST "repos\/\$GITHUB_REPOSITORY\/releases"/);
    assert.match(prepareDraft, /-f "tag_name=\$RELEASE_TAG"/);
    assert.match(prepareDraft, /-f "name=\$RELEASE_TAG"/);
    assert.match(prepareDraft, /-F draft=true/);
    assert.match(prepareDraft, /-F generate_release_notes=true/);
    assert.match(prepareDraft, /--jq '\[\.\]' > "\$response_file"/);
    assert.equal((prepareDraft.match(/find_release > "\$response_file"/g) ?? []).length, 1);
    assert.doesNotMatch(prepareDraft, /gh release create/);
    assert.match(release, /Reusing existing draft release for safe retry/);
    assert.match(release, /gh release upload "\$RELEASE_TAG"[\s\S]*?--clobber/);
    assert.match(release, /expected-assets\.txt[\s\S]*?remote-assets\.txt[\s\S]*?diff -u/);
    assert.match(release, /gh api --method PATCH "repos\/\$GITHUB_REPOSITORY\/releases\/\$RELEASE_ID"/);
    assert.doesNotMatch(release, /softprops\/action-gh-release/);
  });

  it('finds drafts with an authenticated listing and verifies assets by numeric release id', () => {
    assert.match(release, /gh api --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100"/);
    assert.match(release, /jq --arg tag "\$RELEASE_TAG" '\[\.\[\]\[\] \| select\(\.tag_name == \$tag\)\]'/);
    assert.match(release, /release_count[\s\S]*?!= 1[\s\S]*?draft[\s\S]*?!= true/);
    assert.match(release, /echo "release_id=\$release_id" >> "\$GITHUB_OUTPUT"/);
    assert.match(release, /RELEASE_ID: \$\{\{ steps\.draft-release\.outputs\.release_id \}\}/);
    assert.match(release, /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/\$RELEASE_ID"/);
    assert.match(release, /PATCH "repos\/\$GITHUB_REPOSITORY\/releases\/\$RELEASE_ID"[\s\S]*?-F draft=false/);
    assert.match(release, /all\(\.state == "uploaded"\)/);
    assert.doesNotMatch(release, /releases\/tags\/\$RELEASE_TAG/);
    assert.doesNotMatch(release, /gh release edit/);
    assert.doesNotMatch(release, /\bsleep\b/);
  });

  it('mirrors the SnowLuma platform matrix and emits a complete compatibility ZIP', () => {
    for (const platform of ['win32-x64', 'linux-x64', 'linux-arm64']) {
      assert.match(release, new RegExp(`platform: ${platform}`));
    }
    assert.match(release, /--compatibility-asset/);
    assert.match(release, /releaseDownload\.zip|compatibility ZIP/);
    assert.match(release, /pnpm install --frozen-lockfile/);
    assert.match(release, /package:providers:versioned/);
    assert.match(release, /package:project:lite/);
    assert.match(release, /SHA256SUMS/);
    assert.match(release, /attest-build-provenance@[a-f0-9]{40}/);
  });

  it('pins every third-party action and promotes the exact published source without an event loopback', () => {
    for (const workflow of [request, release]) {
      const actionRefs = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
      assert.ok(actionRefs.length > 0);
      for (const action of actionRefs) {
        if (action.startsWith('./')) continue;
        assert.match(action, /@[a-f0-9]{40}$/, `action must be commit-pinned: ${action}`);
      }
      assert.doesNotMatch(workflow, /pull_request_target:/);
    }
    assert.match(release, /promote:[\s\S]*?needs:[\s\S]*?- metadata[\s\S]*?- publish/);
    assert.match(release, /uses: \.\/\.github\/workflows\/deploy\.yml/);
    assert.match(release, /tag: \$\{\{ needs\.metadata\.outputs\.tag \}\}/);
    assert.match(release, /source_sha: \$\{\{ needs\.metadata\.outputs\.source_sha \}\}/);
    assert.match(release, /Deployment handoff: a successful publication continues into the promotion job/);
    assert.match(release, /cancel-in-progress: false/);
    assert.equal((release.match(/node-version: 22\.23\.2/g) ?? []).length, 2);
    assert.equal((request.match(/node-version: 22\.23\.2/g) ?? []).length, 1);
  });
});
