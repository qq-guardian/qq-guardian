import { randomUUID } from 'node:crypto';
import type {
  OneBotProviderIdentity,
  ProviderConnectionSnapshot,
  ProviderConnectionState,
  ProviderDiagnostics,
  ProviderErrorCategory,
} from '../ports/runtime.ts';

const MAX_LABEL_LENGTH = 64;
const SAFE_LABEL = /^[a-z0-9][a-z0-9_.:-]*$/;

export interface ProviderDiagnosticsOptions {
  provider: OneBotProviderIdentity;
  transport: string | (() => string);
  isConnected: () => boolean | null;
  now?: () => number;
}

export interface ProviderTelemetrySnapshot extends ProviderConnectionSnapshot {
  connectionAgeMs: number | null;
  stateAgeMs: number;
  lastSuccessAt: number | null;
  lastEventAt: number | null;
  lastErrorAt: number | null;
  lastErrorCategory: ProviderErrorCategory | null;
  lastHeartbeatAt: number | null;
  lastCorrelationId: string | null;
  errorsTotal: number;
  actions: {
    total: number;
    succeeded: number;
    failed: number;
    inFlight: number;
  };
  events: {
    total: number;
    dropped: number;
  };
}

export interface ProviderActionSpan {
  action: string;
  correlationId: string;
  startedAt: number;
}

export interface ProviderActionLog {
  operation: 'onebot.action';
  provider: OneBotProviderIdentity;
  transport: string;
  connection_state: ProviderConnectionState;
  action: string;
  correlation_id: string;
  duration_ms: number;
  status: 'ok' | 'error';
  error_category?: ProviderErrorCategory;
}

interface ProviderTelemetryTrackerOptions {
  now?: () => number;
  correlationId?: () => string;
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Converts provider-controlled labels to bounded, low-cardinality identifiers. */
export function normalizeTelemetryLabel(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 0 && normalized.length <= MAX_LABEL_LENGTH && SAFE_LABEL.test(normalized)) {
    return normalized;
  }
  return fallback;
}

/**
 * Tracks connection transitions without exposing sockets, endpoint URLs, or
 * credentials through the runtime port.
 */
export class ProviderConnectionDiagnostics implements ProviderDiagnostics {
  private readonly options: Required<Pick<ProviderDiagnosticsOptions, 'now'>> & ProviderDiagnosticsOptions;
  private state: ProviderConnectionState;
  private stateChangedAt: number;
  private connectedAt: number | null;
  private reconnectAttempts = 0;
  private everConnected: boolean;
  private lastKnownConnected: boolean | null;

  constructor(options: ProviderDiagnosticsOptions) {
    this.options = { ...options, now: options.now ?? Date.now };
    const now = safeTimestamp(this.options.now());
    const connected = this.readConnected();
    this.lastKnownConnected = connected;
    this.everConnected = connected === true;
    this.state = connected === null ? 'unknown' : connected ? 'connected' : 'disconnected';
    this.stateChangedAt = now;
    this.connectedAt = connected ? now : null;
  }

