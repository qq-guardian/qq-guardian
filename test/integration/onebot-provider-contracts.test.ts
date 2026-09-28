import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { configManager } from '../../src/core/config/index.ts';
import { bus } from '../../src/core/events/index.ts';
import type { InternalEventPayload } from '../../src/core/events/types.ts';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import { blacklistRepo } from '../../src/database/repositories/blacklist.ts';
import { approvalRepo } from '../../src/database/repositories/approval.ts';
import { plugin_onevent } from '../../src/handlers/event.ts';
import { plugin_onmessage } from '../../src/handlers/message.ts';
import { captchaChallengeCode } from '../../src/modules/captcha/index.ts';
import type { RuntimeHost, RuntimeKind } from '../../src/ports/runtime.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';

interface OneBotCall {
  action: string;
  params: Record<string, unknown>;
}

const MAX_SIGNED_64 = '9223372036854775807';

async function verifyProvider(kind: RuntimeKind, ordinal: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `guardian-${kind}-onebot-`));
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  const selfId = 70_000 + ordinal;
  const groupId = kind === 'snowluma' ? '9007199254740994' : String(80_000 + ordinal);
  const invokerId = 90_000 + ordinal;
  const calls: OneBotCall[] = [];
  const audits: InternalEventPayload<'AuditCreated'>[] = [];
  const onAudit = (event: InternalEventPayload<'AuditCreated'>) => {
    audits.push(event);
  };

  const host: RuntimeHost = {
    kind,
    pluginId: `test-${kind}`,
    paths: { pluginPath: root, dataPath: dataDir, configDir },
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
        if (action === 'get_group_member_info') {
          // Deliberately mix a safe numeric group ID with an exact large
          // string user ID, as both NapCat and SnowLuma deployments may do.
          return { group_id: groupId, user_id: MAX_SIGNED_64, role: 'member' };
        }
        return null;
      },
    },
    router: {} as RuntimeHost['router'],
  };

  try {
    setRuntimeHost(host);
    configManager.init(configDir);
    openDatabase(dataDir);
    configManager.update({
      core: { selfId: String(selfId) },
      approval: { defaultGroupEnabled: true },
      punishment: {
        escalateToKickAfter: 0,
        escalateToBlacklistAfter: 0,
      },
    });
    bus.on('AuditCreated', onAudit);

    const callsBeforeMalformed = calls.length;
    await plugin_onmessage(host, {
      time: 1,
      self_id: selfId,
      post_type: 'message',
      message_type: 'group',
      message_id: 9_007_199_254_740_992,
      user_id: invokerId,
      group_id: groupId,
      raw_message: `/guard mute ${MAX_SIGNED_64} 10`,
      message: [{ type: 'text', data: { text: `/guard mute ${MAX_SIGNED_64} 10` } }],
      sender: { user_id: invokerId, nickname: 'owner', role: 'owner' },
    });
    assert.equal(calls.length, callsBeforeMalformed, `${kind} must reject an unsafe numeric message_id`);

    await plugin_onmessage(host, {
      time: 1,
      self_id: selfId,
      post_type: 'message',
      message_type: 'group',
      message_id: '9007199254740992',
      user_id: invokerId,
      group_id: groupId,
      raw_message: `/guard mute ${MAX_SIGNED_64} 10`,
      message: [
        { type: 'text', data: { text: `/guard mute ${MAX_SIGNED_64} 10` } },
        { type: 'at', data: { qq: `0${MAX_SIGNED_64}` } },
      ],
      sender: { user_id: String(invokerId), nickname: 'owner', role: 'owner' },
    });

    const memberLookup = calls.find((call) => call.action === 'get_group_member_info');
    assert.deepEqual(memberLookup?.params, {
      group_id: String(groupId),
      user_id: MAX_SIGNED_64,
      no_cache: true,
    });
    const mute = calls.find((call) => call.action === 'set_group_ban');
    assert.deepEqual(mute?.params, {
      group_id: String(groupId),
      user_id: MAX_SIGNED_64,
      duration: 600,
    });

    const muteRow = getDatabase().prepare(`
      SELECT group_id, user_id, operator_id,
        typeof(group_id) AS group_type,
        typeof(user_id) AS user_type,
        typeof(operator_id) AS operator_type
      FROM punishment_records
      WHERE type = 'mute'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...muteRow }, {
      group_id: String(groupId),
      user_id: MAX_SIGNED_64,
      operator_id: String(invokerId),
      group_type: 'text',
      user_type: 'text',
      operator_type: 'text',
    });
    assert.ok(audits.some((event) =>
      event.action === 'command.mute'
      && event.actorId === String(invokerId)
      && event.targetId === String(groupId)
    ));
    assert.ok(audits.some((event) =>
      event.action === 'punishment.mute'
      && event.actorId === String(invokerId)
      && event.targetId === MAX_SIGNED_64
    ));

    blacklistRepo.add({
      userId: MAX_SIGNED_64,
      groupId: String(groupId),
      reason: 'provider contract',
      createdBy: String(selfId),
    });

    const callsBeforeMalformedNotice = calls.length;
    await plugin_onevent(host, {
      time: 2,
      self_id: selfId,
      post_type: 'notice',
      notice_type: 'group_increase',
      group_id: groupId,
      user_id: '1e6',
      operator_id: invokerId,
      sub_type: 'approve',
    });
    assert.equal(calls.length, callsBeforeMalformedNotice, `${kind} must reject exponent-form user_id`);

    await plugin_onevent(host, {
      time: 2,
      self_id: String(selfId),
      post_type: 'notice',
      notice_type: 'group_increase',
      group_id: groupId,
      user_id: MAX_SIGNED_64,
      operator_id: invokerId,
      sub_type: 'approve',
    });

    const kick = calls.find((call) => call.action === 'set_group_kick');
    assert.deepEqual(kick?.params, {
      group_id: String(groupId),
      user_id: MAX_SIGNED_64,
      reject_add_request: false,
    });
    const kickRow = getDatabase().prepare(`
      SELECT group_id, user_id, operator_id
      FROM punishment_records
      WHERE type = 'kick'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...kickRow }, {
      group_id: String(groupId),
      user_id: MAX_SIGNED_64,
      operator_id: String(selfId),
    });

    const olderCaptcha = approvalRepo.create({
      groupId: String(groupId),
      userId: MAX_SIGNED_64,
      flag: `${kind}-captcha-older`,
      comment: '',
      status: 'captcha',
      ttlSeconds: 300,
    });
    const newerCaptcha = approvalRepo.create({
      groupId: String(groupId + 100),
      userId: MAX_SIGNED_64,
      flag: `${kind}-captcha-newer`,
      comment: '',
      status: 'captcha',
      ttlSeconds: 300,
    });
    const olderSessionId = `${kind === 'napcat' ? 'a' : 'b'}1111111-1111-4111-8111-111111111111`;
    const newerSessionId = `${kind === 'napcat' ? 'c' : 'd'}2222222-2222-4222-8222-222222222222`;
    const insertCaptcha = getDatabase().prepare(
      `INSERT INTO captcha_sessions (
         id, group_id, user_id, approval_id, type, challenge, answer,
         attempts, max_attempts, created_at, expires_at, solved
       ) VALUES (?, ?, ?, ?, 'question', 'provider challenge', ?, 0, 3, ?, ?, 0)`
    );
    insertCaptcha.run(
      olderSessionId,
      String(groupId),
      MAX_SIGNED_64,
      olderCaptcha.id,
      'older-answer',
      Date.now() - 2_000,
      Date.now() + 300_000,
    );
    insertCaptcha.run(
      newerSessionId,
      String(groupId + 100),
      MAX_SIGNED_64,
      newerCaptcha.id,
      'newer-answer',
      Date.now() - 1_000,
      Date.now() + 300_000,
    );

    await plugin_onmessage(host, {
      time: 3,
      self_id: String(selfId),
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: `${kind === 'napcat' ? '70001' : '70002'}`,
      user_id: MAX_SIGNED_64,
      raw_message: `#${captchaChallengeCode(olderSessionId)} wrong-answer`,
      message: [{
        type: 'text',
        data: { text: `#${captchaChallengeCode(olderSessionId)} wrong-answer` },
      }],
      sender: { user_id: MAX_SIGNED_64, nickname: 'applicant' },
    });
    const captchaAttempts = getDatabase().prepare(
      'SELECT id, attempts FROM captcha_sessions WHERE id IN (?, ?) ORDER BY id'
    ).all(olderSessionId, newerSessionId) as unknown as Array<{ id: string; attempts: number }>;
    assert.equal(captchaAttempts.find((session) => session.id === olderSessionId)?.attempts, 1);
    assert.equal(captchaAttempts.find((session) => session.id === newerSessionId)?.attempts, 0);

    for (const call of calls) {
      if ('group_id' in call.params) assert.equal(typeof call.params['group_id'], 'string');
      if ('user_id' in call.params) assert.equal(typeof call.params['user_id'], 'string');
    }
  } finally {
    bus.off('AuditCreated', onAudit);
    closeDatabase();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('NapCat and SnowLuma canonical OneBot contracts', () => {
  it('preserves identifiers exactly across ingress, actions, locks, audit, and SQLite', async () => {
    await verifyProvider('napcat', 1);
    await verifyProvider('snowluma', 2);
  });
});
