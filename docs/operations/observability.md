# Provider health telemetry

The authenticated `GET /plugin/napcat-plugin-qq-guardian/api/metrics` route
retains the existing health response and adds a sanitized provider snapshot.
The snapshot contains the active provider/transport, connection state and age,
reconnect attempts, last successful action/event/heartbeat timestamps, bounded
action/event counters, error category/count, and the most recent correlation
ID. `GET /health/verbose` returns the same live provider list and stable metric
gauges for operators who need a compact diagnostic response.

The stable metric keys are:

- `provider_transport_connections`: `1` only while the active transport is
  connected, otherwise `0`;
- `provider_transport_errors_total`: process-local provider/transport error
  count;
- `provider_last_heartbeat_time`: Unix epoch milliseconds, or `null` before
  the first heartbeat.

Action logs contain `operation`, provider, transport, connection state,
`action`, `correlation_id`, duration, status, and a fixed error category. They
never include action parameters, event bodies, credentials, authorization
headers, or endpoint query secrets. Reconnecting is degraded during the
30-second grace interval and becomes unhealthy after the grace period; an
authentication or transport failure is immediately unhealthy until a later
successful connection/activity transition clears it.
