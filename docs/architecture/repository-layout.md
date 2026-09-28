# Repository layout

QQ Guardian keeps production code, tests, deployment assets, generated
artifacts, and operational documentation in separate responsibility-based
directories. This layout supports both the NapCat plugin package and the
standalone SnowLuma runtime without duplicating business logic. The canonical
cross-cutting references are the root [ARCHITECTURE.md](../../ARCHITECTURE.md)
and [DEPLOYMENT.md](../../DEPLOYMENT.md).

```text
.
├─ src/                         production TypeScript source
├─ test/                        unit, integration, and tooling tests
├─ scripts/                     build, packaging, verification, and test tools
├─ webui/                       WebUI source assets
├─ deploy/                      SnowLuma and native deployment assets
├─ ARCHITECTURE.md              provider and transport architecture contract
├─ DEPLOYMENT.md                release, deployment, and rollback runbook
├─ docs/                        detailed architecture and deployment documentation
├─ intel/feed.json              published Intel feed document
├─ dist/                        committed NapCat installation artifact
└─ dist-snowluma/               generated standalone runtime artifact
```

## Directory responsibilities

| Path | Responsibility |
| --- | --- |
| `src/` | Runtime code, application services, adapters, ports, migrations, and type definitions. Production code never imports from `test/`. |
| `test/unit/` | Isolated behavior tests for source modules. |
| `test/integration/` | Tests that exercise build artifacts, database migration, router, and runtime boundaries. |
| `test/tooling/` | Tests for packaging, release allowlists, and deployment assets. |
| `scripts/` | Development and release automation. `scripts/build.mjs` creates both runtime targets. |
| `webui/` | Source WebUI document copied into each generated runtime artifact. |
| `deploy/` | Compose, container, native, and panel assets shipped with the SnowLuma release bundle. |
| `docs/architecture/` | Current technical contracts and data-migration behavior. |
| `docs/deployment/` | Operator-facing installation, backup, migration, and recovery instructions. |
| `ARCHITECTURE.md` | Canonical provider positioning, transport matrix, and runtime boundary. |
| `DEPLOYMENT.md` | Canonical release assets, CI/CD flow, environment gates, and rollback runbook. |
| `intel/feed.json` | Publicly published Intel feed used by the default remote URL. Its path is a compatibility contract. |
| `dist/` | NapCat's drop-in installation artifact. It is committed and CI verifies it remains synchronized with `src/`. |
| `dist-snowluma/` and `release/` | Generated build and archive outputs. They remain untracked and are reproduced by build/package commands. |

## Deployment asset rules

`deploy/compose.yaml` and `deploy/Dockerfile` are the canonical Compose
bundle. `deploy/native/` contains shared native runtime templates, including
the single POSIX launcher used by Linux and Termux/proot. Panel-specific entry
notes remain under `deploy/baota/` and `deploy/1panel/`.

Deployment templates, environment examples, and persistent-state setup scripts
are release inputs. They must not be removed merely because they are not
imported by TypeScript.

## Change rules

- Move files with Git-aware renames and update every known consumer in the
  same change.
- Remove a tracked file only after confirming that production code, tests,
  documentation, release policy, and user deployment paths no longer consume
  it.
- Keep public asset paths and persistent data locations stable unless a
  versioned migration or replacement path exists.
- Do not place generated artifacts, local configuration, databases, backups,
  secrets, or dependencies under source-control paths.
- Do not create dated design, status, or change-log directories for current
  architecture documentation.

## Verification

Every repository-layout change must pass:

```text
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:ci
pnpm run package:all
git diff --check
```

The release verification must continue to prove that NapCat and SnowLuma
archives contain only their approved runtime and deployment files.
