import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { RuntimeHost } from '../../ports/runtime.ts';
import { createProviderDiagnostics } from '../../runtime/provider-telemetry.ts';
import {
  createGuardianOneBotCapabilities,
  createOneBotGateway,
} from '../../runtime/onebot-provider.ts';
import type { NapCatPluginContext } from '../../types/napcat.ts';

const VOID_RESPONSE_ACTIONS = new Set([
  'delete_msg',
  'set_group_ban',
  'set_group_whole_ban',
  'set_group_kick',
  'set_group_add_request',
]);

/**
 * Normalize NapCat's host-owned configuration location to Guardian's
 * provider-neutral directory contract.
 *
 * Current NapCat releases pass `<dataPath>/config.json`; older plugin hosts
 * passed the containing directory. Inspect an existing path first, then use
 * the current `config.json` basename for a not-yet-created installation.
 */
export function resolveNapCatConfigDir(configPath: string): string {
  const absolutePath = resolve(configPath);
  if (existsSync(absolutePath)) {
    return statSync(absolutePath).isDirectory() ? absolutePath : dirname(absolutePath);
  }
  return basename(absolutePath).toLowerCase() === 'config.json'
    ? dirname(absolutePath)
    : absolutePath;
}

/**
 * Adapt the real NapCat plugin API to Guardian's provider-neutral runtime port.
 * The documented empty-response quirk stays isolated in the adapter, while
 * capability checks, request validation, response-envelope normalization, and
 * typed errors are shared with every other OneBot provider.
 */
export function createNapCatRuntimeHost(ctx: NapCatPluginContext): RuntimeHost {
  const provider = createProviderDiagnostics({
    provider: 'napcat',
    transport: 'napcat-action-api',
    isConnected: () => true,
  });
  const onebot = createOneBotGateway({
    identity: 'napcat',
    capabilities: createGuardianOneBotCapabilities(['plugin-api']),
    connectionState: () => provider.snapshot().state,
    invoke: async (action, params) => {
      try {
        return await ctx.actions.call(action, params, ctx.adapterName, ctx.pluginManager.config);
      } catch (error) {
        if (
          VOID_RESPONSE_ACTIONS.has(action)
          && error instanceof Error
          && /no data returned/i.test(error.message)
        ) {
          return null;
        }
        throw error;
      }
    },
  });

  return {
    kind: 'napcat',
    pluginId: ctx.pluginName || 'napcat-plugin-qq-guardian',
    paths: {
      pluginPath: ctx.pluginPath,
      dataPath: ctx.dataPath,
      configDir: resolveNapCatConfigDir(ctx.configPath),
    },
    logger: ctx.logger,
    provider,
    onebot,
    router: ctx.router,
  };
}
