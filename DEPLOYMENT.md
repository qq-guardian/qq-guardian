# QQ Guardian Production Deployment

This document describes the production distribution model introduced by the
release-system rebuild. The application source remains under `src/`; release
archives are generated from `dist-snowluma/` and contain their own Node.js
runtime, launchers, configuration examples, logs directory, updater, verifier,
and documentation.

## Release artifacts

Every release publishes:

- `qq-guardian-vX.Y.Z-win-x64.zip`
- `qq-guardian-vX.Y.Z-linux-x64.tar.gz`
- `SHA256SUMS.txt`
- GitHub artifact provenance attestations

The archives are self-contained. They are not a ZIP of `dist/` and do not
contain `node_modules`, development files, credentials, databases, or local
logs.

SnowLuma's own release model similarly builds platform archives from a
validated runtime layout and publishes platform-specific assets. QQ Guardian
uses that model as an engineering reference without redistributing SnowLuma's
proprietary native components.

## Local production build

Requirements: Node.js 22.13+ and pnpm 10.17.1.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm release
```

On Windows x64, `pnpm release` creates the Windows archive. On Linux x64 it
creates the Linux archive. CI creates both on their native runners.

## Linux installation

A released Linux archive can be installed without Node.js or pnpm:

```sh
./install.sh --yes
./verify.sh
./launcher.sh
```

The default installation root is:

```
~/.local/opt/qq-guardian/
├── current -> releases/<version>
├── releases/
├── data/
├── config/
└── logs/
```

Application versions are replaceable; `data/`, `config/`, and `logs/`
are persistent state and are not removed by a normal upgrade.

For systemd:

```sh
mkdir -p ~/.config/systemd/user
cp service/qq-guardian.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now qq-guardian.service
```

## Updating and rollback

Install a specific release without deleting persistent state:

```sh
QQ_GUARDIAN_VERSION=vX.Y.Z ./install.sh --yes
```

The installer verifies the release archive's SHA-256 before extraction.

The release layout is versioned so rollback does not require rebuilding:

```sh
ls ~/.local/opt/qq-guardian/releases/
ln -sfn ~/.local/opt/qq-guardian/releases/vX.Y.Z ~/.local/opt/qq-guardian/current
```

Do **not** use `docker compose down -v` for a normal Docker upgrade; that
explicitly deletes named volumes. Docker volumes are the persistence boundary
for container deployments.

## Docker

The repository root is the canonical Docker entry point:

```sh
docker compose up -d
```

No `.env` file is required for the default local stack. Override values with
environment variables when necessary, for example:

```sh
QQ_GUARDIAN_ACCEPT_LICENSE=1
QQ_GUARDIAN_NON_INTERACTIVE=1
QQ_GUARDIAN_AUTO_START=true
```

The Guardian container stores application state in named volumes and runs with
no Linux capabilities, `no-new-privileges`, a read-only root filesystem, and
only explicit writable data/config/log volumes.

Docker Compose's `include` mechanism is available for modular configurations,
but the root `docker-compose.yml` is intentionally self-contained so
`docker compose up -d` is deterministic for this repository.

## Security and supply-chain controls

Release workflows:

1. install with the committed lockfile;
2. run lint, typecheck, and tests;
3. build the application;
4. build the platform package on the native runner;
5. verify the archive layout;
6. generate SHA-256 checksums;
7. publish GitHub Release assets;
8. generate provenance attestations.

GitHub's current artifact-attestation model uses OIDC-backed provenance and
requires `id-token: write`, `contents: read`, and `attestations: write` for
binary attestations. Container attestations additionally require
`packages: write`.

## SnowLuma boundary

QQ Guardian's standalone runtime connects to an existing SnowLuma instance
through its configured OneBot transport. This repository does not copy
SnowLuma native binaries into QQ Guardian release archives.

For the official SnowLuma Docker distribution, see the upstream Docker
framework and its documented release-artifact consumption model.
