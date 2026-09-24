import type {
  SnowLumaEventHandler,
  SnowLumaTransport,
} from './transport.ts';
import { SnowLumaEventDispatcher } from './transport.ts';

/**
 * Provider-neutral lifecycle used by every standalone OneBot endpoint.
 *
 * `send`/`receive`/`disconnect` are the canonical provider operations.  The
 * `call`/`onEvent`/`close` aliases keep the existing application port stable
 * while transports are migrated independently.
 */
export abstract class BaseProvider implements SnowLumaTransport {
  private readonly eventDispatcher: SnowLumaEventDispatcher;

  protected constructor(eventQueueLimit = 1_000) {
    this.eventDispatcher = new SnowLumaEventDispatcher({
      eventQueueLimit,
      toError: (error) => error instanceof Error ? error : new Error(String(error)),
    });
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract isConnected(): boolean;
  abstract send(action: string, params?: Record<string, unknown>): Promise<unknown>;

  receive(handler: SnowLumaEventHandler): void {
    this.eventDispatcher.onEvent(handler);
  }

  call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.send(action, params);
  }

  onEvent(handler: SnowLumaEventHandler): void {
    this.receive(handler);
  }

  onEventError(handler: (error: Error) => void): void {
    this.eventDispatcher.onEventError(handler);
  }

  onEventDrop(handler: (count: number) => void): void {
    this.eventDispatcher.onEventDrop(handler);
  }

  close(): void {
    this.eventDispatcher.close();
    this.disconnect();
  }

  protected emitEvent(event: Record<string, unknown>): void {
    this.eventDispatcher.enqueue(event);
  }

  protected emitError(error: unknown): void {
    this.eventDispatcher.reportError(error);
  }
}

export interface OneBotEnvelope {
  status?: string;
  retcode?: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: string | number;
}

export function unwrapOneBotResponse(response: OneBotEnvelope): unknown {
  if (response.status === 'failed' || (typeof response.retcode === 'number' && response.retcode !== 0)) {
    throw new Error(response.wording || response.message || `OneBot action failed (${response.retcode ?? 'unknown'})`);
  }
  return response.data;
}

/** Refuses an unauthenticated event listener outside the local machine. */
export function assertSecureProviderListener(host: string, accessToken?: string): void {
  const normalized = host.trim().toLowerCase();
  const loopback = normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
  if (!loopback && !accessToken) {
    throw new Error('SNOWLUMA_ACCESS_TOKEN is required for a non-loopback provider listener');
  }
}
