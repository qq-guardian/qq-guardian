import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { assertSecureProviderListener, BaseProvider, unwrapOneBotResponse, type OneBotEnvelope } from './provider.ts';

export interface SnowLumaReverseWebSocketProviderOptions {
  host?: string;
  port: number;
  path?: string;
  accessToken?: string;
  requestTimeoutMs?: number;
  maxPayloadBytes?: number;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Reverse OneBot WebSocket endpoint for SnowLuma wsClients configurations. */
export class SnowLumaReverseWebSocketProvider extends BaseProvider {
  private readonly options: Required<Omit<SnowLumaReverseWebSocketProviderOptions, 'accessToken'>> & { accessToken?: string };
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingCall>();

  constructor(options: SnowLumaReverseWebSocketProviderOptions) {
    super();
    this.options = {
      ...options,
      host: options.host ?? '127.0.0.1',
      path: options.path ?? '/onebot',
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      maxPayloadBytes: options.maxPayloadBytes ?? 1_048_576,
    };
  }

  async connect(): Promise<void> {
    if (this.server) return;
    assertSecureProviderListener(this.options.host, this.options.accessToken);
    const server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
      path: this.options.path,
      maxPayload: this.options.maxPayloadBytes,
      verifyClient: ({ req }: { req: IncomingMessage }) => this.authorized(req.headers.authorization),
    });
    server.on('connection', (socket) => {
      const previous = this.socket;
      if (previous) this.rejectPending(new Error('SnowLuma reverse WebSocket connection replaced'));
      this.socket = socket;
      previous?.close(1012, 'connection replaced');
      socket.on('message', (data, isBinary) => {
        if (isBinary) return this.emitError(new Error('binary OneBot frames are unsupported'));
        this.handlePacket(data.toString('utf8'));
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.rejectPending(new Error('SnowLuma reverse WebSocket disconnected'));
      });
      socket.on('error', (error) => this.emitError(error));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    this.server = server;
  }

  disconnect(): void {
    this.rejectPending(new Error('SnowLuma reverse WebSocket closed'));
    this.socket?.close(1001, 'server shutdown');
    this.socket = null;
    this.server?.close();
    this.server = null;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('SnowLuma reverse WebSocket is not connected'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`SnowLuma action timed out after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return;
        const call = this.pending.get(echo);
        if (!call) return;
        this.pending.delete(echo);
        clearTimeout(call.timer);
        call.reject(new Error('SnowLuma reverse WebSocket send failed'));
      });
    });
  }

  private authorized(header: string | undefined): boolean {
    if (!this.options.accessToken) return true;
    const expected = Buffer.from(`Bearer ${this.options.accessToken}`);
    const actual = Buffer.from(header ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private handlePacket(raw: string): void {
    try {
      const packet = JSON.parse(raw) as OneBotEnvelope & Record<string, unknown>;
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('invalid OneBot packet');
      if (packet.echo !== undefined) {
        const echo = String(packet.echo);
        const call = this.pending.get(echo);
        if (!call) return;
        this.pending.delete(echo);
        clearTimeout(call.timer);
        try { call.resolve(unwrapOneBotResponse(packet)); } catch (error) { call.reject(error as Error); }
        return;
      }
      this.emitEvent(packet);
    } catch (error) {
      this.emitError(error);
    }
  }

  private rejectPending(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }
}
