import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseSnowLumaSdkFallback,
  SnowLumaStartupTransport,
  type SnowLumaTransportFactory,
} from '../../src/platform/snowluma/factory.ts';
import {
  SnowLumaSdkWsClient,
  type SnowLumaSdkClient,
  type SnowLumaSdkClientOptions,
  type SnowLumaSdkObservedEvents,
} from '../../src/platform/snowluma/sdk-client.ts';
import type {
  SnowLumaEventDropHandler,
  SnowLumaEventErrorHandler,
  SnowLumaEventHandler,
  SnowLumaTransport,
  SnowLumaTransportOptions,
} from '../../src/platform/snowluma/transport.ts';

class FakeTransport implements SnowLumaTransport {
  private readonly timeline: string[];
  private readonly name: string;
  connected = false;
  connectCount = 0;
  closeCount = 0;
  connectError: Error | null = null;
  callResult: unknown = null;
  private eventHandler: SnowLumaEventHandler | null = null;
  private eventErrorHandler: SnowLumaEventErrorHandler | null = null;
  private eventDropHandler: SnowLumaEventDropHandler | null = null;
  private connectionStateHandler: ((state: 'connected' | 'disconnected') => void) | null = null;

  constructor(timeline: string[], name: string) {
    this.timeline = timeline;
    this.name = name;
  }

  async connect(): Promise<void> {
    this.connectCount += 1;
    this.timeline.push(`${this.name}:connect`);
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  close(): void {
    this.closeCount += 1;
    this.connected = false;
    this.timeline.push(`${this.name}:close`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async call(): Promise<unknown> {
    return this.callResult;
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

  emitEvent(event: Record<string, unknown>): void {
    void this.eventHandler?.(event);
  }

  emitError(error: Error): void {
    this.eventErrorHandler?.(error);
  }

  emitDrop(count: number): void {
    this.eventDropHandler?.(count);
  }

  onConnectionState(handler: (state: 'connected' | 'disconnected') => void): void {
    this.connectionStateHandler = handler;
  }

  emitState(state: 'connected' | 'disconnected'): void {
    if (state === 'connected') this.connected = true;
    else this.connected = false;
    this.connectionStateHandler?.(state);
  }
}

class FakeSdkClient implements SnowLumaSdkClient {
  isConnected = false;
  connectCount = 0;
  closeCount = 0;
  requestOptions: { timeoutMs?: number } | undefined;
  requestAction: string | undefined;
  requestParams: Record<string, unknown> | undefined;
  connectError: Error | null = null;
  requestResponse: { status?: string; retcode?: number; data?: unknown; wording?: string } = {
    status: 'ok', retcode: 0, data: null,
  };
  closeCode: number | undefined;
  closeReason: string | undefined;
  emitCloseWhenClosed = true;
  private eventListeners = new Set<(event: Record<string, unknown>) => void>();
  private observedListeners = new Map<keyof SnowLumaSdkObservedEvents, Set<(payload: unknown) => void>>();

  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.connectError) throw this.connectError;
    this.isConnected = true;
    this.emitObserved('open', undefined);
  }

  close(code?: number, reason?: string): void {
    this.closeCount += 1;
    this.closeCode = code;
    this.closeReason = reason;
    this.isConnected = false;
    if (this.emitCloseWhenClosed) this.emitObserved('close', { code, reason });
  }

  async request(
    action: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<{ status?: string; retcode?: number; data?: unknown; wording?: string }> {
    this.requestAction = action;
    this.requestParams = params;
    this.requestOptions = options;
    return this.requestResponse;
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  on<TKey extends keyof SnowLumaSdkObservedEvents>(
    event: TKey,
    listener: (payload: SnowLumaSdkObservedEvents[TKey]) => void,
  ): () => void {
    const listeners = this.observedListeners.get(event) ?? new Set<(payload: unknown) => void>();
    const erased = listener as (payload: unknown) => void;
    listeners.add(erased);
    this.observedListeners.set(event, listeners);
    return () => listeners.delete(erased);
  }

  emitEvent(event: Record<string, unknown>): void {
    for (const listener of this.eventListeners) listener(event);
  }

  emitError(error: unknown): void {
    this.emitObserved('error', error);
  }

  emitRaw(raw: unknown): void {
    this.emitObserved('raw', raw);
  }

  emitClose(): void {
    this.isConnected = false;
    this.emitObserved('close', {});
  }

  emitOpen(): void {
    this.isConnected = true;
    this.emitObserved('open', undefined);
  }

  private emitObserved<TKey extends keyof SnowLumaSdkObservedEvents>(
    event: TKey,
    payload: SnowLumaSdkObservedEvents[TKey],
  ): void {
    for (const listener of this.observedListeners.get(event) ?? []) listener(payload);
  }
}

function waitFor(check: () => void, timeoutMs = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      try {
        check();
        resolve();
      } catch (error) {
        if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, 1);
      }
    };
    attempt();
  });
}

