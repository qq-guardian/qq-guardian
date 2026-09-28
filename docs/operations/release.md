# Release operations

QQ Guardian releases are requested locally, versioned through a focused pull
request, and built on GitHub from the merged immutable commit. After publication,
the release workflow directly hands the exact tag and commit to the reusable
promotion workflow. Publication still does not imply that staging or production
succeeded; each environment keeps its own deployment gate and record.

## Request a version

Start from a clean, synchronized `main` checkout with GitHub CLI authenticated:

```sh
pnpm release                 # interactive patch/minor/major choice
pnpm release patch           # non-interactive patch request
pnpm release minor
pnpm release major
pnpm release patch --dry-run # preflight without dispatch
```

The command fetches `origin/main` and tags, rejects a dirty/wrong/behind/ahead
checkout, validates every version manifest, rejects an existing target tag and
an open `release/version-*` request, then dispatches `release-request.yml` with
the exact approved main SHA. It never reads a production secret or edits the
local checkout.

GitHub creates `release/version-X.Y.Z`, rebuilds the committed NapCat `dist/`,
runs tooling verification, and enables squash auto-merge. Required branch
checks and review policy remain authoritative.

Repository administrators must configure `RELEASE_AUTOMATION_TOKEN` before
dispatching a release request. It must be a fine-grained PAT or GitHub App
token for a dedicated automation identity with repository Contents and Pull
requests read/write access. Do not set it to `GITHUB_TOKEN`: GitHub suppresses
the downstream pull-request and merge events produced by that token, which
would prevent CI and release publication from starting. The automation token
only creates the focused version PR and enables auto-merge; it does not bypass
required checks or approvals.

## Published assets

After the version PR merges, the release workflow creates `vX.Y.Z` only after
all release gates pass, then promotes that immutable release through staging and
production. It publishes deterministic, checksummed archives:

- versioned NapCat runtime and self-contained SnowLuma ZIP/TAR.GZ pairs;
- byte-identical unversioned NapCat and SnowLuma compatibility pairs, including
  the filenames used by existing installation instructions;
- a source-complete lite project ZIP/TAR.GZ pair;
- full Windows x64, Linux x64, and Linux arm64 project ZIP/TAR.GZ pairs with
  the matching Node.js executable and license;
- `releaseDownload.zip`, a compatibility alias of the versioned Windows x64
  full bundle, containing the repository payload (including `.github` CI and
  environment definitions, tests, source/build/deployment files), both
  provider outputs, environment examples, and the embedded runtime;
- per-archive `.sha256` files, aggregate `SHA256SUMS`, generated release notes,
  and GitHub artifact provenance attestations.

Every archive excludes `.git`, dependency trees, local `.env` files,
credentials, databases, logs, source maps, and generated release directories.
The lite archive also excludes CI definitions and tests; full archives retain
those auditable repository files. Run `pnpm run release:verify` against
assembled assets before publication.

The bundled native launchers accept an external environment file without
executing it as shell code:

```sh
deploy/native/start-bundled-guardian.sh /etc/qq-guardian/guardian.env
```

```powershell
deploy\native\start-bundled-guardian.ps1 -EnvironmentFile C:\ProgramData\QQGuardian\guardian.env
```

`QQ_GUARDIAN_ENV_FILE` is also supported. If neither form is supplied, the
launcher loads `deploy/native/guardian.env` when that file exists. Keep the
environment file and persistent data outside a replaceable extracted bundle in
production.

## Dry run

Run **Build and release** manually with a `source_ref` and a test label whose
core version exactly matches `package.json` at that ref. For example, derive
the label from the checkout instead of copying a stale version:

```sh
node -p "'v' + require('./package.json').version + '-test.1'"
```

The metadata job resolves `source_ref` to one commit SHA before any downstream
job starts. The workflow then executes the same gates and archive matrix,
uploads short-lived assets, and does not create a tag or GitHub Release.
