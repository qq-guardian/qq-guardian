# SnowLuma SDK fallback and deployment architecture

## Purpose

Make QQ Guardian's standalone SnowLuma runtime resilient to an incompatibility
or connection failure in its native WebSocket client without duplicating OneBot
actions or event delivery. Add the official `@snowluma/sdk` as a bundled,
version-pinned WebSocket fallback and make SnowLuma deployment discoverable and
safe for first-time users.

This design keeps all existing Guardian configuration and SQLite paths intact.
It changes neither Guardian's persistent schemas nor its shadow-migration
protocol.

## Verified external baseline

At design time the official SDK is `@snowluma/sdk@1.14.7`, a pure-ESM,
Node.js-22-or-newer OneBot v11 client. Its WebSocket client supports actions,
events, and reconnect; its HTTP client supports actions only. SnowLuma v1.14.7
is the current matching upstream release.

Primary sources:

- <https://snowluma.github.io/sdk/index.html>
- <https://snowluma.github.io/en/guide/configuration.html>
- <https://snowluma.github.io/en/guide/deploy/docker.html>
- <https://github.com/SnowLuma/SnowLuma/releases/tag/v1.14.7>

The package's shipped versioning material still contains older `0.x` examples.
Guardian therefore pins the exact SDK version and verifies its adapter contract
in tests instead of assuming semver compatibility from a range.

## Goals

- Keep the existing Guardian WebSocket client as the default transport.
- Select the official SDK only as a startup fallback, without creating dual
  event streams or replaying OneBot actions through a second transport.
- Bundle the pinned SDK into the standalone SnowLuma artifact; no operator
  installs `node_modules` after extracting a release.
- Preserve Guardian's transport guarantees when the SDK path is selected:
  token redaction, bounded ordered event delivery, handshake timeout, action
  timeout, and error containment.
- Add a Chinese-first, release-first SnowLuma deployment tutorial and a
  prominent README entry point.
- Cover Docker/Compose, Windows, Docker Desktop, WSL2, native Linux, Termux,
  Baota, 1Panel, upgrades, migration, rollback, and diagnostics.
- Restructure the repository only where a file is generated, unreferenced, or
  superseded by one authoritative counterpart; do not remove a source or a
  committed NapCat artifact merely because it has a similar name.
- Keep the root README focused on project capabilities and use. It must not be
  a dated release diary, a fix log, or a second copy of operations material.

## Non-goals

- Do not replace the native transport with the SDK wholesale.
- Do not use the SDK HTTP client as an automatic fallback for moderation,
  approval, punishment, or any other OneBot action.
- Do not add a second OneBot endpoint, token, persistent setting, or runtime
  compatibility branch.
- Do not claim that Android/proot makes SnowLuma hook injection reliable; that
  platform remains experimental according to upstream.
- Do not change existing Guardian data, config, migration, or deployment
  volume names.
- Do not remove runtime secret redaction, token handling, or security guidance.
  In this scope, "sanitized README" means the README contains no real token,
  account, host, or user-path example, not that security controls are removed.

## Alternatives considered

1. **Native client only.** Smallest change, but does not satisfy the requested
   SDK fallback and leaves no independent implementation for a transport
   compatibility incident.
2. **Use the SDK as the sole transport.** Follows upstream directly but would
   discard Guardian-specific bounded queue, timeout, and redaction behavior
   unless those safeguards were rebuilt around every SDK callback.
3. **Native WebSocket first; SDK WebSocket fallback at process startup.** This
   retains the hardened primary path and gives one independently maintained
   fallback without duplicate actions or events. This is the selected design.

## Runtime architecture

Introduce a narrow SnowLuma transport contract in the platform adapter. It is
not a new application-level port: the existing `RuntimeHost.onebot` remains the
sole business-logic boundary.

```text
SnowLuma composition root
  -> transport factory
       -> native WebSocket transport (primary)
       -> SDK WebSocket transport (one-time fallback)
  -> RuntimeHost.onebot.call()
  -> Guardian services
```

The common transport contract contains only the capabilities already used by
the standalone root:

- `connect()` and `close()`;
- `isConnected()`;
- `call(action, params)`;
- event, event-error, and event-drop registration.

