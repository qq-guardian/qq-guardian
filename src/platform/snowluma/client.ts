import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SNOWLUMA_MAX_FRAME_BYTES,
  DEFAULT_SNOWLUMA_RAW_INGRESS_MAX_BYTES,
  DEFAULT_SNOWLUMA_RAW_INGRESS_QUEUE_LIMIT,
  SnowLumaEventDispatcher,
  snowLumaRawFrameByteLength,
  type SnowLumaEventDropHandler,
  type SnowLumaEventErrorHandler,
  type SnowLumaEventHandler,
  type SnowLumaConnectionStateHandler,
  type SnowLumaTransport,
  type SnowLumaTransportOptions,
} from './transport.ts';

export interface SnowLumaWsOptions extends SnowLumaTransportOptions {
  webSocketFactory?: SnowLumaWebSocketFactory;
}

export type SnowLumaWebSocketFactory = (url: string) => WebSocket;

interface OneBotResponse {
  status?: string;
  retcode?: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: string | number;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface QueuedIncomingFrame {
  socket: WebSocket;
  raw: unknown;
  byteLength: number;
  generation: number;
}

type ProtocolDiagnosticCode =
  | 'frame_processing_failed'
  | 'frame_too_large'
  | 'invalid_packet'
  | 'malformed_json'
  | 'raw_ingress_saturated'
  | 'unknown_packet'
  | 'unsupported_frame_type';

interface ResolvedSnowLumaWsOptions {
  url: string;
  accessToken?: string;
  requestTimeoutMs: number;
  connectionTimeoutMs: number;
  initialConnectMaxAttempts: number;
  reconnect: boolean;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  eventQueueLimit: number;
  maxFrameBytes: number;
  rawIngressQueueLimit: number;
  rawIngressMaxBytes: number;
  webSocketFactory: SnowLumaWebSocketFactory;
}

export type {
  SnowLumaEventDropHandler,
  SnowLumaEventErrorHandler,
  SnowLumaEventHandler,
  SnowLumaTransport,
  SnowLumaTransportOptions,
} from './transport.ts';

const SENSITIVE_QUERY_PARAMETER = /^(?:access_?token|token|authorization|auth|secret|password|api[_-]?key|key)$/i;
const SENSITIVE_ASSIGNMENT = /((?:access_?token|token|authorization|auth|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;&]+/gi;
const SENSITIVE_QUERY = /([?&](?:access_?token|token|authorization|auth|secret|password|api[_-]?key|key)=)[^&#\s]*/gi;

function positiveInteger(value: number | undefined, fallback: number, minimum = 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function toError(error: unknown, accessToken?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSnowLumaMessage(message, accessToken));
}

/** Removes access credentials from a SnowLuma endpoint before it is logged. */
export function redactSnowLumaUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of new Set(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMETER.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    if (url.username) url.username = 'REDACTED';
    if (url.password) url.password = 'REDACTED';
    return url.toString();
  } catch {
    return redactSnowLumaMessage(rawUrl);
  }
}

/** Removes query and inline credential values from connection and handler errors. */
export function redactSnowLumaMessage(value: string, accessToken?: string): string {
  let redacted = value;
  if (accessToken) redacted = redacted.split(accessToken).join('REDACTED');
  return redacted
    .replace(SENSITIVE_QUERY, '$1REDACTED')
    .replace(SENSITIVE_ASSIGNMENT, '$1REDACTED');
}

/** SnowLuma accepts the OneBot token as ?access_token= for WS connections. */
export function buildAuthenticatedWsUrl(rawUrl: string, accessToken?: string): string {
  const url = new URL(rawUrl);
  if (accessToken) url.searchParams.set('access_token', accessToken);
  return url.toString();
}

/**
 * Native OneBot v11 WebSocket client for the SnowLuma runtime. Node 22
 * provides a global WebSocket implementation; the standalone artifact remains
 * self-contained alongside its bundled official-SDK fallback.
 */
export class SnowLumaWsClient implements SnowLumaTransport {
  private readonly options: ResolvedSnowLumaWsOptions;
  private readonly eventDispatcher: SnowLumaEventDispatcher;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingCall>();
  private incomingQueue: QueuedIncomingFrame[] = [];
  private incomingQueueBytes = 0;
  private activeIncoming: QueuedIncomingFrame | null = null;
  private incomingDraining = false;
  private incomingGeneration = 0;
  private diagnosticOccurrences = new Map<ProtocolDiagnosticCode, number>();
  private protocolClosingSockets = new WeakSet<WebSocket>();
  private closing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryReject: ((error: Error) => void) | null = null;
  private openingReject: ((error: Error) => void) | null = null;
  private connectionLoop: Promise<void> | null = null;
  private reconnectAfterConnection = false;
  private connectionStateHandler: SnowLumaConnectionStateHandler | null = null;

  constructor(options: SnowLumaWsOptions) {
    const reconnectMinDelayMs = positiveInteger(options.reconnectMinDelayMs, 1_000);
    this.options = {
      url: options.url,
      accessToken: options.accessToken,
      requestTimeoutMs: positiveInteger(options.requestTimeoutMs, 30_000),
      connectionTimeoutMs: positiveInteger(options.connectionTimeoutMs, 10_000),
      initialConnectMaxAttempts: positiveInteger(options.initialConnectMaxAttempts, 5),
      reconnect: options.reconnect ?? true,
      reconnectMinDelayMs,
      reconnectMaxDelayMs: Math.max(
        reconnectMinDelayMs,
        positiveInteger(options.reconnectMaxDelayMs, 15_000),
      ),
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
      webSocketFactory: options.webSocketFactory ?? ((url) => new WebSocket(url)),
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
    const ws = this.ws;
    return Boolean(ws && ws.readyState === 1 && !this.protocolClosingSockets.has(ws));
  }

  async connect(): Promise<void> {
    this.closing = false;
    this.eventDispatcher.activate();
    this.reconnectAfterConnection = false;
    if (this.isConnected()) return;
    if (!this.connectionLoop) this.startConnectionLoop(false);
    await this.connectionLoop;
  }

  private startConnectionLoop(retryAfterFailure: boolean): void {
    const loop = this.connectWithRetries();
    this.connectionLoop = loop;
    void (async () => {
      try {
        await loop;
      } catch (error) {
        if (retryAfterFailure && !this.closing) {
          console.warn('[guardian:snowluma] reconnect attempt failed', toError(error, this.options.accessToken).message);
          this.reconnectAfterConnection = true;
        }
      } finally {
        if (this.connectionLoop !== loop) return;
        this.connectionLoop = null;
        if (this.reconnectAfterConnection && !this.closing && !this.isConnected()) {
          this.reconnectAfterConnection = false;
          this.scheduleReconnect();
        } else {
          this.reconnectAfterConnection = false;
        }
      }
    })();
  }

  private async connectWithRetries(): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.options.initialConnectMaxAttempts; attempt += 1) {
      if (this.closing) throw new Error('SnowLuma client closed');
      try {
        await this.openSocket();
        if (this.isConnected()) return;
        lastError = new Error('SnowLuma WebSocket disconnected during connection');
      } catch (error) {
        lastError = toError(error, this.options.accessToken);
      }
      if (this.closing || attempt + 1 >= this.options.initialConnectMaxAttempts) break;
      await this.waitForRetry();
    }
    throw lastError ?? new Error('SnowLuma WebSocket connection failed');
  }

  private async openSocket(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const url = buildAuthenticatedWsUrl(this.options.url, this.options.accessToken);
    const safeUrl = redactSnowLumaUrl(url);
    let ws: WebSocket;
    try {
      ws = this.options.webSocketFactory(url);
    } catch (error) {
      throw toError(error, this.options.accessToken);
    }
    const previousSocket = this.ws;
    this.resetConnectionQueues();
    if (previousSocket && previousSocket !== ws) {
      this.rejectPending(new Error('SnowLuma WebSocket connection replaced'));
    }
    this.ws = ws;
    const generation = this.incomingGeneration;
    try { ws.binaryType = 'arraybuffer'; } catch { /* size checks still cover Blob frames */ }
    try {
      if (previousSocket && previousSocket !== ws && previousSocket.readyState < 2) previousSocket.close();
    } catch {
      // The new connection remains authoritative if an old socket cannot close cleanly.
    }

    let opened = false;
    ws.addEventListener('message', (event) => {
      this.queueIncomingMessage(ws, event.data, generation);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.resetConnectionQueues();
      this.rejectPending(new Error('SnowLuma WebSocket disconnected'));
      if (opened) this.connectionStateHandler?.('disconnected');
      if (!opened) {
        this.openingReject?.(new Error(`SnowLuma WebSocket closed during connection: ${safeUrl}`));
        return;
      }
      if (opened && !this.closing && this.options.reconnect) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // Handshake and close own recovery. Event callbacks have no await boundary.
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          finishError(new Error(`SnowLuma WebSocket connection timed out after ${this.options.connectionTimeoutMs}ms: ${safeUrl}`));
        }, this.options.connectionTimeoutMs);
        const finishError = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.openingReject = null;
          reject(error);
        };
        const finishOpen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.openingReject = null;
          opened = true;
          this.reconnectAttempt = 0;
          this.connectionStateHandler?.('connected');
          resolve();
        };

