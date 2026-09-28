import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthenticatedWsUrl,
  redactSnowLumaMessage,
  redactSnowLumaUrl,
  SnowLumaWsClient,
} from '../../src/platform/snowluma/client.ts';

type Listener = { callback: (event: { data?: unknown }) => void; once: boolean };

class FakeWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  readonly sent: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, callback: (event: { data?: unknown }) => void, options?: { once?: boolean }): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, once: options?.once ?? false });
    this.listeners.set(type, listeners);
  }

  send(payload: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(payload);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  fail(): void {
    this.emit('error');
  }

  receive(data: unknown): void {
    this.emit('message', { data });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emitClose();
  }

  emitClose(): void {
    this.emit('close');
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const listener of listeners) {
      listener.callback(event);
      if (listener.once) {
        const current = this.listeners.get(type) ?? [];
        this.listeners.set(type, current.filter((candidate) => candidate !== listener));
      }
    }
  }
}

class DeferredBlob extends Blob {
  readonly textStarted: Promise<void>;
  private markTextStarted!: () => void;
  private readonly releaseText: Promise<void>;

  constructor(value: string, releaseText: Promise<void>) {
    super([value]);
    this.releaseText = releaseText;
    this.textStarted = new Promise<void>((resolve) => { this.markTextStarted = resolve; });
  }

  override async text(): Promise<string> {
    this.markTextStarted();
    await this.releaseText;
    return await super.text();
  }
}

class TrackingBlob extends Blob {
  textCalls = 0;

