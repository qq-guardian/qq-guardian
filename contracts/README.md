# Provider payload contracts

These fixtures are the compatibility boundary shared by the NapCat adapter and
the standalone SnowLuma runtime. Each fixture case names a JSON Schema and an
example OneBot v11 packet. CI validates the providers independently so a change
to one adapter cannot silently weaken the other adapter's gate.

Each provider also owns an explicit transport/action/event/message capability
matrix. Supported and intentionally ignored rows link to executable repository
evidence; unsupported rows carry a reason and must not claim a positive fixture.
The gate rejects duplicate capability IDs, missing evidence files, unknown
coverage references, action fixtures that call the wrong operation, and a matrix
with no representative fixture for a supported action/event/message axis. The
check names stay stable as issue #42 expands the transport rows.

The schemas deliberately accept OneBot identifiers as either safe JSON integers
or canonical decimal strings. Decimal strings preserve identifiers outside
JavaScript's safe-integer range; numeric identifiers above that range are
rejected instead of being rounded. Provider-specific extension fields are allowed
on responses and events, while action request envelopes remain closed.

Run the same gates locally:

```console
pnpm run verify:contracts:napcat
pnpm run verify:contracts:snowluma
```

The validator in `scripts/lib/json-schema.mjs` is dependency-free and implements
the JSON Schema draft-07 keywords used by this directory. Its tooling tests
include positive fixtures and deliberately invalid packets, so a validator that
stops rejecting incompatible payloads fails CI.
