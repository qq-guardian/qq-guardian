import type {
  GuardianLogger,
  OneBotCapabilities,
  OneBotProviderIdentity,
  RuntimeHost,
} from '../../ports/runtime.ts';
import { createProviderDiagnostics } from '../../runtime/provider-telemetry.ts';
import {
  createGuardianOneBotCapabilities,
  createOneBotGateway,
} from '../../runtime/onebot-provider.ts';
import { StandalonePluginRouter } from './router.ts';
import type { SnowLumaTransport } from './transport.ts';

function createConsoleLogger(): GuardianLogger {
  return {
    log: (...args) => console.log(...args),
    debug: (...args) => console.debug(...args),
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

export interface SnowLumaRuntimeHostOptions {
  client: SnowLumaTransport;
  router: StandalonePluginRouter;
  pluginPath: string;
  dataPath: string;
  configDir: string;
  providerTransport?: string | (() => string);
  /** Allows a compatible generic endpoint to retain its protocol identity. */
  providerIdentity?: OneBotProviderIdentity;
  /** Optional narrowed capabilities for a compatible endpoint. */
  providerCapabilities?: OneBotCapabilities;
}

/**
 * SnowLuma composition adapter. It exposes only Guardian's explicit ports;
 * no synthetic NapCat configuration object or plugin-manager compatibility
 * layer is retained in the standalone runtime.
 */
export function createSnowLumaRuntimeHost(options: SnowLumaRuntimeHostOptions): RuntimeHost {
  const identity = options.providerIdentity ?? 'snowluma';
  const transportLabel = () => typeof options.providerTransport === 'function'
    ? options.providerTransport()
    : options.providerTransport ?? 'forward-websocket';
  const provider = createProviderDiagnostics({
    provider: identity,
    transport: transportLabel,
    isConnected: () => options.client.isConnected(),
  });
  const onebot = createOneBotGateway({
    identity,
    capabilities: options.providerCapabilities ?? createGuardianOneBotCapabilities([transportLabel()]),
    connectionState: () => provider.snapshot().state,
    invoke: (action, params) => options.client.call(action, params),
  });

  return {
    kind: 'snowluma',
    pluginId: 'napcat-plugin-qq-guardian',
    paths: {
      pluginPath: options.pluginPath,
      dataPath: options.dataPath,
      configDir: options.configDir,
    },
    logger: createConsoleLogger(),
    provider,
    onebot,
    router: options.router,
  };
}
