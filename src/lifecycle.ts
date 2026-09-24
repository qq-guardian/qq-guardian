/**
 * Guardian's composition root. Platform adapters construct a RuntimeHost;
 * this module wires that host to the application services without importing a
 * NapCat-specific context.
 */
import { join, dirname } from 'node:path';
import { chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { setRuntimeHost, clearRuntimeHost } from './runtime/host.ts';
import { configManager } from './core/config/index.ts';
import { getLogger } from './core/logger/index.ts';
import { openDatabase, closeDatabase } from './database/index.ts';
import { initAuditModule, stopAuditModule } from './modules/audit/index.ts';
import { initCurfewModule, stopCurfewModule } from './modules/curfew/index.ts';
import { initStatisticsModule, stopStatisticsModule } from './modules/statistics/index.ts';
import { initMonitorModule, stopMonitorModule } from './modules/monitor/index.ts';
import { captchaService } from './modules/captcha/index.ts';
import { riskService } from './modules/risk/index.ts';
import { privateAIEndpointStartupWarning, PRIVATE_AI_ENDPOINTS_ENV } from './modules/risk/ai.ts';
import { intelService } from './modules/intel/index.ts';
import { initApprovalSync, stopApprovalSync } from './modules/approval/sync.ts';
import { ensureBootstrapAdmin } from './modules/auth/index.ts';
import { registerRoutes } from './api/index.ts';
import { checkForUpdate, setCurrentVersion } from './modules/update/index.ts';
import { bootstrapGroups } from './modules/groups/index.ts';
import { bus } from './core/events/index.ts';
import { runGuardianShadowMigration } from './migration/index.ts';
import type { RuntimeHost } from './ports/runtime.ts';

type LifecycleState = 'idle' | 'booting' | 'running' | 'stopping';

let state: LifecycleState = 'idle';
let bootPromise: Promise<void> | null = null;
let generation = 0;

function readPackageVersion(pluginPath: string): string {
  try {
    const packagePath = join(pluginPath, 'package.json');
    if (existsSync(packagePath)) {
      return (JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string }).version ?? '1.0.0';
    }
  } catch {
    // A missing or malformed package manifest must not prevent protection.
  }
  return '1.0.0';
}

/** Create Guardian-owned durable directories as private as the host allows. */
function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    // Windows may ignore POSIX modes. On POSIX this only tightens access; it
    // never makes an existing directory less private.
    chmodSync(directory, 0o700);
  } catch {
    // Some container and mobile filesystems do not expose chmod semantics.
  }
}

/** Stop every resource acquired by boot. Every step is intentionally isolated
 * so a failed cleanup hook cannot leave the database, event bus, or runtime
 * host live during reload. */
async function cleanup(): Promise<void> {
  const steps: Array<() => void | Promise<void>> = [
    () => stopAuditModule(),
    () => captchaService.stop(),
    () => stopApprovalSync(),
    () => intelService.stop(),
    () => stopCurfewModule(),
    () => stopMonitorModule(),
    () => stopStatisticsModule(),
    () => closeDatabase(),
    () => bus.removeAllListeners(),
    () => clearRuntimeHost(),
  ];

  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.error('[qq-guardian] cleanup step failed', error);
    }
  }
}

function ensureBootIsCurrent(expectedGeneration: number): void {
  if (state !== 'booting' || generation !== expectedGeneration) {
    throw new Error('Guardian startup was interrupted by teardown');
  }
}

function registerWebUi(host: RuntimeHost): void {
  const { pluginPath } = host.paths;
  const candidates = [
    { absolute: join(pluginPath, 'dist', 'webui', 'index.html'), relative: 'dist/webui/index.html' },
    { absolute: join(pluginPath, 'webui', 'index.html'), relative: 'webui/index.html' },
  ];
  const found = candidates.find((candidate) => existsSync(candidate.absolute));
  const log = getLogger().child({ module: 'lifecycle' });

  if (!found) {
    log.warn('WebUI index.html not found; run pnpm build');
    return;
  }

  host.router.static('/static', dirname(found.relative));
  host.router.page({
    path: 'guardian',
    title: 'QQ Guardian',
    icon: '🛡️',
    htmlFile: found.relative,
    description: 'QQ Group Guardian management panel',
  });
  log.info({ htmlFile: found.relative }, 'WebUI registered');
}

