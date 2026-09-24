import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { SnowLumaHttpProvider } from '../../src/platform/snowluma/http-provider.ts';
import { SnowLumaReverseWebSocketProvider } from '../../src/platform/snowluma/reverse-websocket-provider.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('HTTP provider handles actions and authenticated webhook events', async () => {
  const webhookPort = await freePort();
  const provider = new SnowLumaHttpProvider({
    baseUrl: 'http://snowluma.test/',
    webhookPort,
    accessToken: 'test-token',
    fetch: async (_input, init) => {
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, 'Bearer test-token');
      assert.deepEqual(JSON.parse(String(init?.body)), { group_id: '9007199254740993' });
      return Response.json({ status: 'ok', retcode: 0, data: { message_id: '9007199254740995' } });
    },
  });
  const events: Record<string, unknown>[] = [];
  provider.receive((event) => { events.push(event); });
  await provider.connect();
  try {
    assert.deepEqual(await provider.send('get_msg', { group_id: '9007199254740993' }), {
      message_id: '9007199254740995',
    });
    const unauthorized = await fetch(`http://127.0.0.1:${webhookPort}/onebot/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'message' }),
    });
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`http://127.0.0.1:${webhookPort}/onebot/events`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'message', user_id: '9007199254740993' }),
    });
    assert.equal(response.status, 204);
    assert.deepEqual(events, [{ post_type: 'message', user_id: '9007199254740993' }]);
  } finally {
    provider.disconnect();
  }
});

test('reverse WebSocket provider correlates actions and receives events', async () => {
  const port = await freePort();
  const provider = new SnowLumaReverseWebSocketProvider({ port, accessToken: 'test-token' });
  const events: Record<string, unknown>[] = [];
  provider.receive((event) => { events.push(event); });
  await provider.connect();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot`, {
    headers: { authorization: 'Bearer test-token' },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    socket.send(JSON.stringify({ post_type: 'notice', group_id: '9007199254740993' }));
    socket.once('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { echo: string };
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { ok: true } }));
    });
    assert.deepEqual(await provider.send('get_status'), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(events, [{ post_type: 'notice', group_id: '9007199254740993' }]);
  } finally {
    socket.close();
    provider.disconnect();
  }
});

test('inbound providers reject unauthenticated public listeners', async () => {
  const http = new SnowLumaHttpProvider({ baseUrl: 'http://127.0.0.1:3000/', webhookHost: '0.0.0.0', webhookPort: 6100 });
  const reverse = new SnowLumaReverseWebSocketProvider({ host: '0.0.0.0', port: 6101 });
  await assert.rejects(http.connect(), /ACCESS_TOKEN/);
  await assert.rejects(reverse.connect(), /ACCESS_TOKEN/);
});

test('HTTP provider bounds and validates action responses', async () => {
  const provider = new SnowLumaHttpProvider({
    baseUrl: 'http://snowluma.test/',
    webhookPort: await freePort(),
    maxResponseBytes: 16,
    fetch: async () => new Response('{"status":"ok","data":"payload larger than limit"}'),
  });
  await assert.rejects(provider.send('get_status'), /size limit/);

  const malformed = new SnowLumaHttpProvider({
    baseUrl: 'http://snowluma.test/',
    webhookPort: await freePort(),
    fetch: async () => new Response('not-json'),
  });
  await assert.rejects(malformed.send('get_status'), /malformed JSON/);
});

test('a retired reverse socket cannot reject calls owned by its replacement', async () => {
  const port = await freePort();
  const provider = new SnowLumaReverseWebSocketProvider({ port, accessToken: 'test-token' });
  await provider.connect();
  const connectClient = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot`, {
      headers: { authorization: 'Bearer test-token' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  };
  const first = await connectClient();
  const abandoned = provider.send('first_action');
  const abandonedRejected = assert.rejects(abandoned, /replaced/);
  const firstClosed = new Promise<void>((resolve) => first.once('close', () => resolve()));
  const second = await connectClient();
  await abandonedRejected;
  second.once('message', (raw) => {
    const request = JSON.parse(raw.toString()) as { echo: string };
    second.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: 'replacement-result' }));
  });
  await firstClosed;
  assert.equal(await provider.send('second_action'), 'replacement-result');
  second.close();
  provider.disconnect();
});
