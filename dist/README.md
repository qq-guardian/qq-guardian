# dist/ — Generated Distribution Artefacts

## Source of Truth

All source code lives under **`src/`** and **`webui/`**.  The files in this
directory are **generated output** — they are never edited directly.

## Why `dist/` Is Committed

This project is loaded by NapCat as a plugin at runtime.  NapCat resolves
the plugin entry-point from `dist/index.mjs` and the WebUI from
`dist/webui/`.  Because NapCat installs plugins directly from the GitHub
repository (not from a package registry), the compiled output must be present
on `main` so that `npm install qq-guardian/qq-guardian` works without a
separate build step.

The committed `dist/` therefore serves as the **install distribution surface**,
not an intermediate build cache.

## Authoritative Build and Sync

| Command | Effect |
|---------|--------|
| `pnpm run build` | Compiles `src/` → `dist/` via esbuild and copies WebUI assets |
| `pnpm run test:tooling` | Verifies that the committed `dist/` is byte-for-byte identical to a fresh build |

The CI pipeline enforces synchronisation: a PR whose `dist/` diverges from a
fresh `pnpm run build` will fail `test:tooling`.

## What Must Not Be Done

- **Do not hand-edit any file in `dist/`.**  Changes will be silently
  overwritten by the next build.
- **Do not commit stale `dist/` output.**  Always run `pnpm run build` and
  commit the result as part of the same change that modifies `src/` or
  `webui/`.

## Rotation / Upgrade Path

If the project ever moves to a package-registry distribution model (e.g.
publishing to npm), the committed `dist/` can be removed from the repository
and added to `.gitignore`.  The `test:tooling` synchronisation check would
then be replaced by a CI publish step.  Document that decision in `CHANGELOG.md`
and remove this file at the same time.

## File Inventory

| Path | Source | Description |
|------|--------|-------------|
| `dist/index.mjs` | `pnpm run build` (esbuild) | Plugin entry-point bundle |
| `dist/package.json` | Copied from `src/` or root | Minimal package descriptor for NapCat |
| `dist/plugin.json` | Copied from repository root | NapCat plugin manifest |
| `dist/plugin-icon.png` | Copied from repository root | Plugin icon |
| `dist/webui/` | Copied from `webui/` | Management WebUI static assets |
