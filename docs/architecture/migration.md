# Guardian architecture and data migration

## Purpose

Refactor NapCat Plugin QQ Guardian into a host-neutral Guardian application with
separate NapCat and SnowLuma adapters, while preserving every valid existing
Guardian configuration and SQLite record. The migration must be one-time,
versioned, idempotent, reversible, and safe across native Windows, Linux,
WSL2, Docker, Docker Desktop, panel-managed Compose, and Termux-style
deployments.

This design deliberately does not permit a clean-reset migration. No code may
replace, truncate, or silently discard live Guardian data.

## Goals

- Preserve valid group configuration, approval rules, blacklist entries,
  punishments, audit/history records, users, password hashes, statistics,
  captcha/approval state, and other operational data.
- Create verified backups before a persistent file is modified.
- Build and validate staged configuration and SQLite candidates before
  activating either candidate.
- Recover deterministically from an interrupted activation.
- Remove retired compatibility code only after a successful migration.
- Keep platform concerns at host-adapter boundaries.
- Make SnowLuma startup, reconnect, WebSocket event ordering, and deployment
  behavior reliable in native and container environments.
- Produce small, self-contained production artifacts with no runtime npm
  dependency.

## Non-goals

- Preserve unsupported legacy behavior indefinitely.
- Continue accepting untyped or obsolete configuration in the normal runtime
  after migration.
- Claim SnowLuma's Android hook injection is universally reliable; Guardian
  will support the Termux/proot runtime path and give actionable diagnostics,
  while SnowLuma's platform limitation remains external to Guardian.
- Introduce a dependency-injection framework, ORM, frontend framework, or
  unrelated infrastructure.

## Approach selection

Three approaches were considered.

1. In-place additive schema upgrades would minimize immediate change but retain
   dead fields and compatibility branches forever.
2. Direct replacement after backup would produce a cleaner result but could
   expose a mixed config/database state after an interruption.
3. Staged shadow migration creates independent candidates, validates them, and
   activates them under a durable journal. This is the selected approach.

The selected approach favors recoverability and correctness over a small amount
of extra temporary disk space.

## Target architecture

The application will be structured around small ports instead of a global
NapCat-shaped context.

    application/
      admissions/        admission, captcha, membership workflows
      moderation/        risk, punishment, blacklist workflows
      auth/              users, sessions, bootstrap flow
      settings/          validated configuration and migration orchestration
      maintenance/       retention, monitoring, scheduled tasks

    domain/
      policies/          pure decisions and action selection
      validation/        config, identifiers, regexes, URLs, durations

    ports/
      onebot.ts          actions and inbound OneBot events
      http.ts            API, static files, and page registration
      runtime.ts         paths, logging, cancellation, scheduler, environment
      storage.ts         transactions and repositories

    adapters/
      napcat/            direct NapCat context bridge
      snowluma/          WebSocket gateway and standalone HTTP adapter
      node/              filesystem, secure-file, network, environment support
      sqlite/            storage and migration implementation

    runtime/
      guardian-app.ts    host-neutral composition and lifecycle
      napcat.ts          NapCat composition root
      snowluma.ts        SnowLuma composition root

Only the NapCat adapter may depend on NapCat plugin API types. The SnowLuma
adapter will expose the same small ports directly rather than creating fake
plugin-manager, config-UI, or router compatibility objects.

The current feature behavior is retained through application services, but
critical side-effecting workflows become explicit and awaited:

    OneBot membership event
      -> resolve group policy
      -> blacklist and active punishment checks
      -> fresh intelligence check
      -> choose one enforcement result
      -> perform OneBot action
      -> persist outcome and audit record
      -> notify and greet only when appropriate

The event publisher remains only for non-critical notification/telemetry
paths. It is not used to coordinate moderation state transitions.

## Versions and migration records

The migration uses three independent records:

| Record | Target | Meaning |
| --- | --- | --- |
| Config schema | 6 | Canonical typed configuration with string OneBot identifiers and a bounded inert extension envelope. |
| SQLite schema migrations | 5 and later | Canonical tables, indexes, sessions, retained data, and exact identifier text. |
| Architecture migration journal | shadow-migration-v1 | Cross-file staging, activation, recovery, and immutable backup metadata. |

Normal runtime configuration loading accepts only the canonical configuration
schema. Legacy conversion exists only inside the migration executor and is
removed from normal load/update paths once the new migration is live.