  override async text(): Promise<string> {
    this.textCalls += 1;
    return await super.text();
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

function asWebSocket(socket: FakeWebSocket): WebSocket {
  return socket as unknown as WebSocket;
}

function toArrayBuffer(value: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(value, 'utf8')).buffer;
}

describe('SnowLuma WebSocket URL', () => {
  it('adds the OneBot access_token query parameter', () => {
    const url = new URL(buildAuthenticatedWsUrl('ws://127.0.0.1:3001/', 'a b+c'));
    assert.equal(url.protocol, 'ws:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '3001');
    assert.equal(url.searchParams.get('access_token'), 'a b+c');
  });

  it('preserves existing query parameters', () => {
    const url = new URL(buildAuthenticatedWsUrl('ws://localhost:3001/onebot?role=Universal', 'secret'));
    assert.equal(url.searchParams.get('role'), 'Universal');
    assert.equal(url.searchParams.get('access_token'), 'secret');
  });

  it('does not add an empty token', () => {
    const url = new URL(buildAuthenticatedWsUrl('ws://localhost:3001/'));
    assert.equal(url.searchParams.has('access_token'), false);
  });

  it('redacts query and inline credentials before errors are logged', () => {
    const endpoint = redactSnowLumaUrl('ws://user:pass@localhost:3001/?access_token=secret&role=universal');
    assert.doesNotMatch(endpoint, /secret|pass|user/);
    assert.match(endpoint, /access_token=REDACTED/);
    const error = redactSnowLumaMessage('failed ws://localhost/?token=secret; authorization: abc', 'secret');
    assert.doesNotMatch(error, /secret|abc/);
    assert.match(error, /token=REDACTED/);
    assert.match(error, /authorization: REDACTED/);
  });
});

describe('SnowLuma WebSocket client', () => {
  it('retries an initial connection failure with bounded backoff', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      initialConnectMaxAttempts: 2,
      reconnectMinDelayMs: 1,
      reconnectMaxDelayMs: 1,
      connectionTimeoutMs: 50,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          if (sockets.length === 1) socket.fail();
          else socket.open();
        });
        return asWebSocket(socket);
      },
    });

    await client.connect();
    assert.equal(sockets.length, 2);
    assert.equal(client.isConnected(), true);
    client.close();
  });

  it('fails a timed-out handshake without exposing the access token', async () => {
    const socket = new FakeWebSocket();
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/?role=universal',
      accessToken: 'do-not-log-me',
      initialConnectMaxAttempts: 1,
      connectionTimeoutMs: 5,
      webSocketFactory: () => asWebSocket(socket),
    });

    await assert.rejects(client.connect(), (error: Error) => {
      assert.match(error.message, /timed out/);
      assert.doesNotMatch(error.message, /do-not-log-me/);
      assert.match(error.message, /access_token=REDACTED/);
      return true;
    });
    assert.equal(socket.readyState, 3);
    client.close();
  });

  it('fails the handshake immediately when the server closes before opening', async () => {
    const socket = new FakeWebSocket();
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      initialConnectMaxAttempts: 1,
      connectionTimeoutMs: 1_000,
      webSocketFactory: () => asWebSocket(socket),
    });

    const connect = client.connect();
    socket.close();
    await assert.rejects(connect, /closed during connection/);
    client.close();
  });

  it('keeps calls on a replacement socket alive when a stale socket closes late', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      initialConnectMaxAttempts: 1,
      reconnectMinDelayMs: 1,
      reconnectMaxDelayMs: 1,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
    });

    await client.connect();
    const first = sockets[0]!;
    first.close();
    await waitFor(() => {
      assert.equal(sockets.length, 2);
      assert.equal(client.isConnected(), true);
    });

    const second = sockets[1]!;
    const call = client.call('get_status');
    await waitFor(() => assert.equal(second.sent.length, 1));
    const echo = JSON.parse(second.sent[0]!) as { echo: string };
    first.emitClose();
    second.receive(JSON.stringify({ echo: echo.echo, status: 'ok', retcode: 0, data: 'ok' }));
    assert.equal(await call, 'ok');
    client.close();
  });

  it('dispatches accepted events in order, catches handler errors, and drops newest events when full', async () => {
    const socket = new FakeWebSocket();
    const started: number[] = [];
    const completed: number[] = [];
    const errors: Error[] = [];
    const drops: number[] = [];
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      eventQueueLimit: 2,
      webSocketFactory: () => asWebSocket(socket),
    });
    client.onEvent(async (event) => {
      const id = Number(event['id']);
      started.push(id);
      if (id === 1) await firstFinished;
      if (id === 2) throw new Error('handler token=do-not-log-me');
      completed.push(id);
    });
    client.onEventError((error) => errors.push(error));
    client.onEventDrop((count) => drops.push(count));

    const connect = client.connect();
    socket.open();
    await connect;

    socket.receive(JSON.stringify({ post_type: 'notice', id: 1 }));
    socket.receive(JSON.stringify({ post_type: 'notice', id: 2 }));
    socket.receive(JSON.stringify({ post_type: 'notice', id: 3 }));
    socket.receive(JSON.stringify({ post_type: 'notice', id: 4 }));

    await waitFor(() => assert.deepEqual(started, [1]));
    await waitFor(() => assert.deepEqual(drops, [1]));
    releaseFirst();
    await waitFor(() => assert.deepEqual(started, [1, 2, 3]));
    await waitFor(() => assert.deepEqual(completed, [1, 3]));
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0]?.message ?? '', /do-not-log-me/);
    client.close();
  });

  it('bounds raw ingress by retained frame count while a Blob decode is blocked', async () => {
    const socket = new FakeWebSocket();
    const events: number[] = [];
    const errors: Error[] = [];
    let releaseDecode!: () => void;
    const decodeReleased = new Promise<void>((resolve) => { releaseDecode = resolve; });
    const blocked = new DeferredBlob(
      JSON.stringify({ post_type: 'notice', id: 1 }),
      decodeReleased,
    );
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      reconnect: false,
      maxFrameBytes: 1_000,
      rawIngressQueueLimit: 2,
      rawIngressMaxBytes: 2_000,
      webSocketFactory: () => asWebSocket(socket),
    });
    client.onEvent((event) => { events.push(Number(event['id'])); });
    client.onEventError((error) => errors.push(error));

    const connect = client.connect();
    socket.open();
    await connect;
    socket.receive(blocked);
    await blocked.textStarted;
    socket.receive(JSON.stringify({ post_type: 'notice', id: 2 }));
    socket.receive(JSON.stringify({ post_type: 'notice', id: 3 }));
    socket.receive(JSON.stringify({ post_type: 'notice', id: 4, payload: 'do-not-log-me' }));

    await waitFor(() => assert.equal(errors.length, 2));
    assert.ok(errors.every((error) => error.message.includes('raw_ingress_saturated')));
    assert.ok(errors.every((error) => !error.message.includes('do-not-log-me')));
    releaseDecode();
    await waitFor(() => assert.deepEqual(events, [1, 2]));
    client.close();
  });

  it('bounds raw ingress by aggregate retained bytes', async () => {
    const socket = new FakeWebSocket();
    const events: number[] = [];
    const errors: Error[] = [];
    let releaseDecode!: () => void;
    const decodeReleased = new Promise<void>((resolve) => { releaseDecode = resolve; });
    const firstText = JSON.stringify({ post_type: 'notice', id: 1 });
    const secondText = JSON.stringify({ post_type: 'notice', id: 2 });
    const blocked = new DeferredBlob(firstText, decodeReleased);
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      reconnect: false,
      maxFrameBytes: 1_000,
      rawIngressQueueLimit: 10,
      rawIngressMaxBytes: Buffer.byteLength(firstText) + Buffer.byteLength(secondText) - 1,
      webSocketFactory: () => asWebSocket(socket),
    });
    client.onEvent((event) => { events.push(Number(event['id'])); });
    client.onEventError((error) => errors.push(error));

    const connect = client.connect();
    socket.open();
    await connect;
    socket.receive(blocked);
    await blocked.textStarted;
    socket.receive(secondText);

    await waitFor(() => assert.equal(errors.length, 1));
    assert.match(errors[0]!.message, /raw_ingress_saturated/);
    releaseDecode();
    await waitFor(() => assert.deepEqual(events, [1]));
    client.close();
  });

  it('rejects oversized strings, ArrayBuffers, typed arrays, and Blobs before parsing', async () => {
    const oversized = 'payload-secret-'.repeat(4);
    const oversizedBlob = new TrackingBlob([oversized]);
    const frames: unknown[] = [
      oversized,
      toArrayBuffer(oversized),
      Uint8Array.from(Buffer.from(oversized, 'utf8')),
      oversizedBlob,
    ];

    for (const frame of frames) {
      const socket = new FakeWebSocket();
      const errors: Error[] = [];
      const client = new SnowLumaWsClient({
        url: 'ws://localhost:3001/',
        reconnect: false,
        maxFrameBytes: 16,
        webSocketFactory: () => asWebSocket(socket),
      });
      client.onEventError((error) => errors.push(error));
      const connect = client.connect();
      socket.open();
      await connect;

      socket.receive(frame);
      await waitFor(() => assert.equal(socket.closeCode, 1009));
      assert.equal(errors.length, 1);
      assert.match(errors[0]!.message, /frame_too_large/);
      assert.doesNotMatch(errors[0]!.message, /payload-secret/);
      assert.match(socket.closeReason ?? '', /configured limit/);
      client.close();
    }
    assert.equal(oversizedBlob.textCalls, 0);
  });

  it('reports malformed, unsupported, invalid, and unknown packets without logging payloads', async () => {
    const socket = new FakeWebSocket();
    const errors: Error[] = [];
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      reconnect: false,
      webSocketFactory: () => asWebSocket(socket),
    });
    client.onEventError((error) => errors.push(error));
    const connect = client.connect();
    socket.open();
    await connect;

    socket.receive('{"payload":"do-not-log-me"');
    socket.receive({ payload: 'do-not-log-me' });
    socket.receive('null');
    socket.receive(JSON.stringify({ payload: 'do-not-log-me' }));

    await waitFor(() => assert.equal(errors.length, 4));
    assert.deepEqual(
      errors.map((error) => error.message.match(/diagnostic: ([a-z_]+)/)?.[1]),
      ['malformed_json', 'unsupported_frame_type', 'invalid_packet', 'unknown_packet'],
    );
    assert.ok(errors.every((error) => !error.message.includes('do-not-log-me')));
    client.close();
  });

  it('clears queued ingress, queued events, and pending calls across reconnects', async () => {
    const sockets: FakeWebSocket[] = [];
    const events: number[] = [];
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let releaseDecode!: () => void;
    const decodeReleased = new Promise<void>((resolve) => { releaseDecode = resolve; });
    const blocked = new DeferredBlob(
      JSON.stringify({ post_type: 'notice', id: 3 }),
      decodeReleased,
    );
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      initialConnectMaxAttempts: 1,
      reconnectMinDelayMs: 1,
      reconnectMaxDelayMs: 1,
      requestTimeoutMs: 50,
      rawIngressQueueLimit: 4,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
    });
    client.onEvent(async (event) => {
      const id = Number(event['id']);
      events.push(id);
      if (id === 1) await handlerReleased;
    });

    await client.connect();
    const first = sockets[0]!;
    first.receive(JSON.stringify({ post_type: 'notice', id: 1 }));
    first.receive(JSON.stringify({ post_type: 'notice', id: 2 }));
    first.receive(blocked);
    first.receive(JSON.stringify({ post_type: 'notice', id: 4 }));
    await blocked.textStarted;
    await waitFor(() => assert.deepEqual(events, [1]));

    const retiredCall = client.call('get_status');
    await waitFor(() => assert.equal(first.sent.length, 1));
    const retiredEcho = (JSON.parse(first.sent[0]!) as { echo: string }).echo;
    first.close();
    await assert.rejects(retiredCall, /disconnected/);
    await waitFor(() => {
      assert.equal(sockets.length, 2);
      assert.equal(client.isConnected(), true);
    });

    first.receive(JSON.stringify({ echo: retiredEcho, status: 'ok', data: 'stale' }));
    releaseHandler();
    releaseDecode();
    const second = sockets[1]!;
    const replacementCall = client.call('get_status');
    await waitFor(() => assert.equal(second.sent.length, 1));
    const replacementEcho = (JSON.parse(second.sent[0]!) as { echo: string }).echo;
    second.receive(JSON.stringify({ echo: replacementEcho, status: 'ok', retcode: 0, data: 'fresh' }));
    assert.equal(await replacementCall, 'fresh');
    second.receive(JSON.stringify({ post_type: 'notice', id: 5 }));
    await waitFor(() => assert.deepEqual(events, [1, 5]));
    client.close();
  });

  it('correlates concurrent, duplicate, late, and timed-out echoes deterministically', async () => {
    const socket = new FakeWebSocket();
    const client = new SnowLumaWsClient({
      url: 'ws://localhost:3001/',
      reconnect: false,
      requestTimeoutMs: 100,
      webSocketFactory: () => asWebSocket(socket),
    });
    const connect = client.connect();
    socket.open();
    await connect;

    const first = client.call('first');
    const second = client.call('second');
    await waitFor(() => assert.equal(socket.sent.length, 2));
    const firstEcho = (JSON.parse(socket.sent[0]!) as { echo: string }).echo;
    const secondEcho = (JSON.parse(socket.sent[1]!) as { echo: string }).echo;
    socket.receive(JSON.stringify({ echo: secondEcho, status: 'ok', data: 2 }));
    socket.receive(JSON.stringify({ echo: secondEcho, status: 'ok', data: 200 }));
    socket.receive(JSON.stringify({ echo: firstEcho, status: 'ok', data: 1 }));
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);

    const timedOut = client.call('timeout');
    await waitFor(() => assert.equal(socket.sent.length, 3));
    const timedOutEcho = (JSON.parse(socket.sent[2]!) as { echo: string }).echo;
    await assert.rejects(timedOut, /timed out/);
    socket.receive(JSON.stringify({ echo: timedOutEcho, status: 'ok', data: 'late' }));
    const afterTimeout = client.call('after_timeout');
    await waitFor(() => assert.equal(socket.sent.length, 4));
    const afterTimeoutEcho = (JSON.parse(socket.sent[3]!) as { echo: string }).echo;
    socket.receive(JSON.stringify({ echo: afterTimeoutEcho, status: 'ok', data: 'ok' }));
    assert.equal(await afterTimeout, 'ok');
    client.close();
  });
});
