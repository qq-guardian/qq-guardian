# CI security and repository governance

The `CI` workflow publishes eight stable job names intended to become required
checks on `main`: `quality`, `unit`, `contract-snowluma`, `contract-napcat`,
`integration`, `security`, `production-build`, and `artifact-validation`.
Renaming one is a governance change and requires updating the policy module,
tests, documentation, and branch protection together.

## Local parity

Use Node 22 and the pnpm version declared by `packageManager`. Start from a clean
checkout, then run:

```console
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:unit
pnpm run verify:contracts:snowluma
pnpm run verify:contracts:napcat
pnpm run build
pnpm run test:integration
pnpm run test:tooling
pnpm run verify:manifests
pnpm run package:archives
pnpm run verify:ci-governance
pnpm audit --prod --audit-level=high
git diff --exit-code -- dist
```

The `production-build` gate produces both provider targets and their checksummed
archives once. `artifact-validation` downloads that exact SHA-named artifact in
a separate job and re-runs manifest, archive-layout, and checksum verification.
The release workflow owns the broader source-complete `releaseDownload.zip`
contract; CI deliberately validates its own outputs without assembling a second
release bundle.

Gitleaks, dependency review, and CodeQL depend on GitHub runner services and run
inside the `security` gate. CodeQL scans source directories only; generated
bundles and release archives are excluded by `.github/codeql/codeql-config.yml`.

## Supply-chain policy

Every third-party action is pinned to a reviewed full commit SHA. The trailing
version comment is informational and must never replace the SHA. Dependabot opens
weekly pull requests for GitHub Actions and pnpm dependencies. Review an action's
upstream release and source diff before accepting a new pin, then update the
allowlist in `scripts/lib/ci-governance.mjs` in the same pull request.

The production dependency audit fails on high or critical advisories. Dependency
review blocks pull requests that introduce high or critical advisories. Gitleaks
scans full repository history, and CodeQL uploads JavaScript/TypeScript results to
GitHub code scanning. Workflow permissions default to none and are granted per
job; only the security gate receives `security-events: write`.

## Branch-protection rollout

Do not configure required checks from a feature branch. First merge the workflow
through normal review and wait for all eight named gates to pass on `main`. This
ordering prevents `main` from requiring check names that GitHub has never seen.

After `main` is green, an administrator can verify policy without changing it.
This repository is intentionally single-maintainer, so its commands must opt in
explicitly with `--single-maintainer`:

```console
GH_TOKEN=<administration-read-token> pnpm run governance:verify -- --repo ShiYuPIay/qq-guardian --branch main --single-maintainer
```

Applying policy requires repository administration write access and an explicit
acknowledgement that the merged workflow passed on `main`:

```console
GH_TOKEN=<administration-write-token> pnpm run governance:apply -- --repo ShiYuPIay/qq-guardian --branch main --single-maintainer --confirm-after-main-green
```

The command reads current policy first, performs no write when it is already
compliant, applies the reviewed policy only when drift exists, enables required
commit signatures, and verifies the result. Never store the token in the
repository or shell history.

By default, `governance:apply` and `governance:verify` retain the multi-maintainer
review contract: one approving review plus approval after the latest push. The
`--single-maintainer` flag is an explicit opt-in that changes only those two
review requirements to zero required approvals and no last-push approval while
still requiring pull requests. For QQ Guardian, all eight strict status checks,
stale-review dismissal, resolved review conversations, linear history, signed
commits, administrator enforcement, and the force-push/deletion protections
remain unchanged.

If a required gate is unavailable, restore the workflow or temporarily adjust
policy through an audited administrator change. Do not rename or bypass a gate
to make a failing pull request mergeable.
