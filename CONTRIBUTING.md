# Contributing to QQ Guardian

## Prerequisites

- **Node.js ≥ 22.6.0** — the same major version used in CI (`22.23.2`).
- **pnpm 10.17.1** — exact version is enforced by `packageManager` in
  `package.json`. Install via Corepack: `corepack enable && corepack pnpm@10.17.1 install`.

## Package registry

All dependencies — including `@snowluma/sdk` — are published to the public
**npm registry** (`https://registry.npmjs.org`). No private registry or
special `.npmrc` is required. `pnpm install --frozen-lockfile` fetches every
package from the default npm registry and the resolved integrity hashes in
`pnpm-lock.yaml` guarantee reproducible installs.

If `pnpm install --frozen-lockfile` fails with a registry or ENOENT error,
confirm your network can reach `registry.npmjs.org` and that no corporate
npm proxy is intercepting TLS.

## Setup

```bash
git clone https://github.com/ShiYuPIay/qq-guardian.git
cd qq-guardian
corepack pnpm@10.17.1 install --frozen-lockfile
```

## Build

```bash
pnpm run build          # type-checks and produces dist/ and dist-snowluma/
pnpm run build:watch    # incremental watch mode
```

The build outputs two self-contained ESM bundles:

| Target | Entry | Output |
| --- | --- | --- |
| NapCat plugin | `src/index.ts` | `dist/index.mjs` |
| SnowLuma standalone | `src/snowluma.ts` | `dist-snowluma/index.mjs` |

`dist/` is committed to the repository so that NapCat can load the plugin
directly from a checkout. The CI `production-build` job enforces that the
committed `dist/` is always in sync with a clean build (`git diff --exit-code -- dist`).
Always run `pnpm run build` and commit any changed `dist/` files together with
the corresponding source change.

## Testing

```bash
pnpm test               # unit tests (fast, no build required)
pnpm run test:unit      # same
pnpm run test:integration   # requires a prior `pnpm run build`
pnpm run test:tooling   # script/config policy tests
pnpm run test:ci        # all scopes with spec reporter (matches CI)
```

## Type checking and linting

```bash
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # code style checks
pnpm run format:check   # formatting checks
```

## Verifying manifests and contracts

```bash
pnpm run verify:manifests           # plugin.json / package.json consistency
pnpm run verify:contracts:napcat    # NapCat OneBot payload contracts
pnpm run verify:contracts:snowluma  # SnowLuma OneBot payload contracts
pnpm run verify:ci-governance       # CI governance policy
pnpm run docs:check                 # internal documentation link integrity
```

## Release process

Releases are prepared by maintainers following the runbook in
[docs/operations/release.md](docs/operations/release.md). External contributors
should open a pull request; the maintainer drives the release after merging.

Releases are published from **this repository** at
`https://github.com/ShiYuPIay/qq-guardian/releases`. There is no separate
release repository.