The native client continues to implement this contract. The SDK adapter owns
the SDK-specific type boundary and narrows Guardian's string action name only
inside the adapter. It wraps SDK callbacks with Guardian's same bounded FIFO
dispatcher so async handlers remain ordered and rejected handlers cannot leak
unhandled rejections.

## Selection and failure rules

`SNOWLUMA_SDK_FALLBACK` accepts only `auto` and `off`; it defaults to `auto`.
No other endpoint or token is introduced: both transports use
`SNOWLUMA_WS_URL` and `SNOWLUMA_ACCESS_TOKEN`.

Both transports also receive `SNOWLUMA_MAX_FRAME_BYTES`. The native transport
enforces `SNOWLUMA_RAW_QUEUE_LIMIT` and `SNOWLUMA_RAW_QUEUE_BYTES` before
decoding, with the active frame included in both totals. The SDK adapter uses
the official `raw`, `open`, and `close` hooks to reject oversized Guardian
events and clear connection-scoped queues. Because the SDK emits `raw` only
after receiving the current frame, that fallback cannot undo the SDK's one
current-frame allocation; this limitation is explicit rather than presented as
equivalent pre-parse backpressure. A policy close rejects the SDK's pending
requests and Guardian reconnects that selected client with the same bounded
backoff; it does not hot-switch transports.

1. Start the native transport with the existing bounded connection attempts,
   handshake deadline, and redacted diagnostics.
2. If it establishes a connection, select it permanently for this Guardian
   process session. The SDK is neither constructed nor connected.
3. If native startup exhausts its bounded attempts and fallback is `auto`, close
   it completely, construct the SDK WebSocket adapter, and attempt startup with
   the same connection deadline.
4. If the SDK connects, select it permanently for the process session. The
   native transport is never re-opened while the SDK is selected.
5. If both startup paths fail, keep Guardian's existing retry-loop behavior,
   retrying the selected startup sequence after the logged delay.
6. After either transport has selected successfully, reconnect behavior belongs
   to that transport only. Guardian must never hot-switch a live connection.

The adapter must reject pending actions on disconnection and must not use the
HTTP SDK to retry them. A failed or timed-out WebSocket action may already have
been applied remotely, so cross-transport action replay would risk duplicate
kicks, bans, approvals, or audit records.

## Packaging and dependency policy

- Add `@snowluma/sdk` as an exact production dependency at `1.14.7` and update
  `pnpm-lock.yaml` only for that dependency resolution.
- Use the SDK's `@snowluma/sdk/client` subpath from the adapter.
- Keep esbuild bundling enabled for the standalone entry. The released
  `dist-snowluma/index.mjs` must contain no unresolved `@snowluma/sdk` import
  and no runtime `node_modules` requirement.
- Retain the current deterministic archive checks, secret exclusions, and
  release layout.

## Documentation architecture

`README.md` becomes the concise discovery point: near its first install
instructions it links to both the NapCat plugin route and the SnowLuma
standalone route.

`docs/deployment/snowluma.md` is a Chinese-first, end-to-end operator guide
ordered by the first successful deployment rather than internal build details:

1. choose a supported route and review security requirements;
2. download, verify, and unpack the SnowLuma Guardian release;
3. follow the recommended Docker Compose path from `.env` creation through QQ
   QR login, SnowLuma WebUI bootstrap, OneBot `wsServers`/`Universal` token,
   Guardian restart, and functional verification;
4. follow native Windows, Docker Desktop, WSL2, native Linux, Termux/proot,
   Baota, and 1Panel route-specific instructions;
5. use a clearly separated reference for ports, environment variables, SDK
   fallback behavior, persistence, migration, upgrade, rollback, and common
   failures.

The guide identifies the distinct SnowLuma and Guardian administrator
credentials, explains that `localhost` is wrong from a sidecar container, and
states that the repository Compose file intentionally uses `/app/data` for the
SnowLuma persistent volume. It does not copy potentially stale upstream path
examples into this deployment.

The native environment sample is `deploy/native/guardian.env.example`. The
release has exactly one authoritative environment sample for each deployment
style.

## README and repository structure

The root `README.md` is a concise user-facing entry point. It contains only:

