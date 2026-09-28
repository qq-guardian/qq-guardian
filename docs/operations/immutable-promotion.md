# Immutable staging-to-production promotion

The release pipeline builds the SnowLuma-capable repository bundle and its
container image once for each stable version. The immutable image is addressed
by the `vX.Y.Z` tag and its OCI digest; staging and production only move aliases
to a verified digest. A production job cannot run unless the successful staging
record has the same version, source commit, `releaseDownload.zip` checksum,
image reference, and image digest.

`releaseDownload.zip` is the full deployable repository payload. It contains
the source tree, tests, CI/environment definitions, deployment assets, both
provider builds, and the platform Node runtime. It intentionally omits `.git`,
dependency trees, local state, credentials, and generated release directories.

## Release identity and deployment entry points

A normal deployment begins from the GitHub `release.published` event through
`.github/workflows/deploy-release.yml`. The wrapper resolves the stable tag to
an exact commit SHA and invokes the reusable deployment workflow with that
immutable identity.

The reusable workflow independently authenticates the same identity before any
image is built or promoted. It requires all of the following:

- a stable `vX.Y.Z` tag whose version matches `package.json`;
- an already-published GitHub Release that is neither draft nor prerelease;
- the release tag resolving to the exact requested 40-character source SHA;
- the checked-out source matching that SHA; and
- a merged `release/version-X.Y.Z` pull request into `main` associated with that
  source commit.

The manual dispatch entry point is therefore a recovery mechanism only. It
cannot deploy an arbitrary commit that merely carries a matching version.

## Resumable immutable publication

A workflow retry never overwrites an unrelated versioned image. If
`ghcr.io/<owner>/<repo>:vX.Y.Z` already exists, the workflow reads its immutable
digest and validates the OCI source-revision and version labels. It reuses the
image only when those labels exactly match the authenticated release source and
tag. A mismatch fails closed. Registry failures that cannot be distinguished
from an actually missing image also fail closed instead of assuming the tag is
safe to recreate.

The versioned `guardian-image-vX.Y.Z.json` release manifest follows the same
rule. A retry may reuse an existing manifest only after schema validation and
an exact comparison of version, source SHA, release checksum, image reference,
and image digest. A conflicting manifest aborts deployment. Promotion artifacts
include both the Actions run ID and run attempt so a retry cannot collide with
the previous attempt.

## Configure GitHub environments

The workflow uses GitHub environments named `staging` and `production`. Apply
the checked-in policy with an administrator token after the deployment workflow
is merged. The production reviewer IDs must be supplied explicitly; no reviewer
or credential is stored in this repository.

```sh
GH_TOKEN=*** \
PRODUCTION_REVIEWER_IDS='[{"type":"User","id":123456}]' \
pnpm environments:apply -- --repo=ShiYuPIay/qq-guardian

GH_TOKEN=*** \
pnpm environments:verify -- --repo=ShiYuPIay/qq-guardian
```

Both environments require protected branches. Production additionally requires
at least one reviewer and prevents self-review. Environment protection is kept
outside workflow YAML so a missing repository-level approval rule is detected
rather than silently accepted.

## Promotion and rollback

After release identity verification, the reusable deployment workflow verifies
the attested `releaseDownload.zip`, builds or safely resumes the one versioned
GHCR image, records its digest, runs the staging provider/container smoke matrix,
and pauses at the production environment gate. Production repeats the smoke
against that exact digest and records the previous version/digest, result,
timestamps, and smoke checks.

Run **Emergency rollback** from Actions with `target=previous` for the most
recent distinct successful production image, or provide an explicit `vX.Y.Z`
still present in the bounded history. The workflow downloads the existing
production record and image manifest, verifies the digest, runs the same
container smoke, then moves only the `production` alias. It does not build,
install, or publish an image. A failed alias update attempts to restore the
recorded previous digest, and the rollback record is attached to the target
GitHub Release.

The workflow reports external user-owned NapCat/SnowLuma hosts as **not
executed**. GHCR and GitHub environments are the central distribution and
approval boundary; operators may use the same immutable digest on their own
hosts after the promotion record is green.