SQLite schema migrations are recorded only in the staged database candidate
inside a transaction. The live database receives the new migration version
only when that validated candidate is activated.

## Persistent layout

Before migration, existing paths remain authoritative:

    config/
      config.json

    data/
      qqadmin.db
      qqadmin.db-wal          optional
      qqadmin.db-shm          optional

Migration artifacts are stored beside persistent Guardian state:

    data/
      backups/
        migration-<UTC timestamp>-<id>/
          manifest.json
          config.json
          qqadmin.db
          qqadmin.db-wal       when present
          qqadmin.db-shm       when present
      migration/
        <id>/
          config.next.json
          qqadmin.next.db
          validation.json
      migration-state.json

The migration backup directory is never automatically deleted by the migration
process. Routine retention must not remove a migration backup without an
explicit administrator-controlled retention policy.

## Shadow migration protocol

Migration runs before Guardian initializes timers, opens the normal live
database, starts the HTTP host, or connects to OneBot.

### Preconditions

- A single-instance migration lock is acquired in the data directory.
- Guardian verifies that config and database paths resolve within their
  configured storage roots.
- Guardian detects any incomplete prior migration journal before touching
  normal persistent state.
- Guardian creates a consistent SQLite snapshot for staging rather than
  assuming a lone database file is sufficient when WAL files exist.

### Journal phases

The journal contains the migration identifier, source/target versions,
absolute canonical paths, backup paths, cryptographic hashes, and one phase:

    prepared
    backup_verified
    staged
    staged_validated
    activating
    active_validated
    completed
    recovery_required

Every phase is written atomically. A journal is retained through completion so
operators can audit the outcome. Temporary staging files are removed only after
completion; backups remain.

### Execution

1. Read existing config and database state without mutating the live files.
2. Create a timestamped immutable backup and write a checksum manifest.
3. Re-read and verify backup hashes before proceeding.
4. Create a staged config candidate from the source config.
5. Create a staged SQLite candidate from a consistent source snapshot.
6. Apply all config and database conversions to the staged candidates only.
7. Run structural, semantic, referential, and integrity validation on both
   candidates.
8. Write the staged validation report and journal state.
9. Activate candidates under the journal. The old live config and database
   remain recoverable from the verified backup until active validation passes.
10. Re-open the active configuration/database in validation mode and repeat
    the critical validation checks.
11. Mark the journal completed and permit normal application boot.

At no point does a migration failure create a new blank config or database.

### Interrupted activation and idempotence

Cross-file replacement cannot be treated as one filesystem atomic operation.
The journal therefore makes recovery deterministic:

- If both active files have the expected staged hashes, Guardian validates and
  completes the migration.
- If active files do not describe one verified candidate generation, Guardian
  restores the exact verified source backup before allowing normal startup.
- If restoration cannot complete, Guardian exits with the journal and backup
  paths in the error message. It never starts with mixed storage.

Rerunning after completion is a no-op: the config version, database migration
version, and completed journal agree. Rerunning after a failed staging phase
reuses no partial candidate and begins again from the verified original state.

## Configuration conversion and validation

Config schema 6 keeps operational configuration strict:

- only known sections and known nested fields are accepted;
- booleans, enums, identifiers, durations, timezones, intervals, URLs, array
  sizes, and string limits are normalized and bounded;
- all user-configurable regexes are validated before persistence and before
  use, including worker-isolated ReDoS testing;
- credential secrets cannot be returned by a read API or overwritten by a
  masked read value.

Safe unknown legacy fields are not activated as configuration. During shadow
migration they move into the top-level `extensions.legacy` envelope, keyed by
an RFC 6901 JSON Pointer to their original location. The runtime retains that envelope across
ordinary configuration writes but never exposes it through `PluginConfig` or
uses it to change behavior. A future provider adapter must explicitly claim a
namespace and validate it before use.

The envelope is JSON-only and limited to 64 KiB, eight levels, 256 aggregate
entries, 128 items per array, and 4,096 characters per string. Prototype keys,
secret-like paths, non-finite numbers, accessors, class instances, and other
non-JSON values stop migration. The validation manifest lists preserved fields
separately from intentionally retired fields, so operators can audit both
outcomes without weakening `additionalProperties` handling in the active
schema.

Provider-facing OneBot identifiers have one canonical representation:

- `self_id`, QQ user IDs, group IDs, operator IDs, and account identifiers
  inside message segments are positive unsigned 64-bit decimal strings without
  signs, exponents, whitespace, or leading zeros;
- message handles use their own exact decimal-string domain: positive handles
  retain the unsigned 64-bit range and provider-issued negative handles retain
  the signed 64-bit lower bound;
- runtime ingress accepts exact decimal strings, `bigint` values inside native
  integrations, and JavaScript numbers only while they are safe integers;
- an unsafe number is rejected because its original decimal digits have
  already been lost and cannot be reconstructed reliably;
- opaque file identifiers remain strings and are never coerced through
  `Number`;
- config `core.selfId`, `core.superAdmins`, and per-group keys are migrated to
  the same canonical string form, with duplicate canonical group keys rejected.

The legacy risk score model is converted only by the migration executor:

- legacy enabled detectors map to a direct action mapping;
- disabled detectors map to off;
- obsolete threshold, weights, and global score settings are reported as
  retired in the migration manifest;
- known valid settings retain their effective policy.

Unsafe or malformed legacy values are not silently dropped. The staging report
identifies the precise path and reason, the original remains untouched, and
Guardian exits before activation. This applies especially to unsafe regexes,
invalid URLs, invalid intervals, secret-like unknown fields, and extension
payloads outside the documented safety bounds.

## Database conversion and preservation

The staged database migration runs within an explicit SQLite transaction. Where
removing a column requires rebuilding a table, the staged candidate receives
new canonical tables, copies validated rows, verifies counts/references, then
swaps table names inside that transaction.

Schema migration 5 rebuilds every provider-identifier column with `TEXT`
affinity and canonical-value checks. Legacy SQLite integers are converted with
SQLite `CAST(... AS TEXT)` inside the staged database, not read through a
JavaScript number. This preserves values through signed 64-bit maximum exactly.
Invalid, non-canonical, or unsupported source values stop staging before either
live file changes; the verified source backup remains the rollback authority.

Preserved operational tables include:

- users, identifiers, roles, password hashes, timestamps, lockout state;
- approval records and captcha sessions;
- blacklist entries;
- punishment records, duration, revocation, and expiry state;
- audit and login logs;
- statistic snapshots;
- risk rules, actions, enabled state, and timestamps;
- schema migration history required for the canonical schema.

The following retired state is handled explicitly:

| Legacy field | Canonical handling |
| --- | --- |
| risk_rules.weight | Retired score-model field; not copied to active canonical table; preserved in immutable backup and manifest. |
| risk_rules.type | Retired because all supported rules are validated regex patterns; source value is recorded in the manifest. |
| users.totp_secret and users.totp_enabled | Retired because no TOTP feature exists; source data is retained only in the backup and explicitly reported. |
| legacy config score fields | Converted where a direct policy mapping exists; otherwise reported before fail-safe stop. |
| safe unknown config fields | Preserved in the inert `extensions.legacy` envelope and listed under `preservedConfigFields`; never treated as runtime options. |

The existing user QQ identifier remains preserved because it is stored user
data, even if the present UI does not use it broadly.

New canonical tables include persistent session/revocation state so logout,
password changes, lockouts, role changes, and deleted users invalidate prior
tokens across restarts.

Validation includes:

- PRAGMA integrity_check;
- foreign-key check;
- schema migration version check;
- required table/index check;
- exact or explainable source-to-target row-count comparison;
- primary-key/reference preservation;
- post-copy spot checks for representative operational records;
- no unsafe active risk rule;
- session/bootstrap records valid for the canonical auth model.

## Bootstrap and credential security

The migration destination removes admin/admin and plaintext credential logging.

- An explicitly supplied bootstrap secret file or deployment secret is
  preferred.
- If absent, Guardian creates a cryptographically random one-time bootstrap
  credential in a secure bootstrap file, never writes it to stdout, and logs
  only the safe file location.
- POSIX storage uses restrictive file mode and verification. Windows uses the
  native user-profile/data location with best-effort ACL hardening through the
  node platform adapter and a clear warning when strong restriction cannot be
  established.
- The bootstrap secret is removed after first successful administrative setup.
- Existing migrated users retain their password hashes and roles. Legacy
  browser/JWT sessions are intentionally invalidated because they cannot meet
  the persistent session model safely.

## SnowLuma runtime and environment adaptation

SnowLuma runtime responsibilities are limited to an adapter:

- establish a token-redacted OneBot WebSocket connection;
- retry initial connection with bounded exponential backoff;
- reconnect after disconnect and reject only affected in-flight requests;
- feed inbound events through a bounded ordered queue;
- expose health/readiness state;
- start a hardened standalone HTTP server;
- stop cleanly under SIGINT, SIGTERM, and service-manager shutdown.

A single environment adapter detects native Windows, Linux, Docker,
Docker Desktop/WSL2, WSL2, and Termux/proot from well-defined runtime markers.
It owns filesystem defaults, path behavior, capability diagnostics, process
signals, and network default selection. Explicit environment variables always
override detected defaults.

Deployment defaults are:

| Environment | OneBot endpoint default | Guardian HTTP binding |
| --- | --- | --- |
| Native Windows/Linux/WSL2 | loopback SnowLuma WS | loopback |
| Compose sidecar | Compose SnowLuma service DNS | all interfaces in container, loopback host publish by default |
| Generic external container | explicit endpoint required after diagnostic | explicit/safe default |
| Termux/proot | loopback in the same Linux userland | loopback |

This avoids unreliable hostname guessing while still making supplied Compose
and native deployment assets work without source modification.

## Deployment assets and operation

The release contains:

    deploy/compose.yaml   complete SnowLuma + Guardian sidecar definition
    deploy/Dockerfile     runtime-only Guardian container image definition
    deploy/baota/         panel Compose import and persistent-volume guidance
    deploy/1panel/        panel Compose import and persistent-volume guidance
    deploy/native/        Windows, Linux, and Termux/proot launch templates

The Compose service has:

- separate persistent Guardian config and data volumes;
- a health check and restart policy;
- a sidecar endpoint configured by service DNS;
- no public WebUI/API port exposure by default beyond a deliberately mapped
  loopback host port;
- documented override points for a trusted reverse proxy.

Native documentation states where backups live, how to stop Guardian before
rollback, how to restore a migration backup, and how to retain data outside an
unpacked release directory.

## Cutover rules

Retired runtime compatibility code is removed only when all conditions hold:

1. staged candidates passed validation;
2. active candidates passed post-activation validation;
3. the journal is completed;
4. regression tests cover source migration and recovery;
5. NapCat and SnowLuma runtime contracts pass their integration tests.

After cutover:

- normal config loading has no legacy conversion branch;
- SnowLuma has no fake NapCat context, fake router API, fake plugin manager,
  or fake config UI;
- obsolete persistence/config fields are absent from active canonical state;
- compatibility is represented only by immutable backups and the migration
  executor for pre-migration sources, not by ongoing runtime behavior.

## Verification plan

Automated tests cover:

1. representative legacy config versions and complete preserved-group settings;
2. representative legacy SQLite databases with all operational record types;
3. backup creation, checksum verification, staging validation, and rollback;
4. interruption at every journal phase and idempotent restart recovery;
5. malformed/unsafe config and database failure without active-state mutation;
6. config schema validation and approval/risk regex ReDoS rejection;
7. approval/captcha concurrency and conditional state transitions;
8. persistent session invalidation and bootstrap credential behavior;
9. SnowLuma initial retry, reconnect, ordered event handling, timeout, and
   token redaction;
10. standalone router path safety, body limits, timeout, and shutdown;
11. NapCat adapter behavior through a minimal host contract;
12. packaging, artifact contents, manifest consistency, and deterministic ZIPs;
13. Compose syntax/configuration and cross-platform environment-resolution
    semantics on Linux and Windows CI.

Manual acceptance checks cover native Windows, Docker Desktop, WSL2,
Linux/Docker, Linux manual runtime, BT Panel, 1Panel, and Termux/proot.
Android acceptance is documented as Guardian-runtime compatibility plus
SnowLuma capability diagnostics because SnowLuma's ptrace/proot hook is
device-dependent.

## Completion criteria

The refactor is complete only when:

- all migration and recovery tests pass;
- no valid legacy config/database data is silently lost;
- a failed migration preserves original live data and produces an actionable
  report;
- backups and rollback are documented and tested;
- lint, type-check, unit, integration, migration, build, packaging, and
  deployment validation pass;
- NapCat and SnowLuma runtimes start and stop cleanly;
- supported deployment artifacts are self-contained and use persistent state;
- dead compatibility fields, fake adapters, and legacy runtime branches are
  absent from the post-migration runtime.
