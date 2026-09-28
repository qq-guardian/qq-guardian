import type { ProviderErrorCategory, RuntimeHost } from '../ports/runtime.ts';
import { getLogger } from '../core/logger/index.ts';
import {
  ProviderTelemetryTracker,
  createProviderDiagnostics,
  type ProviderTelemetrySnapshot,
} from './provider-telemetry.ts';

let currentHost: RuntimeHost | null = null;
let providerTelemetry: ProviderTelemetryTracker | null = null;

/** Install the single active host for this plugin process. */
export function setRuntimeHost(host: RuntimeHost): void {
  if (currentHost && currentHost !== host) {
    throw new Error('[qq-guardian] Runtime host is already initialized');
  }
  currentHost = host;
  providerTelemetry ??= new ProviderTelemetryTracker(host.provider ?? createProviderDiagnostics({
    provider: host.kind,
    transport: 'unknown',
    isConnected: () => null,
  }));
}

export function clearRuntimeHost(): void {
  currentHost = null;
  providerTelemetry = null;
}

export function getRuntimeHost(): RuntimeHost {
  if (!currentHost) throw new Error('[qq-guardian] Runtime host is not initialized');
  return currentHost;
}

export function tryGetRuntimeHost(): RuntimeHost | null {
  return currentHost;
}

export function getProviderTelemetry(): ProviderTelemetrySnapshot {
  if (!providerTelemetry) throw new Error('[qq-guardian] Provider telemetry is not initialized');
  return providerTelemetry.snapshot();
}

/** Record one accepted provider event without retaining its body. */
export function recordProviderEvent(isHeartbeat = false): string | null {
  return providerTelemetry?.recordEvent(isHeartbeat) ?? null;
}

/** Record one provider ingress drop without retaining its body. */
export function recordProviderEventDrop(): string | null {
  return providerTelemetry?.recordEventDrop() ?? null;
}

/** Record a bounded error category without retaining the raw provider error. */
export function recordProviderError(error: unknown): { category: ProviderErrorCategory; correlationId: string } | null {
  return providerTelemetry?.recordProviderError(error) ?? null;
}

/** Execute a transport-neutral OneBot v11 action through the active host. */
export async function callOneBot(action: string, params?: Record<string, unknown>): Promise<unknown> {
  const host = getRuntimeHost();
  if (!providerTelemetry) providerTelemetry = new ProviderTelemetryTracker(host.provider ?? createProviderDiagnostics({
    provider: host.kind,
    transport: 'unknown',
    isConnected: () => null,
  }));
  const span = providerTelemetry.beginAction(action);
  const log = getLogger().child({ module: 'provider' });
  try {
    const result = await host.onebot.call(action, params);
    log.info(providerTelemetry.finishActionSuccess(span), 'Provider action completed');
    return result;
  } catch (error) {
    log.warn(providerTelemetry.finishActionError(span, error), 'Provider action failed');
    throw error;
  }
}
