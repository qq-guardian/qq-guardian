import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bus } from '../../src/core/events/index.ts';
import { blacklistRepo } from '../../src/database/repositories/blacklist.ts';
import { punishmentRepo } from '../../src/database/repositories/punishment.ts';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import { configManager } from '../../src/core/config/index.ts';
import { punishmentService } from '../../src/modules/punishment/index.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import type { InternalEventMap } from '../../src/core/events/types.ts';
import type { PunishmentConfig } from '../../src/core/config/types.ts';
import type { RuntimeHost, RuntimeKind } from '../../src/ports/runtime.ts';

interface OneBotCall {
  action: string;
  params: Record<string, unknown>;
}

interface Harness {
  calls: OneBotCall[];
  audits: InternalEventMap['AuditCreated'][];
}

async function withHarness(
  kind: RuntimeKind,
  punishment: Partial<PunishmentConfig>,
  run: (harness: Harness) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'qq-guardian-punishment-escalation-'));
  const calls: OneBotCall[] = [];
  const audits: InternalEventMap['AuditCreated'][] = [];
  const onAudit = (event: InternalEventMap['AuditCreated']) => {
    audits.push(event);
  };
  const host: RuntimeHost = {
    kind,
    pluginId: 'test',
    paths: {
      pluginPath: root,
      dataPath: join(root, 'data'),
      configDir: join(root, 'config'),
    },
    logger: {
      log() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    onebot: {
      async call(action, params = {}) {
        calls.push({ action, params });
        await Promise.resolve();
        return null;
      },
    },
    router: {} as RuntimeHost['router'],
  };

  try {
    setRuntimeHost(host);
    configManager.init(host.paths.configDir);
    openDatabase(host.paths.dataPath);
    configManager.update({ punishment });
    bus.on('AuditCreated', onAudit);
    await run({ calls, audits });
  } finally {
    bus.off('AuditCreated', onAudit);
    closeDatabase();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
}

test('the default mute sequence cannot satisfy the kick-only blacklist threshold', async (t) => {
  for (const kind of ['napcat', 'snowluma'] as const) {
    await t.test(kind, async () => {
      await withHarness(kind, {}, async ({ calls }) => {
        for (let index = 0; index < 4; index += 1) {
          await punishmentService.mute('10001', '20001', 3600, `mute-${index + 1}`, '30001');
        }

        assert.equal(punishmentRepo.countActivePunishmentsByUser('20001', '10001'), 5);
        assert.equal(punishmentRepo.countActiveKicksByUser('20001', '10001'), 1);
        assert.equal(
          blacklistRepo.isBlacklisted('20001', '10001'),
          false,
          'four mutes and one kick must not satisfy the default five-kick threshold'
        );

        const muteCalls = calls.filter((call) => call.action === 'set_group_ban');
        const kickCalls = calls.filter((call) => call.action === 'set_group_kick');
        assert.equal(muteCalls.length, 4);
        assert.equal(kickCalls.length, 1, 'three active mutes should create one automatic kick');
        assert.deepEqual(kickCalls[0]?.params, {
          group_id: '10001',
          user_id: '20001',
          reject_add_request: false,
        });
      });
    });
  }
});

test('expired and revoked records do not qualify for either escalation threshold', async () => {
  await withHarness('snowluma', {
    escalateToKickAfter: 2,
    escalateToBlacklistAfter: 2,
  }, async ({ calls }) => {
    const expiredMute = punishmentRepo.create({
      groupId: '11001',
      userId: '21001',
      type: 'mute',
      durationSeconds: 60,
      reason: 'expired',
      operatorId: '31001',
    });
    getDatabase().prepare('UPDATE punishment_records SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, expiredMute.id);
    const revokedMute = punishmentRepo.create({
      groupId: '11001',
      userId: '21001',
      type: 'mute',
      durationSeconds: 3600,
      reason: 'revoked',
      operatorId: '31001',
    });
    punishmentRepo.revoke(revokedMute.id, '31002');

    await punishmentService.mute('11001', '21001', 3600, 'active', '31001');
    assert.equal(punishmentRepo.countActivePunishmentsByUser('21001', '11001'), 1);
    assert.equal(calls.filter((call) => call.action === 'set_group_kick').length, 0);

    const expiredKick = punishmentRepo.create({
      groupId: '11002',
      userId: '21002',
      type: 'kick',
      durationSeconds: null,
      reason: 'expired',
      operatorId: '31001',
    });
    getDatabase().prepare('UPDATE punishment_records SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, expiredKick.id);
    const revokedKick = punishmentRepo.create({
      groupId: '11002',
      userId: '21002',
      type: 'kick',
      durationSeconds: null,
      reason: 'revoked',
      operatorId: '31001',
    });
    punishmentRepo.revoke(revokedKick.id, '31002');

    await punishmentService.kick('11002', '21002', 'active', '31001');
    assert.equal(punishmentRepo.countActiveKicksByUser('21002', '11002'), 1);
    assert.equal(blacklistRepo.isBlacklisted('21002', '11002'), false);
  });
});

test('zero thresholds disable automatic kick and blacklist escalation', async () => {
  await withHarness('napcat', {
    escalateToKickAfter: 0,
    escalateToBlacklistAfter: 0,
  }, async ({ calls, audits }) => {
    await Promise.all([
      punishmentService.mute('12001', '22001', 3600, 'one', '32001'),
      punishmentService.mute('12001', '22001', 3600, 'two', '32001'),
    ]);
    await punishmentService.kick('12001', '22001', 'explicit', '32001');

    assert.equal(calls.filter((call) => call.action === 'set_group_kick').length, 1);
    assert.equal(blacklistRepo.isBlacklisted('22001', '12001'), false);
    assert.equal(audits.some((event) => event.action === 'punishment.auto_kick'), false);
    assert.equal(audits.some((event) => event.action === 'blacklist.auto_add'), false);
  });
});

test('the unset runtime actor is recorded as NULL after a successful automated action', async () => {
  await withHarness('snowluma', {
    escalateToKickAfter: 0,
    escalateToBlacklistAfter: 1,
  }, async ({ calls, audits }) => {
    const kick = await punishmentService.kick('12501', '22501', 'automated policy', '0');
    assert.equal(kick.operator_id, null);
    assert.equal(calls.filter((call) => call.action === 'set_group_kick').length, 1);
    assert.deepEqual(
      { ...getDatabase().prepare(`
        SELECT operator_id, typeof(operator_id) AS operator_type
        FROM punishment_records WHERE id = ?
      `).get(kick.id) },
      { operator_id: null, operator_type: 'null' },
    );
    assert.deepEqual(
      { ...getDatabase().prepare(`
        SELECT created_by, typeof(created_by) AS creator_type
        FROM blacklist WHERE user_id = ? AND group_id = ?
      `).get('22501', '12501') },
      { created_by: null, creator_type: 'null' },
    );
    assert.equal(audits.find((event) => event.action === 'punishment.kick')?.actorId, null);
    assert.equal(audits.find((event) => event.action === 'blacklist.auto_add')?.actorId, null);
  });
});

test('concurrent mutes create at most one automatic kick and blacklist entry', async () => {
  await withHarness('snowluma', {
    escalateToKickAfter: 2,
    escalateToBlacklistAfter: 1,
  }, async ({ calls, audits }) => {
    await Promise.all([
      punishmentService.mute('13001', '23001', 3600, 'one', '33001'),
      punishmentService.mute('13001', '23001', 3600, 'two', '33001'),
    ]);

    assert.equal(calls.filter((call) => call.action === 'set_group_ban').length, 2);
    assert.equal(calls.filter((call) => call.action === 'set_group_kick').length, 1);
    assert.equal(punishmentRepo.countActiveKicksByUser('23001', '13001'), 1);
    const blacklistCount = getDatabase()
      .prepare('SELECT COUNT(*) AS cnt FROM blacklist WHERE user_id = ? AND group_id = ?')
      .get('23001', '13001') as { cnt: number };
    assert.equal(Number(blacklistCount.cnt), 1);

    const autoKickAudits = audits.filter((event) => event.action === 'punishment.auto_kick');
    const blacklistAudits = audits.filter((event) => event.action === 'blacklist.auto_add');
    assert.equal(autoKickAudits.length, 1);
    assert.deepEqual(autoKickAudits[0]?.details, {
      groupId: '13001',
      qualifyingPunishmentCount: 2,
      threshold: 2,
    });
    assert.equal(blacklistAudits.length, 1);
    assert.deepEqual(blacklistAudits[0]?.details, {
      groupId: '13001',
      qualifyingKickCount: 1,
      threshold: 1,
    });
  });
});

test('blacklist escalation counts qualifying kicks and ignores mutes', async () => {
  await withHarness('napcat', {
    escalateToKickAfter: 0,
    escalateToBlacklistAfter: 3,
  }, async ({ audits }) => {
    await Promise.all([
      punishmentService.mute('14001', '24001', 3600, 'mute-one', '34001'),
      punishmentService.mute('14001', '24001', 3600, 'mute-two', '34001'),
      punishmentService.kick('14001', '24001', 'kick-one', '34001'),
      punishmentService.kick('14001', '24001', 'kick-two', '34001'),
    ]);
    assert.equal(blacklistRepo.isBlacklisted('24001', '14001'), false);

    await punishmentService.kick('14001', '24001', 'kick-three', '34001');
    assert.equal(blacklistRepo.isBlacklisted('24001', '14001'), true);

    const audit = audits.find((event) => event.action === 'blacklist.auto_add');
    assert.deepEqual(audit?.details, {
      groupId: '14001',
      qualifyingKickCount: 3,
      threshold: 3,
    });
  });
});
