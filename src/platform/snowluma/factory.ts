import { randomUUID } from 'node:crypto';
import { SnowLumaWsClient, redactSnowLumaMessage } from './client.ts';
import { SnowLumaSdkWsClient } from './sdk-client.ts';
import type {
  SnowLumaEventDropHandler,
  SnowLumaEventErrorHandler,
  SnowLumaEventHandler,
  SnowLumaConnectionStateHandler,
  SnowLumaTransport,
  SnowLumaTransportOptions,
} from './transport.ts';

export type SnowLumaSdkFallbackMode = 'auto' | 'off';
export type SnowLumaTransportKind = 'native' | 'sdk';

export interface SnowLumaTransportFactory {
  createNative(options: SnowLumaTransportOptions): SnowLumaTransport;
  createSdk(options: SnowLumaTransportOptions): SnowLumaTransport;
}

export interface SnowLumaStartupTransportOptions extends SnowLumaTransportOptions {
  sdkFallback?: SnowLumaSdkFallbackMode;
  transportFactory?: SnowLumaTransportFactory;
}

const defaultTransportFactory: SnowLumaTransportFactory = {
  createNative: (options) => new SnowLumaWsClient(options),
  createSdk: (options) => new SnowLumaSdkWsClient(options),
};

/** Parses the only supported SDK fallback modes without accepting silent typos. */
export function parseSnowLumaSdkFallback(value: string | undefined): SnowLumaSdkFallbackMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === 'off') return 'off';
  throw new Error('SNOWLUMA_SDK_FALLBACK must be "auto" or "off"');
}

/**
 * Chooses a single transport during startup. Once a transport connects, it is
 * permanent for the process lifetime; reconnects remain owned by that client.
 */
export class SnowLumaStartupTransport implements SnowLumaTransport {
  private readonly transportOptions: SnowLumaTransportOptions;
  private readonly fallbackMode: SnowLumaSdkFallbackMode;
  private readonly transportFactory: SnowLumaTransportFactory;
  private activeTransport: SnowLumaTransport | null = null;
  private connectingTransport: SnowLumaTransport | null = null;
  private connectionLoop: Promise<void> | null = null;
  private eventHandler: SnowLumaEventHandler | null = null;
  private eventErrorHandler: SnowLumaEventErrorHandler | null = null;
  private eventDropHandler: SnowLumaEventDropHandler | null = null;
  private closed = false;
  private kind: SnowLumaTransportKind | null = null;
  private fallbackCorrelationId: string | null = null;

  constructor(options: SnowLumaStartupTransportOptions) {
    this.transportOptions = {
      url: options.url,
      accessToken: options.accessToken,
      requestTimeoutMs: options.requestTimeoutMs,
      connectionTimeoutMs: options.connectionTimeoutMs,
      initialConnectMaxAttempts: options.initialConnectMaxAttempts,
      reconnect: options.reconnect,
      reconnectMinDelayMs: options.reconnectMinDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      eventQueueLimit: options.eventQueueLimit,
      maxFrameBytes: options.maxFrameBytes,
      rawIngressQueueLimit: options.rawIngressQueueLimit,
      rawIngressMaxBytes: options.rawIngressMaxBytes,
    };
    this.fallbackMode = options.sdkFallback ?? 'auto';
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
  }

  get selectedKind(): SnowLumaTransportKind | null {
    return this.kind;
  }

  onEvent(handler: SnowLumaEventHandler): void {
    this.eventHandler = handler;
    this.currentTransport()?.onEvent(handler);
  }

  onEventError(handler: SnowLumaEventErrorHandler): void {
    this.eventErrorHandler = handler;
    this.currentTransport()?.onEventError(handler);
  }

  onEventDrop(handler: SnowLumaEventDropHandler): void {
    this.eventDropHandler = handler;
    this.currentTransport()?.onEventDrop(handler);
  }

  onConnectionState(handler: SnowLumaConnectionStateHandler): void {
    this.currentTransport()?.onConnectionState?.(handler);
  }

  isConnected(): boolean {
    return this.activeTransport?.isConnected() ?? false;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('SnowLuma client closed');
    if (this.activeTransport) {
      await this.activeTransport.connect();
      return;
    }
    if (!this.connectionLoop) {
      const loop = this.selectStartupTransport();
      this.connectionLoop = loop;
      void loop.finally(() => {
        if (this.connectionLoop === loop) this.connectionLoop = null;
      }).catch(() => {
        // The caller awaits connectionLoop and receives the original error.
      });
    }
    await this.connectionLoop;
  }

