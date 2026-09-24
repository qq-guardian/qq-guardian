# Remote intelligence trust policy

Guardian treats every downloaded intelligence document as untrusted input. Enabling `intel.enabled` fetches, validates, worker-probes, and reports matches, but the default `observe` mode cannot reject a join request, recall a message, notify an account, mute, kick, or blacklist anyone.

Remote actions require all of the following:

1. A super administrator updates the protected canonical configuration through the authenticated configuration API or local file.
2. `intel.enforcementMode` is set to `enforce`.
3. Every canonical URL in `intel.feedUrls` has a lowercase SHA-256 entry in `intel.feedPins`.
4. The exact downloaded response bytes match that pin and all existing size, schema, regex, and worker-probe checks pass.

Example configuration fragment:

```json
{
  "intel": {
    "enabled": true,
    "enforcementMode": "enforce",
    "feedUrls": ["https://feeds.example/guardian.json"],
    "feedPins": {
      "https://feeds.example/guardian.json": "<64 lowercase SHA-256 hex characters>"
    },
    "refreshIntervalSeconds": 300
  }
}
```

Download the exact response to a private temporary location and inspect it before calculating the pin. On Linux/macOS use `sha256sum guardian.json`; on Windows PowerShell use `Get-FileHash -Algorithm SHA256 .\guardian.json`. Do not pin a digest obtained only from the feed publisher without independently reviewing the corresponding bytes.

A pin mismatch fails closed: the new document is discarded. A previously fetched document remains usable only if its recorded digest still matches the current pin and its URL remains configured. Removing a URL, changing its pin, disabling Intel, or emptying the list revokes its cached rules immediately, including while an older request is still in flight.

`GET /intel/status` reports each source URL, expected pin, active digest, verification state, last success, active/stale state, and stale age. It never returns access tokens or response bodies.

Upgrading a schema-v3 installation creates a verified shadow-migration backup, applies the v4 Intel policy conversion, and then writes the current schema v5. An existing `intel.enabled: true` setting is preserved, while enforcement becomes `observe` with no pins. This deliberate fail-safe migration can reduce automated cloud enforcement until a super administrator reviews and pins the feeds; local rules, blacklist, and punishment logic are unchanged. Schema v5 additionally stores OneBot identifiers as exact decimal text and does not change Intel enforcement semantics.
