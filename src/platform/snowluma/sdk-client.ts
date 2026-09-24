import { buildAuthenticatedWsUrl, redactSnowLumaMessage, redactSnowLumaUrl } from './client.ts';
import {
  normalizeOneBotMessageId,
  oneBotMessageIdToSafeNumber,
} from '../../types/onebot.ts';
import {
  DEFAULT_SNOWLUMA_MAX_FRAME_BYTES,
  DEFAULT_SNOWLUMA_RAW_INGRESS_MAX_BYTES,
  DEFAULT_SNOWLUMA_RAW_INGRESS_QUEUE_LIMIT,
  SnowLumaEventDispatcher,
  snowLumaJsonByteLength,
  snowLumaRawFrameByteLength,
  type SnowLumaEventDropHandler,
  type SnowLumaEventErrorHandler,
  type SnowLumaEventHandler,
  type SnowLumaConnectionStateHandler,
  type SnowLumaTransport,
  type SnowLumaTransportOptions,
} from './transport.ts';

interface SnowLumaSdkResponse {
  status?: string;
  retcode?: number;
  data?: unknown;
  message?: string;
  wording?: string;
}

export interface SnowLumaSdkClient {
  readonly isConnected: boolean;
  connect(): Promise<void>;
  close(code?: number, reason?: string): void;
  request(
    action: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<SnowLumaSdkResponse>;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  on<TKey extends keyof SnowLumaSdkObservedEvents>(
    event: TKey,
    listener: (payload: SnowLumaSdkObservedEvents[TKey]) => void,
  ): () => void;
}

export interface SnowLumaSdkObservedEvents {
  open: undefined;
  close: { code?: number; reason?: string };
  error: unknown;
  raw: unknown;
}

export interface SnowLumaSdkClientOptions {
  url: string;
  accessToken?: string;
  requestTimeoutMs: number;
  reconnect: boolean | { minDelayMs: number; maxDelayMs: number };
}

export type SnowLumaSdkClientFactory = (
  options: SnowLumaSdkClientOptions,
) => SnowLumaSdkClient | Promise<SnowLumaSdkClient>;

export interface SnowLumaSdkWsOptions extends SnowLumaTransportOptions {
  sdkClientFactory?: SnowLumaSdkClientFactory;
}

interface ResolvedSnowLumaSdkWsOptions extends Required<Omit<SnowLumaSdkWsOptions, 'accessToken' | 'sdkClientFactory'>> {
  accessToken?: string;
  sdkClientFactory: SnowLumaSdkClientFactory;
}

function positiveInteger(value: number | undefined, fallback: number, minimum = 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function toError(error: unknown, accessToken?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSnowLumaMessage(message, accessToken));
}

/**
 * The official SDK's generated contract currently types `delete_msg` handles
 * as Number. Convert exact safe handles at this boundary; retain larger or
 * provider-specific exact decimal strings for implementations that support
 * them instead of rounding.
 */
export function adaptSnowLumaSdkActionParams(
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (action !== 'delete_msg' || params['message_id'] === undefined) return params;
  const messageId = normalizeOneBotMessageId(params['message_id']);
  if (messageId === null) return params;
  return {
    ...params,
    message_id: oneBotMessageIdToSafeNumber(messageId) ?? messageId,
  };
}

async function createSdkClient(options: SnowLumaSdkClientOptions): Promise<SnowLumaSdkClient> {
  // The SDK ships extensionless ESM internals. Loading it lazily keeps direct
  // TypeScript test execution independent of that package format; esbuild
  // resolves and embeds it in the released standalone bundle.
  const { SnowLumaWebSocketClient } = await import('@snowluma/sdk/client');
  const client = new SnowLumaWebSocketClient({
    url: options.url,
    accessToken: options.accessToken,
    requestTimeoutMs: options.requestTimeoutMs,
    reconnect: options.reconnect,
    role: 'Universal',
  });

  return {
    get isConnected() { return client.isConnected; },
    connect: () => client.connect(),
    close: (code, reason) => client.close(code, reason),
    request: async (action, params = {}, requestOptions) => await client.request(
      action as never,
      params as never,
      requestOptions,
    ) as unknown as SnowLumaSdkResponse,
    onEvent: (listener) => client.onEvent(listener as never),
    on: (event, listener) => client.on(event, listener as never),
  };
}

/**
 * Adapts the official SDK's WebSocket client to Guardian's narrow transport
 * contract. It deliberately exposes no HTTP client: a timed-out OneBot action
 * may have succeeded remotely and must never be replayed through another path.
 */
export class SnowLumaSdkWsClient implements SnowLumaTransport {
  private readonly options: ResolvedSnowLumaSdkWsOptions;
  private readonly eventDispatcher: SnowLumaEventDispatcher;
  private client: SnowLumaSdkClient | null = null;
  private cleanupClientListeners: (() => void)[] = [];
  private connectionLoop: Promise<void> | null = null;
  private closing = false;
  private connectedAtLeastOnce = false;
  private sdkIngressBlocked = false;
  private diagnosticOccurrences = new Map<string, number>();
  private protocolClosePending: SnowLumaSdkClient | null = null;
  private protocolReconnectAttempt = 0;
  private protocolReconnectTimer: NodeJS.Timeout | null = null;
  private connectionStateHandler: SnowLumaConnectionStateHandler | null = null;

