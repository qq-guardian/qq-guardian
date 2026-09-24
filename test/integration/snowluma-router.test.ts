import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StandalonePluginRouter } from '../../src/platform/snowluma/router.ts';

const API_BASE = '/plugin/napcat-plugin-qq-guardian/api';
const FILE_BASE = '/plugin/napcat-plugin-qq-guardian/files';
const PAGE_BASE = '/plugin/napcat-plugin-qq-guardian/page';

describe('SnowLuma standalone HTTP router', () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-snowluma-router-'));
  const webui = join(root, 'webui');
  const port = 20_000 + (process.pid % 20_000);
  const origin = `http://127.0.0.1:${port}`;
  const router = new StandalonePluginRouter(root, {
    bodyLimitBytes: 64,
    requestTimeoutMs: 500,
    shutdownGracePeriodMs: 25,
  });
  let oversizedHandlerCalled = false;

  before(async () => {
    mkdirSync(webui, { recursive: true });
    writeFileSync(join(webui, 'index.html'), '<!doctype html><title>Guardian Test</title>', 'utf8');
    writeFileSync(join(webui, 'app.js'), 'globalThis.guardianLoaded = true;\n', 'utf8');

    router.static('/static', 'webui');
    router.page({ path: 'guardian', title: 'Guardian', htmlFile: 'webui/index.html' });
    router.postNoAuth('/echo/:id', (req, res) => {
      res.status(201).json({ id: req.params['id'], body: req.body, query: req.query });
    });
    router.postNoAuth('/limited', (_req, res) => {
      oversizedHandlerCalled = true;
      res.status(201).json({ accepted: true });
    });
    router.getNoAuth('/throws', () => {
      throw new Error('internal endpoint detail');
    });
    router.getNoAuth('/hold', async () => await new Promise<void>(() => {}));

    await router.listen('127.0.0.1', port);
  });

  after(async () => {
    await router.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the registered Guardian page', async () => {
    const res = await fetch(`${origin}${PAGE_BASE}/guardian`);
    assert.equal(res.status, 200);
    const contentSecurityPolicy = res.headers.get('content-security-policy') ?? '';
    assert.match(contentSecurityPolicy, /script-src 'self'(?:;|$)/);
    assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/);
    assert.match(await res.text(), /Guardian Test/);
  });

  it('serves external WebUI JavaScript from the plugin static-file route', async () => {
    const res = await fetch(`${origin}${FILE_BASE}/static/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(await res.text(), 'globalThis.guardianLoaded = true;\n');
  });

  it('dispatches JSON API requests with params and query values', async () => {
    const res = await fetch(`${origin}${API_BASE}/echo/42?tag=a&tag=b`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 201);
    const data = await res.json() as { id: string; body: unknown; query: Record<string, unknown> };
    assert.equal(data.id, '42');
    assert.deepEqual(data.body, { enabled: false });
    assert.deepEqual(data.query.tag, ['a', 'b']);
  });

  it('rejects an oversized body before invoking the route handler', async () => {
    const res = await fetch(`${origin}${API_BASE}/limited`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(65),
    });
    assert.equal(res.status, 413);
    assert.equal(await res.text(), 'Request body too large');
    assert.equal(oversizedHandlerCalled, false);
  });

  it('does not expose route exceptions to callers', async () => {
    const res = await fetch(`${origin}${API_BASE}/throws`);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'Internal server error');
  });

  it('force-closes an active connection after the configured shutdown grace period', async () => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.write(`GET ${API_BASE}/hold HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
    const socketClosed = once(socket, 'close');

    await Promise.race([
      router.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('router shutdown timed out')), 500)),
    ]);
    await socketClosed;
  });
});
