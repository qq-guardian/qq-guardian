import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configManager } from '../../src/core/config/index.ts';
import { bus } from '../../src/core/events/index.ts';
import { initCurfewModule, minutesOfDayIn, stopCurfewModule } from '../../src/modules/curfew/index.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import type { RuntimeHost } from '../../src/ports/runtime.ts';

interface OneBotCall {
  action: string;
  params: Record<string, unknown>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function clock(minutes: number): string {
  const normalized = (minutes + 24 * 60) % (24 * 60);
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function host(root: string, calls: OneBotCall[], onMute: (enable: boolean) => Promise<void>): RuntimeHost {
  return {
    kind: 'snowluma',
    pluginId: 'curfew-test',
    paths: { pluginPath: root, dataPath: join(root, 'data'), configDir: join(root, 'config') },
    logger: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    onebot: {
      async call(action, params = {}) {
        calls.push({ action, params });
        if (action === 'set_group_whole_ban') await onMute(params.enable === true);
        return null;
      },
    },
    router: {} as RuntimeHost['router'],
  };
}

test('curfew shutdown waits for an in-flight mute and then lifts only that Guardian-managed mute', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-guardian-curfew-'));
  const calls: OneBotCall[] = [];
  const muteStarted = deferred();
  const releaseMute = deferred();
  let holdMute = true;

  try {
    setRuntimeHost(host(root, calls, async (enable) => {
      if (enable && holdMute) {
        muteStarted.resolve();
        await releaseMute.promise;
      }
    }));
    configManager.init(join(root, 'config'));
    const now = minutesOfDayIn('UTC', new Date())!;
    configManager.update({
      core: { timezone: 'UTC' },
      approval: {
        groups: {
          '10001': {
            enabled: true,
            curfewEnabled: true,
            curfewStart: clock(now - 1),
            curfewEnd: clock(now + 1),
          },
        },
      },
    });

    const starting = initCurfewModule();
    await muteStarted.promise;
    let stopped = false;
    const stopping = stopCurfewModule().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false, 'shutdown must wait for the in-flight mute transition');

    holdMute = false;
    releaseMute.resolve();
    await Promise.all([starting, stopping]);

    assert.deepEqual(
      calls
        .filter((call) => call.action === 'set_group_whole_ban')
        .map((call) => call.params.enable),
      [true, false],
      'a successful mute racing with shutdown must be followed by one final unmute',
    );
  } finally {
    await stopCurfewModule();
    bus.removeAllListeners();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
});

test('curfew shutdown starts every managed unmute within one shared deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-guardian-curfew-'));
  const calls: OneBotCall[] = [];
  const releaseUnmutes = deferred();
  let unmuteStarts = 0;

  try {
    setRuntimeHost(host(root, calls, async (enable) => {
      if (!enable) {
        unmuteStarts += 1;
        await releaseUnmutes.promise;
      }
    }));
    configManager.init(join(root, 'config'));
    const now = minutesOfDayIn('UTC', new Date())!;
    configManager.update({
      core: { timezone: 'UTC' },
      approval: {
        groups: {
          '10003': { enabled: true, curfewEnabled: true, curfewStart: clock(now - 1), curfewEnd: clock(now + 1) },
          '10004': { enabled: true, curfewEnabled: true, curfewStart: clock(now - 1), curfewEnd: clock(now + 1) },
          '10005': { enabled: true, curfewEnabled: true, curfewStart: clock(now - 1), curfewEnd: clock(now + 1) },
        },
      },
    });

    await initCurfewModule();
    const stopping = stopCurfewModule();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unmuteStarts, 3, 'all Guardian-managed groups must begin recovery concurrently');

    releaseUnmutes.resolve();
    await stopping;
    assert.deepEqual(
      calls
        .filter((call) => call.action === 'set_group_whole_ban' && call.params.enable === false)
        .map((call) => call.params.group_id)
        .sort(),
      ['10003', '10004', '10005'],
    );
  } finally {
    releaseUnmutes.resolve();
    await stopCurfewModule();
    bus.removeAllListeners();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
});

test('curfew shutdown does not unmute a group Guardian only observed as unmuted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-guardian-curfew-'));
  const calls: OneBotCall[] = [];

  try {
    setRuntimeHost(host(root, calls, async () => {}));
    configManager.init(join(root, 'config'));
    const now = minutesOfDayIn('UTC', new Date())!;
    configManager.update({
      core: { timezone: 'UTC' },
      approval: {
        groups: {
          '10002': {
            enabled: true,
            curfewEnabled: true,
            curfewStart: clock(now + 1),
            curfewEnd: clock(now + 2),
          },
        },
      },
    });

    await initCurfewModule();
    await stopCurfewModule();

    assert.deepEqual(
      calls
        .filter((call) => call.action === 'set_group_whole_ban')
        .map((call) => call.params.enable),
      [false],
      'shutdown must not issue another unmute unless Guardian successfully muted the group',
    );
  } finally {
    await stopCurfewModule();
    bus.removeAllListeners();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
});
