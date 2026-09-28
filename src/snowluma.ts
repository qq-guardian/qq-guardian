#!/usr/bin/env node
/**
 * QQ Guardian standalone runtime for SnowLuma.
 *
 * Transport: SnowLuma's forward OneBot v11 WebSocket server.
 * WebUI/API: local standalone HTTP server that mirrors NapCat's plugin URLs,
 * so the existing Guardian WebUI and REST handlers are reused unchanged.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, teardown } from './lifecycle.ts';
import { plugin_onmessage } from './handlers/message.ts';
import { plugin_onevent } from './handlers/event.ts';
import { redactSnowLumaMessage, redactSnowLumaUrl } from './platform/snowluma/client.ts';
import { StandalonePluginRouter } from './platform/snowluma/router.ts';
import { createSnowLumaRuntimeHost } from './platform/snowluma/context.ts';
import { parseSnowLumaSdkFallback, SnowLumaStartupTransport } from './platform/snowluma/factory.ts';
import { SnowLumaHttpProvider } from './platform/snowluma/http-provider.ts';
import { SnowLumaReverseWebSocketProvider } from './platform/snowluma/reverse-websocket-provider.ts';
import {
  DEFAULT_SNOWLUMA_MAX_FRAME_BYTES,
  DEFAULT_SNOWLUMA_RAW_INGRESS_MAX_BYTES,
  DEFAULT_SNOWLUMA_RAW_INGRESS_QUEUE_LIMIT,
} from './platform/snowluma/transport.ts';
import {
  defaultHttpHost,
  detectRuntimeEnvironment,
  readBoundedInteger,
  readPort,
} from './runtime/environment.ts';
import { recordProviderError, recordProviderEvent, recordProviderEventDrop } from './runtime/host.ts';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const pluginPath = runtimeDir;
const environment = detectRuntimeEnvironment();
const dataPath = resolve(process.env['QQ_GUARDIAN_DATA_DIR'] ?? resolve(runtimeDir, 'data'));
const configDir = resolve(process.env['QQ_GUARDIAN_CONFIG_DIR'] ?? resolve(runtimeDir, 'config'));
// The bundled Compose deployment names the SnowLuma service "snowluma".
// Native installations retain loopback defaults; any nonstandard topology is
// configured through SNOWLUMA_WS_URL rather than source edits.
const wsUrl = process.env['SNOWLUMA_WS_URL']?.trim()
  || (environment.isContainer ? 'ws://snowluma:3001/' : 'ws://127.0.0.1:3001/');
const accessToken = process.env['SNOWLUMA_ACCESS_TOKEN']?.trim() || undefined;
const transportKind = process.env['SNOWLUMA_TRANSPORT']?.trim().toLowerCase() || 'forward-websocket';
const sdkFallback = parseSnowLumaSdkFallback(process.env['SNOWLUMA_SDK_FALLBACK']);
const maxFrameBytes = readBoundedInteger(
  process.env['SNOWLUMA_MAX_FRAME_BYTES'],
  DEFAULT_SNOWLUMA_MAX_FRAME_BYTES,
  1_024,
  16_777_216,
);
const rawIngressQueueLimit = readBoundedInteger(
  process.env['SNOWLUMA_RAW_QUEUE_LIMIT'],
  DEFAULT_SNOWLUMA_RAW_INGRESS_QUEUE_LIMIT,
  1,
  4_096,
);
const rawIngressMaxBytes = readBoundedInteger(
  process.env['SNOWLUMA_RAW_QUEUE_BYTES'],
  DEFAULT_SNOWLUMA_RAW_INGRESS_MAX_BYTES,
  1_024,
  67_108_864,
);
const httpHost = process.env['QQ_GUARDIAN_HTTP_HOST']?.trim() || defaultHttpHost(environment);
const httpPort = readPort(process.env['QQ_GUARDIAN_HTTP_PORT'], 6099);

const client = (() => {
  if (transportKind === 'http') {
    return new SnowLumaHttpProvider({
      baseUrl: process.env['SNOWLUMA_HTTP_URL']?.trim() || 'http://127.0.0.1:3000/',
      accessToken,
      webhookHost: process.env['SNOWLUMA_WEBHOOK_HOST']?.trim() || '127.0.0.1',
      webhookPort: readPort(process.env['SNOWLUMA_WEBHOOK_PORT'], 6100),
      webhookPath: process.env['SNOWLUMA_WEBHOOK_PATH']?.trim() || '/onebot/events',
      maxBodyBytes: maxFrameBytes,
    });
  }
  if (transportKind === 'reverse-websocket') {
    return new SnowLumaReverseWebSocketProvider({
      host: process.env['SNOWLUMA_REVERSE_WS_HOST']?.trim() || '127.0.0.1',
      port: readPort(process.env['SNOWLUMA_REVERSE_WS_PORT'], 6101),
      path: process.env['SNOWLUMA_REVERSE_WS_PATH']?.trim() || '/onebot',
      accessToken,
      maxPayloadBytes: maxFrameBytes,
    });
  }
  if (transportKind !== 'forward-websocket') {
    throw new Error('SNOWLUMA_TRANSPORT must be "forward-websocket", "http", or "reverse-websocket"');
  }
  return new SnowLumaStartupTransport({
    url: wsUrl,
    accessToken,
    sdkFallback,
    reconnect: true,
    requestTimeoutMs: 30_000,
    connectionTimeoutMs: 10_000,
    initialConnectMaxAttempts: 5,
    reconnectMinDelayMs: 1_000,
    reconnectMaxDelayMs: 15_000,
    eventQueueLimit: 1_000,
    maxFrameBytes,
    rawIngressQueueLimit,
    rawIngressMaxBytes,
  });
})();
const router = new StandalonePluginRouter(pluginPath);
const host = createSnowLumaRuntimeHost({
  client,
  router,
  pluginPath,
  dataPath,
  configDir,
  providerTransport: () => {
    if (transportKind === 'http') return 'http-webhook';
    if (transportKind === 'reverse-websocket') return 'reverse-websocket';
    if (client instanceof SnowLumaStartupTransport && client.selectedKind) {
      return `forward-websocket-${client.selectedKind}`;
    }
    return 'forward-websocket';
  },
});

let ready = false;
let stopping = false;
const bufferedEvents: Record<string, unknown>[] = [];
const MAX_BUFFERED_EVENTS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatch(event: Record<string, unknown>): Promise<void> {
  const postType = event['post_type'];
  if (postType === 'message' || postType === 'message_sent') {
    await plugin_onmessage(host, event);
    return;
  }
  if (postType === 'request' || postType === 'notice') {
    await plugin_onevent(host, event);
  }
}

client.onEvent(async (event) => {
  const rawEvent = event as Record<string, unknown>;
  if (rawEvent['post_type'] === 'meta_event' && rawEvent['meta_event_type'] === 'heartbeat') {
    recordProviderEvent(true);
  }
  if (!ready) {
    if (bufferedEvents.length >= MAX_BUFFERED_EVENTS) bufferedEvents.shift();
    bufferedEvents.push(event);
    return;
  }
  await dispatch(event);
});

client.onEventError((error) => {
  const diagnostic = recordProviderError(error);
  console.error(
    `[guardian:snowluma] transport/event diagnostic correlation_id=${diagnostic?.correlationId ?? 'unavailable'} category=${diagnostic?.category ?? 'unknown'}`,
    redactSnowLumaMessage(error.message, accessToken),
  );
});
client.onEventDrop((droppedEvents) => {
  const correlationId = recordProviderEventDrop();
  console.warn(`[guardian:snowluma] event queue saturated correlation_id=${correlationId ?? 'unavailable'}; dropped ${droppedEvents} event(s)`);
});

async function shutdown(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  ready = false;
  try { await router.close(); } catch { /* best effort */ }
  try { await teardown(); } catch (error) { console.error('[guardian:snowluma] teardown failed', error); }
  client.close();
  process.exitCode = exitCode;
}

