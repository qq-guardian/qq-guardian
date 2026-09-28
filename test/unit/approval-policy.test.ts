import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDefaults } from '../../src/core/config/defaults.ts';
import { configManager } from '../../src/core/config/index.ts';
import { migrateLegacyConfig } from '../../src/core/config/schema.ts';
import { bus } from '../../src/core/events/index.ts';
import { closeDatabase, openDatabase } from '../../src/database/index.ts';
import { approvalRepo } from '../../src/database/repositories/approval.ts';
import {
  approvalService,
  matchApproveComment,
} from '../../src/modules/approval/index.ts';
import { extractPendingJoinRequests } from '../../src/modules/approval/sync.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import type { InternalEventPayload } from '../../src/core/events/types.ts';
import type { RuntimeHost, RuntimeKind } from '../../src/ports/runtime.ts';
import type { OB11RequestEvent } from '../../src/types/napcat.ts';

interface OneBotCall {
  action: string;
  params: Record<string, unknown>;
}

function request(groupId: number | string, userId: number | string, flag: string, comment: string): OB11RequestEvent {
  return {
    time: Math.floor(Date.now() / 1_000),
    self_id: '1',
    post_type: 'request',
    request_type: 'group',
    sub_type: 'add',
    group_id: String(groupId),
    user_id: String(userId),
    comment,
    flag,
  };
}

function host(root: string, kind: RuntimeKind, calls: OneBotCall[]): RuntimeHost {
  return {
    kind,
    pluginId: 'approval-policy-test',
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
        return null;
      },
    },
    router: {} as RuntimeHost['router'],
  };
}

test('approval matching distinguishes trusted rules from the risky built-in heuristic', () => {
  const base = { approveKeywords: [], approvePatterns: [], action: 'manual' };
  assert.equal(matchApproveComment('朋友推荐我加入', base, false), null);
  assert.equal(
    matchApproveComment('朋友推荐我加入', base, true),
    'builtin_referral_heuristic',
  );

  for (const action of ['auto_reject', 'captcha']) {
    assert.equal(matchApproveComment('朋友推荐我加入', { ...base, action }, true), null);
    assert.equal(matchApproveComment(
      'trusted-code',
      { ...base, action, approveKeywords: ['trusted-code'] },
      true,
    ), 'custom_keyword_matched');
  }
  assert.equal(matchApproveComment(
    'invite:ABC-123',
    { ...base, approvePatterns: ['^invite:[A-Z]+-\\d+$'] },
    false,
  ), 'custom_pattern_matched');
});

test('migration preserves explicit built-in heuristic choices and defaults a missing choice off', () => {
  for (const explicit of [true, false]) {
    const config = buildDefaults();
    config.approval.useBuiltinApproveKeywords = explicit;
    const migrated = migrateLegacyConfig({ schemaVersion: 3, config });
    assert.equal(migrated.file.config.approval.useBuiltinApproveKeywords, explicit);
  }

  const withoutChoice = buildDefaults() as unknown as Record<string, unknown>;
  const approval = { ...(withoutChoice['approval'] as Record<string, unknown>) };
  delete approval['useBuiltinApproveKeywords'];
  withoutChoice['approval'] = approval;
  const migrated = migrateLegacyConfig({ schemaVersion: 3, config: withoutChoice });
  assert.equal(migrated.file.config.approval.useBuiltinApproveKeywords, false);
});

test('NapCat and SnowLuma request fixtures keep referral claims manual and audit explicit opt-ins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-approval-policy-'));
  const calls: OneBotCall[] = [];
  const auditEvents: InternalEventPayload<'AuditCreated'>[] = [];
  const onAudit = (event: InternalEventPayload<'AuditCreated'>) => {
    auditEvents.push(event);
  };
  const runtime = host(root, 'napcat', calls);

  try {
    setRuntimeHost(runtime);
    configManager.init(runtime.paths.configDir);
    openDatabase(runtime.paths.dataPath);
    configManager.update({ approval: { defaultGroupEnabled: true } });
    bus.on('AuditCreated', onAudit);

    await approvalService.handleJoinRequest(request(10001, 20001, 'napcat-manual', '朋友推荐我加入'));
    assert.equal(approvalRepo.findByFlag('napcat-manual')?.status, 'pending');
    assert.equal(calls.length, 0);

    const [snowluma] = extractPendingJoinRequests({
      JoinRequest: [{
        request_id: 'snowluma-manual',
        requester_uin: 20002,
        group_id: 10001,
        message: '群友邀请我加入',
        checked: false,
      }],
    });
    assert.ok(snowluma);
    clearRuntimeHost();
    setRuntimeHost(host(root, 'snowluma', calls));
    await approvalService.handleJoinRequest(request(
      snowluma.groupId,
      snowluma.userId,
      snowluma.flag,
      snowluma.comment,
    ));
    assert.equal(approvalRepo.findByFlag('snowluma-manual')?.status, 'pending');
    assert.equal(calls.length, 0);

    configManager.update({
      approval: {
        groups: {
          '10001': {
            enabled: true,
            action: 'manual',
            approveKeywords: ['trusted-code'],
          },
        },
      },
    });
    await approvalService.handleJoinRequest(request(10001, 20003, 'custom-allow', 'trusted-code'));
    assert.equal(approvalRepo.findByFlag('custom-allow')?.reason, 'custom_keyword_matched');
    assert.equal(calls.at(-1)?.params['approve'], true);
    assert.equal(auditEvents.at(-1)?.details['decisionReason'], 'custom_keyword_matched');

    configManager.update({ approval: { useBuiltinApproveKeywords: true } });
    await approvalService.handleJoinRequest(request(10001, 20004, 'builtin-opt-in', '朋友推荐我加入'));
    assert.equal(approvalRepo.findByFlag('builtin-opt-in')?.reason, 'builtin_referral_heuristic');
    assert.equal(calls.at(-1)?.params['approve'], true);
    assert.equal(auditEvents.at(-1)?.details['decisionReason'], 'builtin_referral_heuristic');

    await approvalService.handleJoinRequest(request(10001, 20005, 'reject-first', '朋友推荐我来刷单'));
    assert.equal(approvalRepo.findByFlag('reject-first')?.status, 'rejected');
    assert.equal(calls.at(-1)?.params['approve'], false);

    configManager.update({ approval: { groups: { '10001': { action: 'auto_reject', approveKeywords: [] } } } });
    await approvalService.handleJoinRequest(request(10001, 20006, 'closed-group', '朋友推荐我加入'));
    assert.equal(approvalRepo.findByFlag('closed-group')?.status, 'rejected');
    assert.equal(calls.at(-1)?.params['approve'], false);

    const callsBeforeCaptcha = calls.length;
    configManager.update({ approval: { groups: { '10001': { action: 'captcha' } } } });
    await approvalService.handleJoinRequest(request(10001, 20007, 'captcha-required', '朋友推荐我加入'));
    assert.equal(approvalRepo.findByFlag('captcha-required')?.status, 'captcha');
    assert.equal(calls.length, callsBeforeCaptcha);
  } finally {
    bus.removeListener('AuditCreated', onAudit);
    closeDatabase();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
});