  constructor(options: SnowLumaSdkWsOptions) {
    const reconnectMinDelayMs = positiveInteger(options.reconnectMinDelayMs, 1_000);
    const reconnectMaxDelayMs = Math.max(
      reconnectMinDelayMs,
      positiveInteger(options.reconnectMaxDelayMs, 15_000),
    );
    this.options = {
      url: options.url,
      accessToken: options.accessToken,
      requestTimeoutMs: positiveInteger(options.requestTimeoutMs, 30_000),
      connectionTimeoutMs: positiveInteger(options.connectionTimeoutMs, 10_000),
      initialConnectMaxAttempts: positiveInteger(options.initialConnectMaxAttempts, 5),
      reconnect: options.reconnect ?? true,
      reconnectMinDelayMs,
      reconnectMaxDelayMs,
      eventQueueLimit: positiveInteger(options.eventQueueLimit, 1_000),
      maxFrameBytes: positiveInteger(options.maxFrameBytes, DEFAULT_SNOWLUMA_MAX_FRAME_BYTES),
      rawIngressQueueLimit: positiveInteger(
        options.rawIngressQueueLimit,
        DEFAULT_SNOWLUMA_RAW_INGRESS_QUEUE_LIMIT,
      ),
      rawIngressMaxBytes: positiveInteger(
        options.rawIngressMaxBytes,
        DEFAULT_SNOWLUMA_RAW_INGRESS_MAX_BYTES,
      ),
      sdkClientFactory: options.sdkClientFactory ?? createSdkClient,
    };
    this.eventDispatcher = new SnowLumaEventDispatcher({
      eventQueueLimit: this.options.eventQueueLimit,
      toError: (error) => toError(error, this.options.accessToken),
    });
  }

  onEvent(handler: SnowLumaEventHandler): void {
    this.eventDispatcher.onEvent(handler);
  }

  onEventError(handler: SnowLumaEventErrorHandler): void {
    this.eventDispatcher.onEventError(handler);
  }

  onEventDrop(handler: SnowLumaEventDropHandler): void {
    this.eventDispatcher.onEventDrop(handler);
  }

  onConnectionState(handler: SnowLumaConnectionStateHandler): void {
    this.connectionStateHandler = handler;
  }

  isConnected(): boolean {
    return this.client?.isConnected ?? false;
  }

  async connect(): Promise<void> {
    if (this.closing) throw new Error('SnowLuma client closed');
    this.eventDispatcher.activate();
    if (this.isConnected()) return;
    if (!this.connectionLoop) {
      this.connectionLoop = this.connectedAtLeastOnce && this.client
        ? this.connectSelectedClient(this.client)
        : this.connectWithRetries();
      void this.connectionLoop.finally(() => {
        this.connectionLoop = null;
      }).catch(() => {
        // The caller awaits connectionLoop and receives the original error.
      });
    }
    await this.connectionLoop;
  }