  async call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const transport = this.activeTransport;
    if (!transport) throw new Error('SnowLuma WebSocket is not connected');
    return await transport.call(action, params);
  }

  close(): void {
    this.closed = true;
    const transports = new Set([this.activeTransport, this.connectingTransport]);
    this.activeTransport = null;
    this.connectingTransport = null;
    for (const transport of transports) {
      try { transport?.close(); } catch { /* best effort during shutdown */ }
    }
  }

  private async selectStartupTransport(): Promise<void> {
    const native = this.createTransport('native');
    try {
      await native.connect();
      this.selectTransport(native, 'native');
      return;
    } catch (nativeError) {
      this.retireTransport(native);
      if (this.closed || this.fallbackMode === 'off') throw this.toError(nativeError);
    }

    const sdk = this.createTransport('sdk');
    try {
      await sdk.connect();
      this.selectTransport(sdk, 'sdk');
    } catch (sdkError) {
      this.retireTransport(sdk);
      throw this.toError(sdkError);
    }
  }

  private createTransport(kind: SnowLumaTransportKind): SnowLumaTransport {
    const transport = kind === 'native'
      ? this.transportFactory.createNative(this.transportOptions)
      : this.transportFactory.createSdk(this.transportOptions);
    this.connectingTransport = transport;
    if (this.eventHandler) {
      transport.onEvent((event) => {
        if (this.activeTransport === transport) void this.eventHandler?.(event);
      });
    }
    if (this.eventErrorHandler) transport.onEventError(this.eventErrorHandler);
    if (this.eventDropHandler) transport.onEventDrop(this.eventDropHandler);
    transport.onConnectionState?.((state) => {
      void this.handleConnectionState(transport, kind, state);
    });
    return transport;
  }

  private selectTransport(
    transport: SnowLumaTransport,
    kind: SnowLumaTransportKind,
    closePrevious = true,
  ): void {
    if (this.closed) {
      transport.close();
      throw new Error('SnowLuma client closed');
    }
    const previous = this.activeTransport;
    this.activeTransport = transport;
    if (this.connectingTransport === transport) this.connectingTransport = null;
    this.kind = kind;
    if (closePrevious && previous && previous !== transport) {
      try { previous.close(); } catch { /* best effort during transport handover */ }
    }
  }

  private async handleConnectionState(
    transport: SnowLumaTransport,
    kind: SnowLumaTransportKind,
    state: 'connected' | 'disconnected',
  ): Promise<void> {
    if (this.closed) return;
    if (state === 'disconnected') {
      if (kind !== 'native' || this.activeTransport !== transport || this.fallbackMode === 'off') return;
      this.fallbackCorrelationId = randomUUID();
      console.warn(
        '[guardian:snowluma] primary transport lost; activating SDK fallback',
        { correlationId: this.fallbackCorrelationId, provider: 'snowluma', transport: 'native' },
      );
      const sdk = this.createTransport('sdk');
      try {
        await sdk.connect();
        if (this.closed) { this.retireTransport(sdk); return; }
        this.selectTransport(sdk, 'sdk', false);
        console.warn(
          '[guardian:snowluma] SDK fallback active',
          { correlationId: this.fallbackCorrelationId, provider: 'snowluma', transport: 'sdk' },
        );
      } catch (error) {
        this.retireTransport(sdk);
        this.eventErrorHandler?.(this.toError(error));
      }
      return;
    }

    if (kind === 'native' && this.activeTransport !== transport && this.kind === 'sdk' && this.fallbackMode === 'auto') {
      this.selectTransport(transport, 'native');
      console.warn(
        '[guardian:snowluma] primary transport recovered; returning from SDK fallback',
        { correlationId: this.fallbackCorrelationId ?? randomUUID(), provider: 'snowluma', transport: 'native' },
      );
      this.fallbackCorrelationId = null;
      return;
    }
  }

  private retireTransport(transport: SnowLumaTransport): void {
    try { transport.close(); } catch { /* a failed transport must not block fallback */ }
    if (this.connectingTransport === transport) this.connectingTransport = null;
  }

  private currentTransport(): SnowLumaTransport | null {
    return this.activeTransport ?? this.connectingTransport;
  }

  private toError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(redactSnowLumaMessage(message, this.transportOptions.accessToken));
  }
}
