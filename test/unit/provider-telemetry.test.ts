import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviderTelemetryPayload } from '../../src/api/index.ts';
import { redactLogText, redactLogValue } from '../../src/core/logger/redaction.ts';
import { providerHealthComponent, PROVIDER_RECONNECT_GRACE_MS } from '../../src/modules/monitor/index.ts';
import {
  categorizeProviderError,
  ProviderConnectionDiagnostics,
  ProviderTelemetryTracker,
} from '../../src/runtime/provider-telemetry.ts';

function fixture() {
  let now = 1_000;
  let connected: boolean | null = true;
  let sequence = 0;
  const diagnostics = new ProviderConnectionDiagnostics({
    provider: 'snowluma',
    transport: () => 'forward-websocket',
    isConnected: () => connected,
    now: () => now,
  });
  const tracker = new ProviderTelemetryTracker(diagnostics, {
    now: () => now,
    correlationId: () => `corr-${++sequence}`,
  });
  return {
    tracker,
    advance(milliseconds: number) { now += milliseconds; },
    setConnected(value: boolean | null) { connected = value; },
  };
}

test('exposes stable provider state, heartbeat, error, and action metrics', async () => {
  const state = fixture();
  const first = state.tracker.snapshot();
  assert.equal(first.state, 'connected');
  assert.equal(first.transport, 'forward-websocket');
  assert.equal(first.lastHeartbeatAt, null);

  const span = state.tracker.beginAction('get_status');
  state.advance(27);
  const log = state.tracker.finishActionSuccess(span);
  assert.deepEqual(log, {
    operation: 'onebot.action',
    provider: 'snowluma',
    transport: 'forward-websocket',
    connection_state: 'connected',
    action: 'get_status',
    correlation_id: 'corr-1',
    duration_ms: 27,
    status: 'ok',
  });
  const eventCorrelation = state.tracker.recordEvent(true);
  assert.equal(eventCorrelation, 'corr-2');
  const snapshot = state.tracker.snapshot();
  assert.equal(snapshot.lastSuccessAt, 1_027);
  assert.equal(snapshot.lastHeartbeatAt, 1_027);
  assert.equal(snapshot.lastCorrelationId, 'corr-2');
  assert.deepEqual(snapshot.actions, { total: 1, succeeded: 1, failed: 0, inFlight: 0 });
  assert.deepEqual(snapshot.events, { total: 1, dropped: 0 });

  const payload = buildProviderTelemetryPayload(snapshot);
  assert.equal(payload.metrics.provider_transport_connections, 1);
  assert.equal(payload.metrics.provider_transport_errors_total, 0);
  assert.equal(payload.metrics.provider_last_heartbeat_time, 1_027);
  assert.equal(payload.providers[0]?.lastCorrelationId, 'corr-2');
  assert.equal(payload.provider, payload.providers[0]);
  const startupPayload = buildProviderTelemetryPayload(null);
  assert.equal(startupPayload.metrics.provider_transport_connections, 0);
  assert.equal(startupPayload.metrics.provider_transport_errors_total, 0);
  assert.equal(startupPayload.provider.state, 'unknown');
  await Promise.resolve();
});

test('marks reconnect storms and auth failures as degraded/unhealthy', () => {
  const state = fixture();
  state.setConnected(false);
  state.advance(1);
  let snapshot = state.tracker.snapshot();
  assert.equal(snapshot.state, 'reconnecting');
  assert.equal(providerHealthComponent(snapshot).status, 'warn');
  state.advance(PROVIDER_RECONNECT_GRACE_MS + 1);
  snapshot = state.tracker.snapshot();
  assert.equal(providerHealthComponent(snapshot).status, 'error');

  const diagnostic = state.tracker.recordProviderError(new Error('401 unauthorized from provider'));
  assert.equal(diagnostic.category, 'authentication');
  snapshot = state.tracker.snapshot();
  assert.equal(snapshot.state, 'auth_failed');
  assert.equal(snapshot.errorsTotal, 1);
  assert.equal(providerHealthComponent(snapshot).status, 'error');
  assert.equal(categorizeProviderError(new Error('request timed out')), 'timeout');
});


test('recovers known connection state after transient unknown samples without double-counting reconnects', () => {
  const state = fixture();

  state.setConnected(null);
  state.advance(1);
  let snapshot = state.tracker.snapshot();
  assert.equal(snapshot.state, 'unknown');
  assert.equal(snapshot.connectedAt, 1_000, 'transient unknown probes must preserve the known connection epoch');
  assert.equal(snapshot.connectionAgeMs, 1, 'connection age must remain monotonic across transient unknown probes');

  state.setConnected(false);
  state.advance(1);
  snapshot = state.tracker.snapshot();
  assert.equal(snapshot.state, 'reconnecting');
  assert.equal(snapshot.reconnectAttempts, 1);

  // A second unknown probe followed by the same known disconnected state must
  // recover from unknown without counting another transport edge.
  state.setConnected(null);
  state.advance(1);
  assert.equal(state.tracker.snapshot().state, 'unknown');
  state.setConnected(false);
  state.advance(1);
  snapshot = state.tracker.snapshot();
  assert.equal(snapshot.state, 'reconnecting');
  assert.equal(snapshot.reconnectAttempts, 1);

  // Likewise, an unknown probe must not prevent a later connected sample from
  // returning to connected state.
  state.setConnected(null);
  state.advance(1);
  assert.equal(state.tracker.snapshot().state, 'unknown');
  state.setConnected(true);
  state.advance(1);
  snapshot = state.tracker.snapshot();
  assert.equal(snapshot.state, 'connected');
  assert.equal(snapshot.reconnectAttempts, 1);
});

test('redacts credentials and payloads while retaining safe diagnostics', () => {
  const value: Record<string, unknown> = {
    authorization: 'Bearer top-secret',
    password: 'pw',
    payload: { private_message: 'do not retain' },
    nested: { action: 'get_status', duration_ms: 12 },
  };
  value.circular = value;
  const redacted = redactLogValue(value) as Record<string, unknown>;
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redacted.payload, '[OMITTED]');
  assert.deepEqual(redacted.nested, { action: 'get_status', duration_ms: 12 });
  assert.equal(redacted.circular, '[CIRCULAR]');
  assert.equal(redactLogText('POST /?access_token=top-secret Authorization: "Bearer abc"'), 'POST /?access_token=[REDACTED] Authorization: [REDACTED]');
});
