#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIRECT = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
const PRIVATE_TMPFS_OPTIONS = 'rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=0700';
if (DIRECT) {
  main().catch((error) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Deployment image smoke requires a Linux Docker runner');
  const image = requiredOption('--image');
  if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('--image must be an immutable lowercase GHCR digest reference');
  }
  const docker = process.env['DOCKER_EXECUTABLE'] || 'docker';
  run(docker, ['version', '--format', '{{.Server.Version}}']);

  const accessToken = randomBytes(24).toString('hex');
  const mock = await createOneBotMock(accessToken);
  const httpPort = await reservePort();
  const containerName = `qq-guardian-smoke-${process.pid}-${Date.now()}`;
  let started = false;
  try {
    run(docker, buildDeploymentContainerArgs({
      accessToken,
      containerName,
      httpPort,
      image,
      oneBotPort: mock.port,
    }));
    started = true;

    const page = `http://127.0.0.1:${httpPort}/plugin/napcat-plugin-qq-guardian/page/guardian`;
    let response = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        response = await fetch(page, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) break;
      } catch {
        // Startup includes first-run configuration/database migration.
      }
      await delay(1_000);
    }
    if (!response?.ok) {
      const logs = run(docker, ['logs', '--tail', '120', containerName], true).slice(-8_000);
      throw new Error(`Guardian page did not become healthy\n${logs}`);
    }
    if (mock.authenticatedConnections < 1) throw new Error('Guardian never authenticated to the OneBot WebSocket mock');
    mock.broadcast({
      time: Math.floor(Date.now() / 1_000),
      self_id: '10001',
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: true, good: true },
      interval: 5_000,
    });
    await delay(250);
    const inspect = JSON.parse(run(docker, ['inspect', containerName]));
    if (inspect[0]?.State?.Running !== true) throw new Error('Guardian container exited after event ingress');
    console.log(`✓ immutable image started, migrated state, authenticated WS, accepted an event, and served HTTP (${mock.actions.length} startup action(s))`);
  } finally {
    if (started) run(docker, ['rm', '--force', containerName], true);
    await mock.close();
  }
}

export function buildDeploymentContainerArgs({ accessToken, containerName, httpPort, image, oneBotPort }) {
  return [
    'run', '--detach', '--name', containerName, '--network', 'host',
    '--read-only',
    '--tmpfs', '/tmp',
    '--tmpfs', `/guardian/data:${PRIVATE_TMPFS_OPTIONS}`,
    '--tmpfs', `/guardian/config:${PRIVATE_TMPFS_OPTIONS}`,
    '--env', `SNOWLUMA_WS_URL=ws://127.0.0.1:${oneBotPort}/onebot`,
    '--env', `SNOWLUMA_ACCESS_TOKEN=${accessToken}`,
    '--env', 'SNOWLUMA_SDK_FALLBACK=off',
    '--env', 'QQ_GUARDIAN_HTTP_HOST=127.0.0.1',
    '--env', `QQ_GUARDIAN_HTTP_PORT=${httpPort}`,
    image,
  ];
}

export async function createOneBotMock(accessToken) {
  const sockets = new Set();
  const actions = [];
  let authenticatedConnections = 0;
  const server = createServer((_, response) => {
    response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.searchParams.get('access_token') !== accessToken) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'));
      authenticatedConnections += 1;
      sockets.add(socket);
      let retained = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        retained = Buffer.concat([retained, chunk]);
        const decoded = decodeClientFrames(retained);
        retained = decoded.remainder;
        for (const frame of decoded.frames) {
          if (frame.opcode === 0x8) {
            socket.end(encodeServerFrame(Buffer.alloc(0), 0x8));
          } else if (frame.opcode === 0x9) {
            socket.write(encodeServerFrame(frame.payload, 0xA));
          } else if (frame.opcode === 0x1) {
            const message = JSON.parse(frame.payload.toString('utf8'));
            if (typeof message?.action !== 'string' || typeof message?.echo !== 'string') continue;
            actions.push(message.action);
            socket.write(encodeServerTextFrame(JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: actionData(message.action, message.params),
              echo: message.echo,
            })));
          }
        }
      });
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    } catch {
      socket.destroy();
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate OneBot mock port');
  return {
    port: address.port,
    actions,
    get authenticatedConnections() { return authenticatedConnections; },
    broadcast(payload) {
      const frame = encodeServerTextFrame(JSON.stringify(payload));
      for (const socket of sockets) socket.write(frame);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

export function encodeServerTextFrame(value) {
  return encodeServerFrame(Buffer.from(value, 'utf8'), 0x1);
}

function encodeServerFrame(payload, opcode) {
  if (payload.length > 1_048_576) throw new Error('Mock WebSocket frame exceeds 1 MiB');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xFFFF) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function decodeClientFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if ((first & 0x80) === 0) throw new Error('Fragmented mock WebSocket frames are unsupported');
    const opcode = first & 0x0F;
    const masked = (second & 0x80) !== 0;
    if (!masked) throw new Error('Client WebSocket frame is not masked');
    let length = second & 0x7F;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const wide = buffer.readBigUInt64BE(offset + 2);
      if (wide > 1_048_576n) throw new Error('Client WebSocket frame exceeds 1 MiB');
      length = Number(wide);
      headerLength = 10;
    }
    if (length > 1_048_576) throw new Error('Client WebSocket frame exceeds 1 MiB');
    const frameLength = headerLength + 4 + length;
    if (offset + frameLength > buffer.length) break;
    const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
    const payload = Buffer.from(buffer.subarray(offset + headerLength + 4, offset + frameLength));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    frames.push({ opcode, payload });
    offset += frameLength;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

function actionData(action, params) {
  if (action === 'get_login_info') return { user_id: '10001', nickname: 'Guardian smoke' };
  if (action === 'get_group_list' || action === 'get_friend_list' || action === 'get_group_member_list') return [];
  if (action === 'get_group_system_msg') return { invited_requests: [], join_requests: [] };
  if (action === 'get_group_member_info') {
    return {
      group_id: params?.group_id ?? '30001',
      user_id: params?.user_id ?? '20001',
      nickname: 'Smoke member',
      role: 'member',
    };
  }
  if (action === 'get_status') return { online: true, good: true };
  return null;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve HTTP smoke port');
  const port = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

function run(executable, args, allowFailure = false) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const output = mergeProcessOutput(result.stdout, result.stderr);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed: ${output || 'unknown error'}`);
  }
  return output;
}

export function mergeProcessOutput(stdout, stderr) {
  return [stdout, stderr]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('\n');
}

function requiredOption(name) {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) throw new Error(`${name}=... is required`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
