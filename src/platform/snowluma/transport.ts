/**
 * Narrow transport boundary for the standalone SnowLuma composition root.
 * Business code continues to use RuntimeHost.onebot; this only lets the
 * runtime choose between equivalent WebSocket implementations safely.
 */
export interface SnowLumaTransportOptions {
  url: string;
  accessToken?: string;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  initialConnectMaxAttempts?: number;
  reconnect?: boolean;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  eventQueueLimit?: number;
  maxFrameBytes?: number;
  rawIngressQueueLimit?: number;
  rawIngressMaxBytes?: number;
}

export const DEFAULT_SNOWLUMA_MAX_FRAME_BYTES = 1_048_576;
export const DEFAULT_SNOWLUMA_RAW_INGRESS_QUEUE_LIMIT = 64;
export const DEFAULT_SNOWLUMA_RAW_INGRESS_MAX_BYTES = 8_388_608;

/** Returns the retained byte size without decoding or copying a raw frame. */
export function snowLumaRawFrameByteLength(raw: unknown): number | null {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  if (raw instanceof Blob) return raw.size;
  return null;
}

/** Measures a parsed SDK event without exposing its contents in diagnostics. */
export function snowLumaJsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return null;
  }
}

export type SnowLumaEventHandler = (event: Record<string, unknown>) => void | Promise<void>;
export type SnowLumaEventErrorHandler = (error: Error) => void;
export type SnowLumaEventDropHandler = (droppedEvents: number) => void;
export type SnowLumaConnectionState = 'connected' | 'disconnected';
export type SnowLumaConnectionStateHandler = (state: SnowLumaConnectionState) => void;

export interface SnowLumaTransport {
  connect(): Promise<void>;
  close(): void;
  isConnected(): boolean;
  call(action: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(handler: SnowLumaEventHandler): void;
  onEventError(handler: SnowLumaEventErrorHandler): void;
  onEventDrop(handler: SnowLumaEventDropHandler): void;
  /** Optional lifecycle signal used by the runtime transport supervisor. */
  onConnectionState?(handler: SnowLumaConnectionStateHandler): void;
}

interface SnowLumaEventDispatcherOptions {
  eventQueueLimit: number;
  toError(error: unknown): Error;
}

/**
 * Keeps transport callbacks bounded and serial. Both supported WebSocket
 * implementations feed this queue so a fallback cannot change event handling
 * semantics or leave rejected async handlers unobserved.
 */
export class SnowLumaEventDispatcher {
  private readonly options: SnowLumaEventDispatcherOptions;
  private eventHandler: SnowLumaEventHandler | null = null;
  private eventErrorHandler: SnowLumaEventErrorHandler | null = null;
  private eventDropHandler: SnowLumaEventDropHandler | null = null;
  private eventQueue: Record<string, unknown>[] = [];
  private eventQueueDraining = false;
  private droppedEvents = 0;
  private active = true;

  constructor(options: SnowLumaEventDispatcherOptions) {
    this.options = options;
  }

  onEvent(handler: SnowLumaEventHandler): void {
    this.eventHandler = handler;
  }

  onEventError(handler: SnowLumaEventErrorHandler): void {
    this.eventErrorHandler = handler;
  }

  onEventDrop(handler: SnowLumaEventDropHandler): void {
    this.eventDropHandler = handler;
  }

  activate(): void {
    this.active = true;
  }

  /** Drops queued events from a retired connection while keeping the handler active. */
  clear(): void {
    this.eventQueue.length = 0;
    this.droppedEvents = 0;
  }

  enqueue(event: Record<string, unknown>): void {
    if (!this.eventHandler || !this.active) return;
    if (this.eventQueue.length >= this.options.eventQueueLimit) {
      this.droppedEvents += 1;
      try {
        this.eventDropHandler?.(this.droppedEvents);
      } catch (error) {
        this.reportError(error);
      }
      return;
    }
    this.eventQueue.push(event);
    if (!this.eventQueueDraining) this.startEventDrain();
  }

  reportError(error: unknown): void {
    const safeError = this.options.toError(error);
    if (this.eventErrorHandler) {
      try {
        this.eventErrorHandler(safeError);
        return;
      } catch {
        // Do not let observer failures create an unhandled rejection.
      }
    }
    console.error('[guardian:snowluma] transport/event diagnostic', safeError.message);
  }

  close(): void {
    this.active = false;
    this.clear();
  }

  private startEventDrain(): void {
    this.eventQueueDraining = true;
    void this.drainEventQueue().catch((error) => this.reportError(error));
  }

  private async drainEventQueue(): Promise<void> {
    try {
      while (this.active && this.eventQueue.length > 0) {
        const event = this.eventQueue.shift();
        const handler = this.eventHandler;
        if (!event || !handler) continue;
        try {
          await handler(event);
        } catch (error) {
          this.reportError(error);
        }
      }
    } finally {
      this.eventQueueDraining = false;
      if (this.active && this.eventQueue.length > 0) this.startEventDrain();
    }
  }
}