  async call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const client = this.client;
    if (!client || !client.isConnected) throw new Error('SnowLuma WebSocket is not connected');
    try {
      const response = await client.request(
        action,
        adaptSnowLumaSdkActionParams(action, params),
        { timeoutMs: this.options.requestTimeoutMs },
      );
      if (response.status === 'failed' || (typeof response.retcode === 'number' && response.retcode !== 0)) {
        const detail = response.wording ?? response.message ?? `retcode=${String(response.retcode)}`;
        throw new Error(`SnowLuma action failed: ${detail}`);
      }
      return response.data;
    } catch (error) {
      throw toError(error, this.options.accessToken);
    }
  }

  close(): void {
    this.closing = true;
    this.sdkIngressBlocked = true;
    this.diagnosticOccurrences.clear();
    this.protocolClosePending = null;
    this.clearProtocolReconnectTimer();
    this.eventDispatcher.close();
    this.releaseClient(this.client);
    this.client = null;
  }

  private async connectWithRetries(): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.options.initialConnectMaxAttempts; attempt += 1) {
      if (this.closing) throw new Error('SnowLuma client closed');
      let client: SnowLumaSdkClient | null = null;
      try {
        client = await this.options.sdkClientFactory(this.sdkClientOptions());
        if (this.closing) {
          try { client.close(); } catch { /* best effort during shutdown */ }
          throw new Error('SnowLuma client closed');
        }
        this.client = client;
        this.attachClient(client);
        await this.connectSelectedClient(client);
        this.connectedAtLeastOnce = true;
        return;
      } catch (error) {
        lastError = toError(error, this.options.accessToken);
        this.releaseClient(client);
        if (this.client === client) this.client = null;
      }
      if (this.closing || attempt + 1 >= this.options.initialConnectMaxAttempts) break;
      await this.waitForRetry(attempt);
    }
    throw lastError ?? new Error('SnowLuma WebSocket connection failed');
  }

  private async connectSelectedClient(client: SnowLumaSdkClient): Promise<void> {
    const safeUrl = redactSnowLumaUrl(buildAuthenticatedWsUrl(this.options.url, this.options.accessToken));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        try { client.close(); } catch { /* best effort after a failed handshake */ }
        finish(new Error(`SnowLuma WebSocket connection timed out after ${this.options.connectionTimeoutMs}ms: ${safeUrl}`));
      }, this.options.connectionTimeoutMs);

      void client.connect().then(
        () => finish(client.isConnected ? undefined : new Error(`SnowLuma WebSocket disconnected during connection: ${safeUrl}`)),
        (error) => finish(toError(error, this.options.accessToken)),
      );
    });
  }

  private attachClient(client: SnowLumaSdkClient): void {
    this.cleanupClientListeners = [
      client.onEvent((event) => {
        if (this.client !== client || this.closing || this.sdkIngressBlocked) return;
        const byteLength = snowLumaJsonByteLength(event);
        if (byteLength === null) {
          this.reportProtocolDiagnostic('invalid_packet');
          return;
        }
        if (byteLength > this.options.maxFrameBytes) {
          this.reportProtocolDiagnostic(
            'frame_too_large',
            `bytes=${byteLength}; limit=${this.options.maxFrameBytes}; source=sdk_event`,
          );
          this.blockOversizedSdkIngress(client);
          return;
        }
        this.eventDispatcher.enqueue(event);
      }),
      client.on('raw', (raw) => {
        if (this.client !== client || this.closing || this.sdkIngressBlocked) return;
        const byteLength = snowLumaRawFrameByteLength(raw);
        if (byteLength === null) {
          this.reportProtocolDiagnostic('unsupported_frame_type', 'source=sdk_raw');
          return;
        }
        if (byteLength > this.options.maxFrameBytes) {
          this.reportProtocolDiagnostic(
            'frame_too_large',
            `bytes=${byteLength}; limit=${this.options.maxFrameBytes}; source=sdk_raw`,
          );
          this.blockOversizedSdkIngress(client);
        }
      }),
      client.on('open', () => {
        if (this.client !== client || this.closing) return;
        this.sdkIngressBlocked = false;
        this.protocolClosePending = null;
        this.protocolReconnectAttempt = 0;
        this.clearProtocolReconnectTimer();
        this.diagnosticOccurrences.clear();
        this.eventDispatcher.clear();
        this.eventDispatcher.activate();
        this.connectionStateHandler?.('connected');
      }),
      client.on('close', () => {
        if (this.client !== client) return;
        const reconnectAfterPolicyClose = this.protocolClosePending === client;
        this.protocolClosePending = null;
        this.sdkIngressBlocked = true;
        this.diagnosticOccurrences.clear();
        this.eventDispatcher.clear();
        this.connectionStateHandler?.('disconnected');
        if (reconnectAfterPolicyClose) this.scheduleProtocolReconnect(client);
      }),
      client.on('error', (error) => {
        if (this.client === client && !this.closing) this.eventDispatcher.reportError(error);
      }),
    ];
  }

  private blockOversizedSdkIngress(client: SnowLumaSdkClient): void {
    if (this.client !== client || this.sdkIngressBlocked) return;
    this.sdkIngressBlocked = true;
    this.protocolClosePending = client;
    this.eventDispatcher.clear();
    try {
      client.close(1009, 'SnowLuma frame exceeds configured limit');
    } catch {
      this.protocolClosePending = null;
      this.scheduleProtocolReconnect(client);
    }
  }

  private reportProtocolDiagnostic(code: string, detail?: string): void {
    const occurrence = (this.diagnosticOccurrences.get(code) ?? 0) + 1;
    this.diagnosticOccurrences.set(code, occurrence);
    if (occurrence !== 1 && !Number.isInteger(Math.log2(occurrence))) return;
    const suffix = detail ? `; ${detail}` : '';
    this.eventDispatcher.reportError(new Error(
      `SnowLuma protocol diagnostic: ${code}; occurrence=${occurrence}${suffix}`,
    ));
  }

  private releaseClient(client: SnowLumaSdkClient | null): void {
    for (const cleanup of this.cleanupClientListeners.splice(0)) {
      try { cleanup(); } catch { /* listener cleanup is best effort */ }
    }
    this.sdkIngressBlocked = true;
    this.protocolClosePending = null;
    this.clearProtocolReconnectTimer();
    this.eventDispatcher.clear();
    try { client?.close(); } catch { /* best effort during shutdown */ }
  }

  private scheduleProtocolReconnect(client: SnowLumaSdkClient): void {
    if (
      !this.options.reconnect
      || this.closing
      || this.client !== client
      || this.protocolReconnectTimer
    ) return;
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectMinDelayMs * 2 ** Math.min(this.protocolReconnectAttempt, 6),
    );
    this.protocolReconnectAttempt += 1;
    this.protocolReconnectTimer = setTimeout(() => {
      this.protocolReconnectTimer = null;
      if (this.closing || this.client !== client || client.isConnected) return;
      void this.connectSelectedClient(client).then(
        () => { this.connectedAtLeastOnce = true; },
        () => {
          if (this.closing || this.client !== client) return;
          this.reportProtocolDiagnostic('sdk_reconnect_failed');
          this.scheduleProtocolReconnect(client);
        },
      );
    }, delay);
  }

  private clearProtocolReconnectTimer(): void {
    if (!this.protocolReconnectTimer) return;
    clearTimeout(this.protocolReconnectTimer);
    this.protocolReconnectTimer = null;
  }

  private async waitForRetry(attempt: number): Promise<void> {
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectMinDelayMs * 2 ** Math.min(attempt, 6),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  private sdkClientOptions(): SnowLumaSdkClientOptions {
    return {
      url: this.options.url,
      accessToken: this.options.accessToken,
      requestTimeoutMs: this.options.requestTimeoutMs,
      reconnect: this.options.reconnect
        ? { minDelayMs: this.options.reconnectMinDelayMs, maxDelayMs: this.options.reconnectMaxDelayMs }
        : false,
    };
  }
}
