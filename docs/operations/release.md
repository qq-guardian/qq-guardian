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
production.

The release contains **Guardian artifacts**, not a republished SnowLuma binary
distribution:

- versioned NapCat runtime ZIP/TAR.GZ pairs;
- source-complete lite project ZIP/TAR.GZ pair;
- full Windows x64, Linux x64, and Linux arm64 Guardian project ZIP/TAR.GZ pairs with matching Node.js runtime;
- platform-specific `qq-guardian-snowluma-installer-vX.Y.Z-<platform>` integration archives;
- per-archive `.sha256` files, aggregate `SHA256SUMS`, generated release notes, and provenance attestations.

The SnowLuma integration archives contain Guardian runtime, the installer/supervisor
scripts, the exact upstream release manifest, and the official asset checksum/size.
They **do not contain SnowLuma proprietary native binaries**.

The release CI checks the live SnowLuma Release metadata against
`UPSTREAM-SNOWLUMA.json`, including the official full-package filenames and
byte sizes and the published SHA-256 digest when GitHub exposes it. The CI does
not download and republish the upstream binary package.

To obtain a deployable SnowLuma installation:

1. Download the exact FULL package from the official SnowLuma Release.
2. Download the matching QQ Guardian integration installer.
3. Run the platform installer with the official package as its explicit input.
4. The installer verifies the upstream filename, size, SHA-256 and required native layout before installation.
5. Unattended native installation registers a persistent systemd service on Linux or a Windows Scheduled Task; QR/interactive QQ login remains an operator action.

This separation is intentional because SnowLuma's current EULA places a specific
authorization boundary on third-party redistribution of its proprietary native
components.

Every Guardian archive excludes `.git`, dependency trees, local `.env`
files, credentials, databases, logs, source maps, and generated release
directories. Run `pnpm run release:verify` against assembled Guardian assets
before publication.

The native Guardian launchers accept an external environment file without
executing it as shell code:

```sh
deploy/native/start-bundled-guardian.sh /etc/qq-guardian/guardian.env
```

```powershell
deploy\\native\\start-bundled-guardian.ps1 -EnvironmentFile C:\ProgramData\QQGuardian\guardian.env
```

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