describe('SnowLuma startup transport', () => {
  it('selects native without constructing the SDK fallback', async () => {
    const timeline: string[] = [];
    const native = new FakeTransport(timeline, 'native');
    let sdkCreated = 0;
    const transport = new SnowLumaStartupTransport({
      url: 'ws://localhost:3001/',
      transportFactory: {
        createNative: () => native,
        createSdk: () => {
          sdkCreated += 1;
          return new FakeTransport(timeline, 'sdk');
        },
      },
    });

    await transport.connect();
    assert.equal(transport.selectedKind, 'native');
    assert.equal(sdkCreated, 0);
    assert.deepEqual(timeline, ['native:connect']);
  });

  it('closes failed native startup before creating and selecting the SDK', async () => {
    const timeline: string[] = [];
    const native = new FakeTransport(timeline, 'native');
    native.connectError = new Error('native failed: access_token=secret');
    const sdk = new FakeTransport(timeline, 'sdk');
    const transport = new SnowLumaStartupTransport({
      url: 'ws://localhost:3001/',
      accessToken: 'secret',
      transportFactory: {
        createNative: () => native,
        createSdk: () => {
          assert.deepEqual(timeline, ['native:connect', 'native:close']);
          return sdk;
        },
      },
    });
    const events: number[] = [];
    transport.onEvent((event) => { events.push(Number(event['id'])); });

    await transport.connect();
    sdk.emitEvent({ id: 7 });
    await waitFor(() => assert.deepEqual(events, [7]));
    assert.equal(transport.selectedKind, 'sdk');
    assert.equal(native.closeCount, 1);
    assert.deepEqual(timeline, ['native:connect', 'native:close', 'sdk:connect']);
  });

  it('does not construct the SDK when fallback is off', async () => {
    const timeline: string[] = [];
    const native = new FakeTransport(timeline, 'native');
    native.connectError = new Error('native failed: token=secret');
    let sdkCreated = 0;
    const transport = new SnowLumaStartupTransport({
      url: 'ws://localhost:3001/',
      accessToken: 'secret',
      sdkFallback: 'off',
      transportFactory: {
        createNative: () => native,
        createSdk: () => {
          sdkCreated += 1;
          return new FakeTransport(timeline, 'sdk');
        },
      },
    });

    await assert.rejects(transport.connect(), (error: Error) => {
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    assert.equal(sdkCreated, 0);
    assert.equal(native.closeCount, 1);
  });

  it('switches to SDK on native runtime failure and back to native on recovery', async () => {
    const timeline: string[] = [];
    const native = new FakeTransport(timeline, 'native');
    const sdk = new FakeTransport(timeline, 'sdk');
    const transport = new SnowLumaStartupTransport({
      url: 'ws://localhost:3001/',
      reconnect: false,
      transportFactory: {
        createNative: () => native,
        createSdk: () => sdk,
      },
    });
    const events: number[] = [];
    transport.onEvent((event) => { events.push(Number(event['id'])); });

    await transport.connect();
    assert.equal(transport.selectedKind, 'native');

    native.emitState('disconnected');
    await waitFor(() => assert.equal(transport.selectedKind, 'sdk'));
    sdk.emitEvent({ id: 1 });
    await waitFor(() => assert.deepEqual(events, [1]));

    native.emitState('connected');
    await waitFor(() => assert.equal(transport.selectedKind, 'native'));
    assert.equal(sdk.closeCount, 1);
    assert.deepEqual(timeline, ['native:connect', 'sdk:connect', 'sdk:close']);

    transport.close();
  });

  it('keeps the selected transport after startup instead of hot-switching', async () => {
    const timeline: string[] = [];
    const native = new FakeTransport(timeline, 'native');
    let sdkCreated = 0;
    const transport = new SnowLumaStartupTransport({
      url: 'ws://localhost:3001/',
      transportFactory: {
        createNative: () => native,
        createSdk: () => {
          sdkCreated += 1;
          return new FakeTransport(timeline, 'sdk');
        },
      },
    });

    await transport.connect();
    native.connected = false;
    native.connectError = new Error('reconnect failed');
    await assert.rejects(transport.connect(), /reconnect failed/);
    assert.equal(sdkCreated, 0);
    assert.equal(transport.selectedKind, 'native');
  });

  it('accepts only auto and off fallback configuration values', () => {
    assert.equal(parseSnowLumaSdkFallback(undefined), 'auto');
    assert.equal(parseSnowLumaSdkFallback(' AUTO '), 'auto');
    assert.equal(parseSnowLumaSdkFallback('off'), 'off');
    assert.throws(() => parseSnowLumaSdkFallback('sdk'), /auto.*off/);
  });

  it('forwards raw ingress limits unchanged to the selected transport', async () => {
    const timeline: string[] = [];
    const native = new FakeTransport(timeline, 'native');
    const captured: { options?: SnowLumaTransportOptions } = {};
    const transport = new SnowLumaStartupTransport({
      url: 'ws://localhost:3001/',
      maxFrameBytes: 1_024,
      rawIngressQueueLimit: 7,
      rawIngressMaxBytes: 4_096,
      transportFactory: {
        createNative: (options) => {
          captured.options = options;
          return native;
        },
        createSdk: () => new FakeTransport(timeline, 'sdk'),
      },
    });

    await transport.connect();
    assert.equal(captured.options?.maxFrameBytes, 1_024);
    assert.equal(captured.options?.rawIngressQueueLimit, 7);
    assert.equal(captured.options?.rawIngressMaxBytes, 4_096);
    transport.close();
  });
});

describe('SnowLuma SDK WebSocket adapter', () => {
  it('preserves ordered bounded event delivery and redacts SDK callback errors', async () => {
    const sdk = new FakeSdkClient();
    const client = new SnowLumaSdkWsClient({
      url: 'ws://localhost:3001/',
      accessToken: 'do-not-log-me',
      eventQueueLimit: 2,
      sdkClientFactory: (_options: SnowLumaSdkClientOptions) => sdk,
    });
    const started: number[] = [];
    const completed: number[] = [];
    const errors: Error[] = [];
    const drops: number[] = [];
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    client.onEvent(async (event) => {
      const id = Number(event['id']);
      started.push(id);
      if (id === 1) await firstFinished;
      if (id === 2) throw new Error('handler token=do-not-log-me');
      completed.push(id);
    });
    client.onEventError((error) => errors.push(error));
    client.onEventDrop((count) => drops.push(count));

    await client.connect();
    sdk.emitEvent({ id: 1 });
    sdk.emitEvent({ id: 2 });
    sdk.emitEvent({ id: 3 });
    sdk.emitEvent({ id: 4 });

    await waitFor(() => assert.deepEqual(started, [1]));
    assert.deepEqual(drops, [1]);
    releaseFirst();
    await waitFor(() => assert.deepEqual(started, [1, 2, 3]));
    await waitFor(() => assert.deepEqual(completed, [1, 3]));
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0]?.message ?? '', /do-not-log-me/);
    client.close();
  });

  it('uses the SDK WebSocket request path with Guardian action semantics', async () => {
    const sdk = new FakeSdkClient();
    sdk.requestResponse = { status: 'ok', retcode: 0, data: { online: true } };
    const client = new SnowLumaSdkWsClient({
      url: 'ws://localhost:3001/',
      requestTimeoutMs: 17,
      sdkClientFactory: () => sdk,
    });

    await client.connect();
    assert.deepEqual(await client.call('get_status'), { online: true });
    assert.equal(sdk.requestOptions?.timeoutMs, 17);
    await client.call('delete_msg', { message_id: '-42' });
    assert.equal(sdk.requestAction, 'delete_msg');
    assert.deepEqual(sdk.requestParams, { message_id: -42 });
    await client.call('delete_msg', { message_id: '9007199254740992' });
    assert.deepEqual(sdk.requestParams, { message_id: '9007199254740992' });
    sdk.requestResponse = { status: 'failed', retcode: 1404, wording: 'token=secret' };
    await assert.rejects(client.call('set_group_ban'), (error: Error) => {
      assert.match(error.message, /SnowLuma action failed/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    client.close();
  });

  it('bounds SDK startup attempts and closes each failed client before retrying', async () => {
    const clients = [new FakeSdkClient(), new FakeSdkClient()];
    clients[0]!.connectError = new Error('first token=secret');
    const client = new SnowLumaSdkWsClient({
      url: 'ws://localhost:3001/',
      accessToken: 'secret',
      initialConnectMaxAttempts: 2,
      reconnectMinDelayMs: 1,
      reconnectMaxDelayMs: 1,
      sdkClientFactory: () => clients.shift()!,
    });

    await client.connect();
    assert.equal(clients.length, 0);
    assert.ok(client.isConnected());
    client.close();
  });

  it('bounds a hung SDK handshake without exposing the access token', async () => {
    const sdk = new FakeSdkClient();
    sdk.connect = async () => await new Promise<void>(() => {});
    const client = new SnowLumaSdkWsClient({
      url: 'ws://localhost:3001/?role=universal',
      accessToken: 'do-not-log-me',
      connectionTimeoutMs: 5,
      initialConnectMaxAttempts: 1,
      sdkClientFactory: () => sdk,
    });

    await assert.rejects(client.connect(), (error: Error) => {
      assert.match(error.message, /timed out/);
      assert.doesNotMatch(error.message, /do-not-log-me/);
      assert.match(error.message, /access_token=REDACTED/);
      return true;
    });
    assert.ok(sdk.closeCount >= 1);
    client.close();
  });

  it('does not open an SDK client that finishes loading after shutdown', async () => {
    const sdk = new FakeSdkClient();
    let resolveFactory!: (value: SnowLumaSdkClient) => void;
    const factoryResult = new Promise<SnowLumaSdkClient>((resolve) => { resolveFactory = resolve; });
    const client = new SnowLumaSdkWsClient({
      url: 'ws://localhost:3001/',
      sdkClientFactory: () => factoryResult,
    });

    const connect = client.connect();
    client.close();
    resolveFactory(sdk);
    await assert.rejects(connect, /SnowLuma client closed/);
    assert.equal(sdk.connectCount, 0);
    assert.ok(sdk.closeCount >= 1);
  });

  it('rejects oversized SDK raw frames and parsed events without retaining payloads', async () => {
    const rawSdk = new FakeSdkClient();
    rawSdk.emitCloseWhenClosed = false;
    const rawClient = new SnowLumaSdkWsClient({
      url: 'ws://localhost:3001/',
      maxFrameBytes: 64,
      reconnectMinDelayMs: 1,
      reconnectMaxDelayMs: 1,
      sdkClientFactory: () => rawSdk,
    });
    const rawErrors: Error[] = [];
    const rawEvents: Record<string, unknown>[] = [];
    rawClient.onEvent((event) => { rawEvents.push(event); });
    rawClient.onEventError((error) => rawErrors.push(error));
    await rawClient.connect();

    rawSdk.emitRaw('payload-secret-'.repeat(8));
    rawSdk.emitEvent({ post_type: 'notice', payload: 'payload-secret-'.repeat(8) });
    assert.equal(rawSdk.closeCode, 1009);
    assert.deepEqual(rawEvents, []);
    assert.equal(rawErrors.length, 1);
    assert.match(rawErrors[0]!.message, /frame_too_large.*source=sdk_raw/);
    assert.doesNotMatch(rawErrors[0]!.message, /payload-secret/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(rawSdk.connectCount, 1);
    rawSdk.emitClose();
    await waitFor(() => assert.equal(rawSdk.connectCount, 2));
    rawSdk.emitEvent({ post_type: 'notice', id: 1 });
    await waitFor(() => assert.deepEqual(rawEvents, [{ post_type: 'notice', id: 1 }]));
    rawClient.close();

    const eventSdk = new FakeSdkClient();
    const eventClient = new SnowLumaSdkWsClient({
      url: 'ws://localhost:3001/',
      maxFrameBytes: 32,
      sdkClientFactory: () => eventSdk,
    });
    const eventErrors: Error[] = [];
    eventClient.onEventError((error) => eventErrors.push(error));
    await eventClient.connect();
    eventSdk.emitEvent({ post_type: 'notice', payload: 'payload-secret-'.repeat(4) });
    assert.equal(eventSdk.closeCode, 1009);
    assert.equal(eventErrors.length, 1);
    assert.match(eventErrors[0]!.message, /frame_too_large.*source=sdk_event/);
    assert.doesNotMatch(eventErrors[0]!.message, /payload-secret/);
    eventClient.close();
  });

  it('clears queued SDK events on close before accepting reconnect events', async () => {
    const sdk = new FakeSdkClient();
    const client = new SnowLumaSdkWsClient({
      url: 'ws://localhost:3001/',
      eventQueueLimit: 4,
      sdkClientFactory: () => sdk,
    });
    const events: number[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    client.onEvent(async (event) => {
      const id = Number(event['id']);
      events.push(id);
      if (id === 1) await firstReleased;
    });
    await client.connect();

    sdk.emitEvent({ post_type: 'notice', id: 1 });
    sdk.emitEvent({ post_type: 'notice', id: 2 });
    await waitFor(() => assert.deepEqual(events, [1]));
    sdk.emitClose();
    sdk.emitOpen();
    releaseFirst();
    sdk.emitEvent({ post_type: 'notice', id: 3 });
    await waitFor(() => assert.deepEqual(events, [1, 3]));
    client.close();
  });
});
