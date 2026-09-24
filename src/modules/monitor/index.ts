import { getDatabase } from '../../database/index.ts';
import { configManager } from '../../core/config/index.ts';
import { getProviderTelemetry, getRuntimeHost as getCtx } from '../../runtime/host.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { ProviderTelemetrySnapshot } from '../../runtime/provider-telemetry.ts';
import { freemem, totalmem } from 'os';
import { statfsSync } from 'fs';

export type HealthLevel = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthStatus {
  healthy: boolean;
  status: HealthLevel;
  timestamp: number;
  components: Record<string, ComponentHealth>;
}

export interface ComponentHealth {
  status: 'ok' | 'warn' | 'error';
  message?: string;
  detail?: Record<string, unknown>;
}

let _timer: NodeJS.Timeout | null = null;
let _lastStatus: HealthStatus = buildEmpty();

/** Reconnects are degraded for 30 seconds, then become process-unhealthy. */
export const PROVIDER_RECONNECT_GRACE_MS = 30_000;

function buildEmpty(): HealthStatus {
  return { healthy: true, status: 'healthy', timestamp: 0, components: {} };
}

export function initMonitorModule(): void {
  const cfg = configManager.get().monitor;
  runHealthChecks();
  _timer = setInterval(runHealthChecks, cfg.intervalMs);
}

export function stopMonitorModule(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function getLastHealthStatus(): HealthStatus {
  // Connection state is cheap and volatile, so refresh it on reads rather than
  // returning a provider snapshot that can be one monitor interval stale.
  try {
    const components = {
      ..._lastStatus.components,
      provider: providerHealthComponent(getProviderTelemetry()),
    };
    _lastStatus = summarize(components, Date.now());
  } catch {
    // During very early startup the cached non-provider checks remain valid.
  }
  return _lastStatus;
}

export function providerHealthComponent(snapshot: ProviderTelemetrySnapshot): ComponentHealth {
  const detail = { ...snapshot };
  if (snapshot.state === 'connected') {
    const lastActivityAt = Math.max(snapshot.lastSuccessAt ?? 0, snapshot.lastEventAt ?? 0);
    const unresolvedFailure = snapshot.lastErrorAt !== null && snapshot.lastErrorAt > lastActivityAt;
    return unresolvedFailure
      ? {
          status: 'warn',
          message: `Provider last operation failed (${snapshot.lastErrorCategory ?? 'unknown'})`,
          detail,
        }
      : { status: 'ok', detail };
  }
  if (snapshot.state === 'connecting' || snapshot.state === 'reconnecting') {
    const withinGrace = snapshot.stateAgeMs < PROVIDER_RECONNECT_GRACE_MS;
    return {
      status: withinGrace ? 'warn' : 'error',
      message: withinGrace
        ? `Provider ${snapshot.state}; reconnect grace active`
        : `Provider ${snapshot.state} beyond ${PROVIDER_RECONNECT_GRACE_MS}ms grace`,
      detail,
    };
  }
  if (snapshot.state === 'unknown') {
    return { status: 'warn', message: 'Provider connection state is unknown', detail };
  }
  return {
    status: 'error',
    message: snapshot.state === 'auth_failed'
      ? 'Provider authentication failed'
      : 'Provider is disconnected',
    detail,
  };
}

function summarize(components: Record<string, ComponentHealth>, timestamp: number): HealthStatus {
  const anyError = Object.values(components).some((component) => component.status === 'error');
  const anyWarning = Object.values(components).some((component) => component.status === 'warn');
  const status: HealthLevel = anyError ? 'unhealthy' : anyWarning ? 'degraded' : 'healthy';
  return {
    healthy: status !== 'unhealthy',
    status,
    timestamp,
    components,
  };
}

export function runHealthChecks(): HealthStatus {
  const cfg = configManager.get().monitor;
  const components: Record<string, ComponentHealth> = {};

  // Provider transport and heartbeat telemetry. This contains bounded labels,
  // timestamps, and counts only; no endpoint or OneBot payload is retained.
  try {
    components['provider'] = providerHealthComponent(getProviderTelemetry());
  } catch {
    components['provider'] = { status: 'error', message: 'Provider telemetry unavailable' };
  }

  // Database
  try {
    getDatabase().prepare('SELECT 1').get();
    components['database'] = { status: 'ok' };
  } catch (err) {
    components['database'] = { status: 'error', message: String(err) };
  }

  // Memory
  try {
    const free = freemem();
    const total = totalmem();
    const usedPercent = Math.round(((total - free) / total) * 100);
    components['memory'] = {
      status: usedPercent > cfg.memoryAlertPercent ? 'warn' : 'ok',
      detail: { usedPercent, freeMb: Math.round(free / 1024 / 1024) },
    };
  } catch {
    components['memory'] = { status: 'error', message: 'Could not read memory stats' };
  }

  // Disk
  try {
    const stats = statfsSync(getCtx().paths.dataPath);
    const freeMb = Math.round((stats.bfree * stats.bsize) / 1024 / 1024);
    components['disk'] = {
      status: freeMb < cfg.diskAlertMb ? 'warn' : 'ok',
      detail: { freeMb },
    };
  } catch {
    components['disk'] = { status: 'error', message: 'Could not read disk stats' };
  }

  const allOk = Object.values(components).every((component) => component.status === 'ok');
  _lastStatus = summarize(components, Date.now());

  if (!allOk) {
    getLogger()
      .child({ module: 'monitor' })
      .warn({ components }, 'Health check warning');
  }
  return _lastStatus;
}
