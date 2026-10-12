#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const webuiRoot = resolve(root, 'dist/webui');
const port = Number.parseInt(process.env['PLAYWRIGHT_PORT'] ?? '6099', 10);
const pluginRoot = '/plugin/napcat-plugin-qq-guardian';
const pagePath = `${pluginRoot}/page/guardian`;
const apiRoot = `${pluginRoot}/api`;
const users = new Map();

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PLAYWRIGHT_PORT must be a valid TCP port');
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { code: 1, message: 'Smoke fixture failed', details: message });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`WebUI smoke fixture listening on http://127.0.0.1:${port}`);
});

async function handleRequest(request, response) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/__health') {
    response.writeHead(204).end();
    return;
  }

  if (request.method === 'GET' && url.pathname === pagePath) {
    await sendFile(response, 'index.html', 'text/html; charset=utf-8');
    return;
  }

  const staticMatch = /\/files\/static\/(app\.js|release-view\.js|user-security\.js)$/.exec(url.pathname);
  if (request.method === 'GET' && staticMatch) {
    await sendFile(response, staticMatch[1], 'text/javascript; charset=utf-8');
    return;
  }

  if (url.pathname.startsWith(`${apiRoot}/`)) {
    await handleApi(request, response, url.pathname.slice(apiRoot.length));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
}

async function handleApi(request, response, path) {
  if (request.method === 'POST' && path === '/auth/register') {
    const body = await readJson(request);
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      sendJson(response, 400, { code: 1, message: 'Invalid registration payload' });
      return;
    }
    users.set(body.username, body.password);
    sendJson(response, 201, { code: 0, data: { username: body.username } });
    return;
  }

  if (request.method === 'POST' && path === '/auth/login') {
    const body = await readJson(request);
    if (users.get(body.username) !== body.password) {
      sendJson(response, 401, { code: 1, message: 'Invalid credentials' });
      return;
    }
    const token = createSmokeAccessToken();
    sendJson(response, 200, { code: 0, data: { accessToken: token } }, {
      'Set-Cookie': 'qqg_refresh=smoke-refresh; Path=/; HttpOnly; SameSite=Strict',
    });
    return;
  }

  if (request.method === 'POST' && path === '/auth/refresh') {
    sendJson(response, 401, { code: 1, message: 'No smoke session' }, {
      'Set-Cookie': 'qqg_refresh=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    });
    return;
  }

  if (request.method === 'POST' && path === '/auth/logout') {
    sendJson(response, 200, { code: 0, data: null }, {
      'Set-Cookie': 'qqg_refresh=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    });
    return;
  }

  if (request.method === 'GET' && path === '/stats') {
    sendJson(response, 200, { code: 0, data: {
      totals: {
        approvals_total: 0,
        approvals_passed: 0,
        approvals_rejected: 0,
        punishments_total: 0,
        risk_detections: 0,
        captchas_passed: 0,
      },
      approvalCounts: { pending: 0, captcha: 0 },
    } });
    return;
  }

  if (request.method === 'GET' && path === '/bot/info') {
    sendJson(response, 200, { code: 0, data: { nickname: 'Smoke Bot', user_id: '10001' } });
    return;
  }

  if (request.method === 'GET' && path === '/groups') {
    sendJson(response, 200, { code: 0, data: [] });
    return;
  }

  if (request.method === 'GET' && path === '/config') {
    sendJson(response, 200, { code: 0, data: {
      core: { selfId: '10001', timezone: 'Asia/Shanghai' },
      risk: { detectorActions: {}, muteDurationSeconds: 600, aiMinScore: 70, recallMessage: false },
      approval: { useBuiltinRejectKeywords: false, useBuiltinApproveKeywords: false },
      intel: { enabled: false },
      commands: { enabled: true, prefix: '/guard' },
      update: { githubRepo: 'owner/repository' },
    } });
    return;
  }

  if (request.method === 'GET' && path === '/update/check') {
    sendJson(response, 200, { code: 0, data: { current: '1.4.10' } });
    return;
  }

  sendJson(response, 404, { code: 1, message: `Unhandled smoke API: ${request.method} ${path}` });
}

function createSmokeAccessToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 1, role: 'super_admin', exp: Math.floor(Date.now() / 1_000) + 900 })).toString('base64url');
  return `${header}.${payload}.smoke-signature`;
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > 65_536) throw new Error('Smoke request body is too large');
  }
  return JSON.parse(body || '{}');
}

async function sendFile(response, name, contentType) {
  try {
    const content = await readFile(resolve(webuiRoot, name));
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }).end(content);
  } catch {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Run the WebUI build before starting the smoke fixture');
  }
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(data));
}