1. one-sentence project purpose and supported hosts;
2. a compact feature list;
3. a clear choice between NapCat and SnowLuma deployment;
4. short, safe quick-start instructions for each route;
5. how to use the WebUI and group commands after installation;
6. links to the full SnowLuma guide, configuration reference, source build
   instructions, and license.

It does not contain dated status text, release-by-release change summaries,
fix narratives, old-version comparisons, update-check API details, complete
schema dumps, or a duplicate full deployment manual. Examples use clearly fake
placeholders and never include a real token, personal pathname, account, or
host.

The repository keeps these intentional top-level responsibilities:

```text
src/       Guardian application, adapters, migrations, and tests
webui/     single source WebUI asset
deploy/    runtime-specific Compose, panel, native, and Termux assets
docs/      user guides and committed architecture specifications
scripts/   build, package, archive policy, and tooling tests
intel/     shipped risk-intelligence seed data
dist/      committed NapCat drop-in artifact, verified against source by CI
```

`dist-snowluma/`, `release/`, and `node_modules/` remain generated or local
outputs and stay untracked. The committed `dist/` tree is retained because it
is the NapCat drop-in installation artifact and CI explicitly verifies that it
matches a build.

Before removing or moving a file, implementation must verify all of the
following: repository references, build/package references, release-entry
policy, test coverage, and user-facing links. The first high-confidence cleanup
items are:

| Item | Target handling | Reason |
| --- | --- | --- |
| `dist/webui/plugin-icon.png` and its SnowLuma generated equivalent | Stop generating and packaging them; retain root and `dist/plugin-icon.png`. | They are byte-identical copies with no WebUI reference; the manifest needs only the root-level packaged icon. |
| `docs/deployment/snowluma.md` | Retain as the single complete SnowLuma guide. | Lowercase, responsibility-based documentation layout. |

No production TypeScript file is deleted in this change unless a subsequent
import-graph and runtime/reference audit proves it unreachable. The current
audit finds every non-test production TypeScript file reachable from the
NapCat or SnowLuma composition root.

Platform-specific deploy files are not deleted merely because their prose
overlaps the main guide. `deploy/README.md` remains a compact release-bundle
asset index; the Baota/1Panel files remain local entry points until an asset
test proves a single-guide replacement provides the same extracted-bundle
navigation. The Termux launch script may be consolidated with the native POSIX
script only after a behavior-equivalence test confirms that no Termux-specific
runtime behavior is lost.

The resulting tracked documentation layout is anchored by the root-level
architecture and deployment references, with detailed material under `docs/`:

```text
ARCHITECTURE.md
DEPLOYMENT.md
docs/
  architecture/
    migration.md
    snowluma-sdk-fallback.md
  deployment/
    snowluma.md
```

## Verification plan

Automated coverage must prove:

1. a successful native connection never creates or connects an SDK transport;
2. native startup failure selects SDK once, after native close, with no overlap;
3. fallback-off never selects SDK;
4. SDK events use bounded FIFO ordering, report drops, redact errors, and
   survive rejected async handlers;
5. SDK startup honors Guardian's handshake timeout and close behavior;
6. action response, failure, and pending-action rejection semantics conform to
   the existing OneBot gateway contract;
7. build output bundles the SDK and release archive checks still reject secrets
   and contain no runtime `node_modules` dependency;
8. documentation references the packaged entry, current deployment assets, and
   current SnowLuma ports/roles without dead links.

The final quality gate is `typecheck`, lint, format check, unit and integration
tests, build, archive/package verification, and `docker compose config`. Where
the local host cannot run QQ/SnowLuma injection, validation reports that limit
explicitly rather than claiming a live platform test.

## Acceptance criteria

- The default SnowLuma runtime remains fully functional with its native client.
- A reproducible native startup failure activates the SDK fallback once with no
  action replay or duplicate inbound event processing.
- A release bundle extracted without source or `node_modules` starts with the
  bundled SDK path available.
- A Chinese-speaking first-time operator can find the SnowLuma guide from the
  README and complete the recommended Compose deployment without using the
  NapCat guide.
- Existing persistent Guardian data paths and volumes remain untouched.