        this.openingReject = finishError;
        ws.addEventListener('open', finishOpen, { once: true });
        ws.addEventListener('error', () => {
          finishError(new Error(`SnowLuma WebSocket connection failed: ${safeUrl}`));
        }, { once: true });
      });
    } catch (error) {
      if (this.ws === ws) {
        this.ws = null;
        this.resetConnectionQueues();
      }
      try { ws.close(); } catch { /* best effort after a failed handshake */ }
      throw toError(error, this.options.accessToken);
    }
  }

  private waitForRetry(): Promise<void> {
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectMinDelayMs * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    this.reconnectAttempt += 1;
    return new Promise<void>((resolve, reject) => {
      this.retryReject = reject;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryReject = null;
        resolve();
      }, delay);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing || !this.options.reconnect) return;
    if (this.connectionLoop) {
      this.reconnectAfterConnection = true;
      return;
    }
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectMinDelayMs * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing && !this.isConnected()) this.startConnectionLoop(true);
    }, delay);
  }

  async call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.protocolClosingSockets.has(ws)) {
      throw new Error('SnowLuma WebSocket is not connected');
    }

    const echo = randomUUID();
    const payload = JSON.stringify({ action, params, echo });
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`SnowLuma action timed out: ${action}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(toError(error, this.options.accessToken));
      }
    });
  }

  private queueIncomingMessage(socket: WebSocket, raw: unknown, generation: number): void {
    if (
      this.closing
      || this.ws !== socket
      || generation !== this.incomingGeneration
      || this.protocolClosingSockets.has(socket)
    ) return;

    const byteLength = snowLumaRawFrameByteLength(raw);
    if (byteLength === null) {
      this.reportProtocolDiagnostic('unsupported_frame_type');
      return;
    }
    if (byteLength > this.options.maxFrameBytes) {
      this.reportProtocolDiagnostic(
        'frame_too_large',
        `bytes=${byteLength}; limit=${this.options.maxFrameBytes}`,
      );
      this.closeForOversizedFrame(socket);
      return;
    }

    const activeCount = this.activeIncoming ? 1 : 0;
    const retainedCount = activeCount + this.incomingQueue.length;
    const retainedBytes = (this.activeIncoming?.byteLength ?? 0) + this.incomingQueueBytes;
    if (
      retainedCount >= this.options.rawIngressQueueLimit
      || byteLength > this.options.rawIngressMaxBytes - retainedBytes
    ) {
      this.reportProtocolDiagnostic(
        'raw_ingress_saturated',
        `retained_frames=${retainedCount}; retained_bytes=${retainedBytes}`,
      );
      return;
    }

    this.incomingQueue.push({ socket, raw, byteLength, generation });
    this.incomingQueueBytes += byteLength;
    if (!this.incomingDraining) this.startIncomingDrain();
  }

  private startIncomingDrain(): void {
    this.incomingDraining = true;
    void this.drainIncomingQueue().catch(() => {
      this.reportProtocolDiagnostic('frame_processing_failed');
    });
  }

  private async drainIncomingQueue(): Promise<void> {
    try {
      while (this.incomingQueue.length > 0) {
        const frame = this.incomingQueue.shift();
        if (!frame) continue;
        this.incomingQueueBytes -= frame.byteLength;
        this.activeIncoming = frame;
        try {
          if (this.isCurrentFrame(frame)) await this.handleMessage(frame);
        } catch {
          if (this.isCurrentFrame(frame)) this.reportProtocolDiagnostic('frame_processing_failed');
        } finally {
          this.activeIncoming = null;
        }
      }
    } finally {
      this.incomingDraining = false;
      if (this.incomingQueue.length > 0) this.startIncomingDrain();
    }
  }

  private async handleMessage(frame: QueuedIncomingFrame): Promise<void> {
    const { raw } = frame;
    let text: string;
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8');
    else if (ArrayBuffer.isView(raw)) text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
    else if (raw instanceof Blob) text = await raw.text();
    else {
      this.reportProtocolDiagnostic('unsupported_frame_type');
      return;
    }
    if (!this.isCurrentFrame(frame)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      this.reportProtocolDiagnostic('malformed_json', `bytes=${frame.byteLength}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.reportProtocolDiagnostic('invalid_packet', `bytes=${frame.byteLength}`);
      return;
    }
    const packet = parsed as OneBotResponse & Record<string, unknown>;

    if (packet.echo !== undefined && packet.echo !== null) {
      if (typeof packet.echo !== 'string' && typeof packet.echo !== 'number') {
        this.reportProtocolDiagnostic('invalid_packet', `bytes=${frame.byteLength}`);
        return;
      }
      const key = String(packet.echo);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (packet.status === 'failed' || (typeof packet.retcode === 'number' && packet.retcode !== 0)) {
        const detail = packet.wording ?? packet.message ?? `retcode=${String(packet.retcode)}`;
        pending.reject(toError(new Error(`SnowLuma action failed: ${detail}`), this.options.accessToken));
      } else {
        pending.resolve(packet.data);
      }
      return;
    }

    if (typeof packet['post_type'] !== 'string') {
      this.reportProtocolDiagnostic('unknown_packet', `bytes=${frame.byteLength}`);
      return;
    }
    this.enqueueEvent(packet);
  }

  private isCurrentFrame(frame: QueuedIncomingFrame): boolean {
    return !this.closing
      && this.ws === frame.socket
      && this.incomingGeneration === frame.generation
      && !this.protocolClosingSockets.has(frame.socket);
  }

  private closeForOversizedFrame(socket: WebSocket): void {
    if (this.ws !== socket || this.protocolClosingSockets.has(socket)) return;
    this.protocolClosingSockets.add(socket);
    this.resetConnectionQueues();
    this.rejectPending(new Error('SnowLuma WebSocket rejected an oversized frame'));
    try {
      socket.close(1009, 'SnowLuma frame exceeds configured limit');
    } catch {
      if (this.ws === socket) {
        this.ws = null;
        this.openingReject?.(new Error('SnowLuma WebSocket could not close after an oversized frame'));
        if (!this.closing && this.options.reconnect) this.scheduleReconnect();
      }
    }
  }

  private reportProtocolDiagnostic(code: ProtocolDiagnosticCode, detail?: string): void {
    const occurrence = (this.diagnosticOccurrences.get(code) ?? 0) + 1;
    this.diagnosticOccurrences.set(code, occurrence);
    if (occurrence !== 1 && !Number.isInteger(Math.log2(occurrence))) return;
    const suffix = detail ? `; ${detail}` : '';
    this.eventDispatcher.reportError(new Error(
      `SnowLuma protocol diagnostic: ${code}; occurrence=${occurrence}${suffix}`,
    ));
  }

  private resetConnectionQueues(): void {
    this.incomingGeneration += 1;
    this.incomingQueue.length = 0;
    this.incomingQueueBytes = 0;
    this.diagnosticOccurrences.clear();
    this.eventDispatcher.clear();
  }

  private enqueueEvent(event: Record<string, unknown>): void {
    if (!this.closing) this.eventDispatcher.enqueue(event);
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(toError(error, this.options.accessToken));
    }
    this.pending.clear();
  }

  close(): void {
    this.closing = true;
    this.reconnectAfterConnection = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryReject?.(new Error('SnowLuma client closed'));
    this.retryReject = null;
    this.openingReject?.(new Error('SnowLuma client closed'));
    this.openingReject = null;
    this.resetConnectionQueues();
    this.eventDispatcher.close();
    this.rejectPending(new Error('SnowLuma client closed'));
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* best effort during shutdown */ }
  }
}
