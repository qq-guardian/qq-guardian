import type { GuardianHttpRouter } from './http.ts';

/** Host/composition kind. Generic OneBot identities live on the gateway below. */
export type RuntimeKind = 'napcat' | 'snowluma';

/** Provider identity is protocol-facing and deliberately not limited to products we ship. */
export type OneBotProviderIdentity =
  | 'napcat'
  | 'snowluma'
  | 'generic-onebot-v11'
  | 'unknown';

export type ProviderConnectionState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failed'
  | 'unknown';

/**
 * Low-cardinality telemetry categories. The richer OneBot action error taxonomy
 * lives in runtime/onebot-provider.ts; these values remain stable for metrics.
 */
export type ProviderErrorCategory =
  | 'authentication'
  | 'timeout'
  | 'transport'
  | 'protocol'
  | 'unsupported_action'
  | 'provider'
  | 'unknown';

/** Runtime capability set. Arrays make it serializable for diagnostics/tests. */
export interface OneBotCapabilities {
  readonly actions: readonly string[];
  readonly events: readonly string[];
  readonly messages: readonly string[];
  readonly transports: readonly string[];
}

/** Bounded, payload-free connection state supplied by the active provider. */
export interface ProviderConnectionSnapshot {
  provider: OneBotProviderIdentity;
  transport: string;
  state: ProviderConnectionState;
  stateChangedAt: number;
  connectedAt: number | null;
  reconnectAttempts: number;
}

/** Read-only provider diagnostics exposed to Guardian's monitoring layer. */
export interface ProviderDiagnostics {
  snapshot(): ProviderConnectionSnapshot;
}

export interface GuardianPaths {
  /** Absolute plugin/application installation directory. */
  pluginPath: string;
  /** Absolute directory containing Guardian's durable SQLite state. */
  dataPath: string;
  /** Absolute directory containing config.json and config backups. */
  configDir: string;
}

export interface GuardianLogger {
  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Provider-neutral OneBot v11 action gateway.
 *
 * Production adapters populate identity/capabilities/state. Metadata predicates
 * remain optional on the structural interface so narrow test hosts and external
 * adapters written against the earlier call-only port stay source-compatible;
 * missing metadata is treated as unknown rather than inferred from a product name.
 */
export interface OneBotGateway {
  readonly identity?: OneBotProviderIdentity;
  readonly capabilities?: OneBotCapabilities;
  supportsAction?(action: string): boolean;
  supportsEvent?(event: string): boolean;
  supportsMessage?(segment: string): boolean;
  supportsTransport?(transport: string): boolean;
  connectionState?(): ProviderConnectionState;
  call(action: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * The complete platform boundary consumed by Guardian's composition root.
 *
 * Platform adapters own runtime quirks (NapCat's action API, SnowLuma's WS
 * transport, HTTP listener mechanics). Application code only sees these
 * stable capabilities, which keeps OS and host checks out of business logic.
 */
export interface RuntimeHost {
  readonly kind: RuntimeKind;
  readonly pluginId: string;
  readonly paths: GuardianPaths;
  readonly logger: GuardianLogger;
  /** Optional for test-only hosts; production adapters always provide it. */
  readonly provider?: ProviderDiagnostics;
  readonly onebot: OneBotGateway;
  readonly router: GuardianHttpRouter;
}
