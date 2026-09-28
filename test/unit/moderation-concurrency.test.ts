import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configManager } from '../../src/core/config/index.ts';
import { approvalRepo } from '../../src/database/repositories/approval.ts';
import { punishmentRepo } from '../../src/database/repositories/punishment.ts';
import { statisticsRepo } from '../../src/database/repositories/statistics.ts';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import { approvalService } from '../../src/modules/approval/index.ts';
import { captchaService } from '../../src/modules/captcha/index.ts';
import { punishmentService } from '../../src/modules/punishment/index.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import type { RuntimeHost } from '../../src/ports/runtime.ts';

interface OneBotCall {
  action: string;
  params: Record<string, unknown>;
}

function joinRequest(groupId: number, userId: number, flag: string) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: '1',
    post_type: 'request' as const,
    request_type: 'group' as const,
    sub_type: 'add' as const,
    group_id: String(groupId),
    user_id: String(userId),
    comment: '',
    flag,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('approval, captcha, and revocation transitions are serialized around OneBot actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-guardian-moderation-'));
  const calls: OneBotCall[] = [];
  let failNextApproval = false;
  let moderationGate: Promise<void> | null = null;
  let signalModerationStarted: (() => void) | null = null;

  const host: RuntimeHost = {
    kind: 'snowluma',
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
        if (action === 'set_group_add_request') {
          signalModerationStarted?.();
          if (failNextApproval) {
            failNextApproval = false;
            throw new Error('OneBot unavailable');
          }
          await moderationGate;
        }
        return null;
      },
    },
    router: {} as RuntimeHost['router'],
  };

  try {
    setRuntimeHost(host);
    configManager.init(host.paths.configDir);
    openDatabase(host.paths.dataPath);
    configManager.update({
      approval: {
        defaultGroupEnabled: true,
        defaultAction: 'auto_approve',
      },
    });

    const autoStarted = deferred();
    const autoGate = deferred();
    signalModerationStarted = autoStarted.resolve;
    moderationGate = autoGate.promise;
    const duplicateAuto = Promise.all([
      approvalService.handleJoinRequest(joinRequest(10001, 20001, 'duplicate-auto')),
      approvalService.handleJoinRequest(joinRequest(10001, 20001, 'duplicate-auto')),
    ]);
    await autoStarted.promise;
    autoGate.resolve();
    await duplicateAuto;
    assert.equal(calls.filter((call) => call.action === 'set_group_add_request').length, 1);
    assert.equal(approvalRepo.findByFlag('duplicate-auto')?.status, 'approved');
    assert.equal(statisticsRepo.totals('10001').approvals_total, 1);
    assert.equal(statisticsRepo.totals('10001').approvals_passed, 1);

    moderationGate = null;
    signalModerationStarted = null;
    failNextApproval = true;
    await assert.rejects(
      approvalService.handleJoinRequest(joinRequest(10001, 20002, 'failed-auto')),
      /OneBot unavailable/
    );
    const failedAuto = approvalRepo.findByFlag('failed-auto');
    assert.equal(failedAuto?.status, 'pending');
    assert.equal(failedAuto?.reason, 'automatic_approval_failed');
    assert.equal(statisticsRepo.totals('10001').approvals_passed, 1);

    const manual = approvalRepo.create({
      groupId: '10001',
      userId: '20003',
      flag: 'manual-race',
      comment: '',
      status: 'pending',
      ttlSeconds: 300,
    });
    const manualStarted = deferred();
    const manualGate = deferred();
    signalModerationStarted = manualStarted.resolve;
    moderationGate = manualGate.promise;
    const manualResults = Promise.allSettled([
      approvalService.approveManually(manual.id, '1'),
      approvalService.approveManually(manual.id, '2'),
    ]);
    await manualStarted.promise;
    manualGate.resolve();
    const settled = await manualResults;
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(approvalRepo.findById(manual.id)?.status, 'approved');

    configManager.update({ approval: { defaultAction: 'captcha' } });
    moderationGate = null;
    signalModerationStarted = null;
    await approvalService.handleJoinRequest(joinRequest(10002, 20004, 'captcha-race'));
    const captchaApproval = approvalRepo.findByFlag('captcha-race');
    assert.equal(captchaApproval?.status, 'captcha');
    await captchaService.issueChallenge(captchaApproval!.id);
    const session = getDatabase()
      .prepare('SELECT * FROM captcha_sessions WHERE approval_id = ?')
      .get(captchaApproval!.id) as { id: string; answer: string; solved: number };

    const captchaStarted = deferred();
    const captchaGate = deferred();
    signalModerationStarted = captchaStarted.resolve;
    moderationGate = captchaGate.promise;
    const answers = Promise.all([
      captchaService.handlePrivateMessage({ message_type: 'private', user_id: '20004', raw_message: session.answer } as never),
      captchaService.handlePrivateMessage({ message_type: 'private', user_id: '20004', raw_message: session.answer } as never),
    ]);
    await captchaStarted.promise;
    captchaGate.resolve();
    await answers;
    assert.equal(approvalRepo.findById(captchaApproval!.id)?.status, 'approved');
    assert.equal(
      calls.filter((call) => call.action === 'set_group_add_request' && call.params.flag === 'captcha-race').length,
      1
    );
    assert.equal(
      (getDatabase().prepare('SELECT solved FROM captcha_sessions WHERE id = ?').get(session.id) as { solved: number }).solved,
      1
    );

    const expiredApproval = approvalRepo.create({
      groupId: '10002',
      userId: '20006',
      flag: 'captcha-expiry-race',
      comment: '',
      status: 'captcha',
      ttlSeconds: 300,
    });
    const expiredSessionId = 'captcha-expiry-race-session';
    getDatabase().prepare(
      `INSERT INTO captcha_sessions (id, group_id, user_id, approval_id, type, challenge, answer, attempts, max_attempts, created_at, expires_at, solved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      expiredSessionId,
      '10002',
      '20006',
      expiredApproval.id,
      'text',
      'answer',
      'answer',
      0,
      3,
      Date.now() - 2_000,
      Date.now() - 1_000,
      0
    );
    moderationGate = null;
    signalModerationStarted = null;
    await Promise.all([
      captchaService.handlePrivateMessage({ message_type: 'private', user_id: '20006', raw_message: 'answer' } as never),
      captchaService.expireAllStale(),
    ]);
    assert.equal(approvalRepo.findById(expiredApproval.id)?.status, 'rejected');
    assert.equal(
      calls.filter((call) => call.action === 'set_group_add_request' && call.params.flag === 'captcha-expiry-race').length,
      1,
      'an expiry sweep and an answer must not issue competing moderation actions'
    );

    const firstMute = punishmentRepo.create({
      groupId: '10003',
      userId: '20005',
      type: 'mute',
      durationSeconds: 3600,
      reason: 'first',
      operatorId: '1',
    });
    const secondMute = punishmentRepo.create({
      groupId: '10003',
      userId: '20005',
      type: 'mute',
      durationSeconds: 3600,
      reason: 'second',
      operatorId: '1',
    });
    const unbanBefore = calls.filter(
      (call) => call.action === 'set_group_ban' && call.params.duration === 0
    ).length;
    await punishmentService.revoke(firstMute.id, '9');
    assert.equal(
      calls.filter((call) => call.action === 'set_group_ban' && call.params.duration === 0).length,
      unbanBefore,
      'revoking one of multiple active mutes must not unmute the user'
    );

    await Promise.all([
      punishmentService.revoke(secondMute.id, '9'),
      punishmentService.revoke(secondMute.id, '10'),
    ]);
    assert.equal(
      calls.filter((call) => call.action === 'set_group_ban' && call.params.duration === 0).length,
      unbanBefore + 1,
      'concurrent revokes must send at most one unmute'
    );
  } finally {
    closeDatabase();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
});