async function main(): Promise<void> {
  console.info(`[guardian:snowluma] starting ${environment.deployment} runtime on ${environment.operatingSystem}`);
  console.info(`[guardian:snowluma] starting ${transportKind} provider${transportKind === 'forward-websocket' ? ` at ${redactSnowLumaUrl(wsUrl)}` : ''}`);
  // Docker Compose / panel stacks may start Guardian before SnowLuma. Keep
  // retrying while the process is healthy instead of terminating the sidecar
  // and relying on a platform-specific restart policy.
  while (!stopping) {
    try {
      await client.connect();
      break;
    } catch (error) {
      console.warn('[guardian:snowluma] connection attempt failed; retrying in 5s', redactSnowLumaMessage(
        error instanceof Error ? error.message : String(error),
        accessToken,
      ));
      await delay(5_000);
    }
  }
  if (stopping) return;
  if (client instanceof SnowLumaStartupTransport && client.selectedKind === 'sdk') {
    console.warn('[guardian:snowluma] native startup failed; using bundled SnowLuma SDK WebSocket fallback');
  }
  console.info(`[guardian:snowluma] OneBot ${transportKind} provider ready`);

  await boot(host);
  await router.listen(httpHost, httpPort);
  ready = true;

  while (bufferedEvents.length > 0) {
    const event = bufferedEvents.shift();
    if (event) await dispatch(event);
  }

  console.info(`[guardian:snowluma] WebUI: http://${httpHost}:${httpPort}/plugin/napcat-plugin-qq-guardian/page/guardian`);
  console.info(`[guardian:snowluma] API:   http://${httpHost}:${httpPort}/plugin/napcat-plugin-qq-guardian/api`);
}

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });

main().catch(async (error) => {
  console.error('[guardian:snowluma] startup failed', redactSnowLumaMessage(
    error instanceof Error ? error.message : String(error),
    accessToken,
  ));
  await shutdown(1);
});