/**
 * Start Guardian once for the supplied host. A concurrent caller receives the
 * same startup promise. Teardown invalidates the generation, making a partial
 * asynchronous boot fail closed rather than resurrecting resources afterward.
 */
export async function boot(host: RuntimeHost): Promise<void> {
  if (state === 'running') return;
  if (state === 'booting' && bootPromise) return bootPromise;
  if (state === 'stopping') throw new Error('Guardian is stopping; wait for teardown to complete');

  state = 'booting';
  const bootGeneration = ++generation;
  const task = (async () => {
    const log = getLogger().child({ module: 'lifecycle' });
    try {
      setRuntimeHost(host);
      const { dataPath, configDir, pluginPath } = host.paths;
      for (const directory of [dataPath, join(dataPath, 'backups'), configDir]) {
        ensurePrivateDirectory(directory);
      }
      log.info({ runtime: host.kind }, 'Plugin booting');

      // This is the only point that may upgrade persistent storage. It runs
      // before either normal manager opens a live file, and refuses to boot if
      // staging/validation/recovery cannot prove a coherent generation.
      const migration = await runGuardianShadowMigration({ configDir, dataDir: dataPath });
      log.info({ migration: migration.status, backupDir: migration.backupDir }, 'Persistent storage migration checked');
      configManager.init(configDir);
      const config = configManager.get();
      const unsafeAiWarning = privateAIEndpointStartupWarning();
      if (unsafeAiWarning) {
        log.warn({ setting: PRIVATE_AI_ENDPOINTS_ENV }, unsafeAiWarning);
      }
      ensureBootIsCurrent(bootGeneration);

      openDatabase(dataPath);
      ensureBootIsCurrent(bootGeneration);
      log.info('Database ready');

      initAuditModule();
      await initCurfewModule();
      initStatisticsModule();
      initMonitorModule();
      captchaService.init();
      riskService.reloadRules();
      intelService.init();
      ensureBootIsCurrent(bootGeneration);

      await ensureBootstrapAdmin();
      ensureBootIsCurrent(bootGeneration);

      registerWebUi(host);
      registerRoutes();
      log.info('API routes registered');

      await bootstrapGroups();
      ensureBootIsCurrent(bootGeneration);
      initApprovalSync();

      const version = readPackageVersion(pluginPath);
      setCurrentVersion(version);
      if (config.update.autoCheckOnStartup) {
        void checkForUpdate().then((info) => {
          if (info) log.info({ version: info.version }, 'Update available');
        }).catch((error) => log.debug(error, 'Update check skipped'));
      }

      ensureBootIsCurrent(bootGeneration);
      state = 'running';
      log.info({ version }, 'Plugin boot complete');
    } catch (error) {
      log.error(error, 'Boot failed; cleaning up partial initialization');
      await cleanup();
      if (state === 'booting' && generation === bootGeneration) state = 'idle';
      throw error;
    }
  })();

  bootPromise = task;
  try {
    await task;
  } finally {
    if (bootPromise === task) bootPromise = null;
  }
}

/** Safe during idle, boot, and running states. */
export async function teardown(): Promise<void> {
  if (state === 'idle' || state === 'stopping') return;
  const log = getLogger().child({ module: 'lifecycle' });
  const inFlightBoot = bootPromise;
  state = 'stopping';
  generation += 1;
  log.info('Plugin tearing down');
  await cleanup();

  if (inFlightBoot) {
    try {
      await inFlightBoot;
    } catch {
      // The interrupted boot is expected to reject after generation changes.
    }
  }
  state = 'idle';
  log.info('Plugin teardown complete');
}