  snapshot(): ProviderConnectionSnapshot {
    const now = safeTimestamp(this.options.now());
    const connected = this.readConnected();

    if (connected === null) {
      this.transition('unknown', now);
    } else if (connected) {
      if (this.lastKnownConnected !== true) this.connectedAt = now;
      this.transition('connected', now);
      this.everConnected = true;
      this.lastKnownConnected = true;
    } else {
      if (this.lastKnownConnected !== false && this.everConnected) this.reconnectAttempts += 1;
      this.transition(this.everConnected ? 'reconnecting' : 'disconnected', now);
      this.lastKnownConnected = false;
    }
    const transport = typeof this.options.transport === 'function'
      ? this.options.transport()
      : this.options.transport;
    return {
      provider: this.options.provider,
      transport: normalizeTelemetryLabel(transport, 'unknown'),
      state: this.state,
      stateChangedAt: this.stateChangedAt,
      connectedAt: this.connectedAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  private readConnected(): boolean | null {
    try {
      return this.options.isConnected();
    } catch {
      return null;
    }
  }

  private transition(state: ProviderConnectionState, now: number): void {
    if (this.state === state) return;
    this.state = state;
    this.stateChangedAt = now;
  }
}

export function createProviderDiagnostics(options: ProviderDiagnosticsOptions): ProviderDiagnostics {
  return new ProviderConnectionDiagnostics(options);
}

function providerPortCategory(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if (!('category' in error) || typeof (error as { category?: unknown }).category !== 'string') return null;
  return (error as { category: string }).category;
}

/** Classifies provider errors into a fixed, low-cardinality operational set. */
export function categorizeProviderError(error: unknown): ProviderErrorCategory {
  const typedCategory = providerPortCategory(error);
  if (typedCategory) {
    if (typedCategory === 'authentication') return 'authentication';
    if (typedCategory === 'timeout') return 'timeout';
    if (typedCategory === 'transport' || typedCategory === 'connection') return 'transport';
    if (typedCategory === 'protocol' || typedCategory === 'invalid_response') return 'protocol';
    if (typedCategory === 'unsupported' || typedCategory === 'capability_mismatch') return 'unsupported_action';
    if (typedCategory === 'logical') return 'provider';
    if (typedCategory === 'invalid_parameters' || typedCategory === 'adapter_internal') return 'unknown';
  }

  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const text = `${name} ${message}`.toLowerCase();
  if (/unauthori[sz]ed|forbidden|authentication|authorization|auth[_ -]?failed|invalid[^\n]*token|\b(?:401|403)\b/.test(text)) {
    return 'authentication';
  }
  if (name === 'AbortError' || /timed?\s*out|timeout/.test(text)) return 'timeout';
  if (/unsupported[^\n]*action|unknown[^\n]*action|action[^\n]*not supported/.test(text)) {
    return 'unsupported_action';
  }
  if (/malformed|invalid (?:onebot )?(?:packet|response)|protocol|frame|retcode|json|binary/.test(text)) {
    return 'protocol';
  }
  if (/not connected|disconnect|connection[^\n]*(?:closed|failed|refused|reset)|econn(?:refused|reset)|\bepipe\b|network|fetch failed|websocket[^\n]*closed/.test(text)) {
    return 'transport';
  }
  if (/onebot[^\n]*failed|provider[^\n]*failed|action[^\n]*failed/.test(text)) return 'provider';
  return 'unknown';
}

/**
 * Process-local, bounded telemetry. It records counts and timestamps only;
 * action parameters, results, event bodies, endpoints, and credentials are
 * intentionally absent from this type.
 */
export class ProviderTelemetryTracker {
  private readonly diagnostics: ProviderDiagnostics;
  private readonly now: () => number;
  private readonly correlationId: () => string;
  private lastSuccessAt: number | null = null;
  private lastEventAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastErrorCategory: ProviderErrorCategory | null = null;
  private lastHeartbeatAt: number | null = null;
  private lastCorrelationId: string | null = null;
  private errorsTotal = 0;
  private stateOverride: 'disconnected' | 'auth_failed' | null = null;
  private stateOverrideAt: number | null = null;
  private actionsTotal = 0;
  private actionsSucceeded = 0;
  private actionsFailed = 0;
  private actionsInFlight = 0;
  private eventsTotal = 0;
  private eventsDropped = 0;

  constructor(diagnostics: ProviderDiagnostics, options: ProviderTelemetryTrackerOptions = {}) {
    this.diagnostics = diagnostics;
    this.now = options.now ?? Date.now;
    this.correlationId = options.correlationId ?? randomUUID;
  }

  beginAction(action: string): ProviderActionSpan {
    this.actionsInFlight += 1;
    const correlationId = normalizeTelemetryLabel(this.correlationId(), randomUUID());
    this.lastCorrelationId = correlationId;
    return {
      action: normalizeTelemetryLabel(action, 'unknown_action'),
      correlationId,
      startedAt: safeTimestamp(this.now()),
    };
  }

  finishActionSuccess(span: ProviderActionSpan): ProviderActionLog {
    const finishedAt = safeTimestamp(this.now());
    this.finishAction();
    this.actionsSucceeded += 1;
    this.lastSuccessAt = finishedAt;
    this.stateOverride = null;
    this.stateOverrideAt = null;
    return this.actionLog(span, finishedAt, 'ok');
  }

  finishActionError(span: ProviderActionSpan, error: unknown): ProviderActionLog {
    const finishedAt = safeTimestamp(this.now());
    const category = categorizeProviderError(error);
    this.finishAction();
    this.actionsFailed += 1;
    this.recordError(category, finishedAt);
    return this.actionLog(span, finishedAt, 'error', category);
  }

  recordEvent(isHeartbeat = false): string {
    this.eventsTotal += 1;
    const at = safeTimestamp(this.now());
    this.lastEventAt = at;
    if (isHeartbeat) this.lastHeartbeatAt = at;
    const correlationId = normalizeTelemetryLabel(this.correlationId(), randomUUID());
    this.lastCorrelationId = correlationId;
    this.stateOverride = null;
    this.stateOverrideAt = null;
    return correlationId;
  }

  recordEventDrop(): string {
    this.eventsDropped += 1;
    const correlationId = normalizeTelemetryLabel(this.correlationId(), randomUUID());
    this.lastCorrelationId = correlationId;
    return correlationId;
  }

  recordProviderError(error: unknown): { category: ProviderErrorCategory; correlationId: string } {
    const category = categorizeProviderError(error);
    const correlationId = normalizeTelemetryLabel(this.correlationId(), randomUUID());
    this.lastCorrelationId = correlationId;
    this.recordError(category, safeTimestamp(this.now()));
    return { category, correlationId };
  }

  snapshot(): ProviderTelemetrySnapshot {
    const now = safeTimestamp(this.now());
    const connection = this.diagnostics.snapshot();
    if (
      this.stateOverride
      && this.stateOverrideAt !== null
      && connection.state === 'connected'
      && connection.stateChangedAt > this.stateOverrideAt
    ) {
      this.stateOverride = null;
      this.stateOverrideAt = null;
    }
    const state = this.stateOverride ?? connection.state;
    const stateChangedAt = this.stateOverrideAt ?? connection.stateChangedAt;
    return {
      ...connection,
      state,
      stateChangedAt,
      connectionAgeMs: connection.connectedAt === null
        ? null
        : Math.max(0, now - connection.connectedAt),
      stateAgeMs: Math.max(0, now - stateChangedAt),
      lastSuccessAt: this.lastSuccessAt,
      lastEventAt: this.lastEventAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorCategory: this.lastErrorCategory,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastCorrelationId: this.lastCorrelationId,
      errorsTotal: this.errorsTotal,
      actions: {
        total: this.actionsTotal,
        succeeded: this.actionsSucceeded,
        failed: this.actionsFailed,
        inFlight: this.actionsInFlight,
      },
      events: {
        total: this.eventsTotal,
        dropped: this.eventsDropped,
      },
    };
  }

  private finishAction(): void {
    this.actionsTotal += 1;
    this.actionsInFlight = Math.max(0, this.actionsInFlight - 1);
  }

  private recordError(category: ProviderErrorCategory, at: number): void {
    this.errorsTotal += 1;
    this.lastErrorAt = at;
    this.lastErrorCategory = category;
    if (category === 'authentication') this.stateOverride = 'auth_failed';
    else if (category === 'transport') this.stateOverride = 'disconnected';
    else return;
    this.stateOverrideAt = at;
  }

  private actionLog(
    span: ProviderActionSpan,
    finishedAt: number,
    status: 'ok' | 'error',
    errorCategory?: ProviderErrorCategory,
  ): ProviderActionLog {
    const snapshot = this.snapshot();
    return {
      operation: 'onebot.action',
      provider: snapshot.provider,
      transport: snapshot.transport,
      connection_state: snapshot.state,
      action: span.action,
      correlation_id: span.correlationId,
      duration_ms: Math.max(0, finishedAt - span.startedAt),
      status,
      ...(errorCategory ? { error_category: errorCategory } : {}),
    };
  }
}
