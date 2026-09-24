import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildDefaults } from '../../src/core/config/defaults.ts';
import { configManager } from '../../src/core/config/index.ts';
import {
  migrateLegacyConfig,
  validateCanonicalConfig,
} from '../../src/core/config/schema.ts';
import {
  normalizeBotInfoResponse,
  normalizeGroupListResponse,
} from '../../src/modules/groups/index.ts';
import {
  normalizeOB11Event,
  normalizeOB11Message,
} from '../../src/types/onebot-event.ts';
import {
  normalizeOneBotFileId,
  normalizeOneBotId,
  normalizeOneBotMessageId,
  oneBotIdToSafeNumber,
  oneBotMessageIdToSafeNumber,
} from '../../src/types/onebot.ts';
import { plugin_set_config } from '../../src/index.ts';

describe('canonical OneBot identifiers', () => {
  it('normalizes every supported exact representation at the 64-bit boundaries', () => {
    assert.equal(normalizeOneBotId(9_007_199_254_740_991), '9007199254740991');
    assert.equal(normalizeOneBotId('9007199254740991'), '9007199254740991');
    assert.equal(normalizeOneBotId('9007199254740992'), '9007199254740992');
    assert.equal(normalizeOneBotId('9223372036854775807'), '9223372036854775807');
    assert.equal(normalizeOneBotId(18_446_744_073_709_551_615n), '18446744073709551615');
    assert.equal(normalizeOneBotId('00000042'), '42');
    assert.equal(normalizeOneBotId(42), normalizeOneBotId('42'));
    assert.equal(normalizeOneBotId(42n), normalizeOneBotId('00042'));
    assert.equal(normalizeOneBotId('0', { allowZero: true }), '0');
    assert.equal(normalizeOneBotId(-0, { allowZero: true }), null);
  });

  it('rejects values whose original decimal digits cannot be proven exact', () => {
    const invalid: unknown[] = [
      9_007_199_254_740_992,
      1.5,
      -1,
      -0,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      '-1',
      '+1',
      '1.0',
      '1e3',
      ' 1',
      '1 ',
      '',
      '0',
      '18446744073709551616',
      null,
      undefined,
      {},
    ];
    for (const value of invalid) assert.equal(normalizeOneBotId(value), null, String(value));
  });

  it('converts back to Number only when the canonical value remains safe', () => {
    assert.equal(oneBotIdToSafeNumber('9007199254740991'), 9_007_199_254_740_991);
    assert.throws(
      () => oneBotIdToSafeNumber('9007199254740992'),
      /cannot be represented as a safe JavaScript number/,
    );
  });

  it('preserves opaque file identifiers and rejects lossy numeric file inputs', () => {
    assert.equal(normalizeOneBotFileId('opaque:file/0001'), 'opaque:file/0001');
    assert.equal(normalizeOneBotFileId(123), '123');
    assert.equal(normalizeOneBotFileId(9_223_372_036_854_775_807n), '9223372036854775807');
    assert.equal(normalizeOneBotFileId(9_007_199_254_740_992), null);
    assert.equal(normalizeOneBotFileId(-1), null);
    assert.equal(normalizeOneBotFileId(-0), null);
    assert.equal(normalizeOneBotFileId(''), null);
  });

  it('normalizes signed message handles without weakening account identifiers', () => {
    assert.equal(normalizeOneBotMessageId(-42), '-42');
    assert.equal(normalizeOneBotMessageId('-00042'), '-42');
    assert.equal(normalizeOneBotMessageId(-9_223_372_036_854_775_808n), '-9223372036854775808');
    assert.equal(normalizeOneBotMessageId('18446744073709551615'), '18446744073709551615');
    assert.equal(normalizeOneBotMessageId(-9_223_372_036_854_775_809n), null);
    assert.equal(normalizeOneBotMessageId('1e6'), null);
    assert.equal(normalizeOneBotMessageId(-0), null);
    assert.equal(normalizeOneBotMessageId(9_007_199_254_740_992), null);
    assert.equal(normalizeOneBotId(-42), null);
    assert.equal(oneBotMessageIdToSafeNumber('-42'), -42);
    assert.equal(oneBotMessageIdToSafeNumber('9007199254740992'), null);
  });
});

describe('OneBot event boundary normalization', () => {
  it('canonicalizes mixed provider representations without rounding identifiers', () => {
    const event = normalizeOB11Message({
      time: 1,
      self_id: 10001,
      post_type: 'message',
      message_type: 'group',
      message_id: '9223372036854775807',
      user_id: 20002,
      group_id: '00030003',
      raw_message: '/guard mute 9223372036854775807',
      message: [
        { type: 'text', data: { text: '/guard mute ' } },
        { type: 'at', data: { qq: '09223372036854775807' } },
        { type: 'reply', data: { id: 40004 } },
        { type: 'image', data: { file_id: 'opaque:file/0001', user_id: 20002 } },
      ],
      sender: { user_id: '00020002', nickname: 'owner', role: 'owner' },
    });

    assert.ok(event);
    assert.equal(event.self_id, '10001');
    assert.equal(event.message_id, '9223372036854775807');
    assert.equal(event.user_id, '20002');
    assert.equal(event.group_id, '30003');
    assert.equal(event.sender.user_id, '20002');
    assert.equal(event.message[1]?.data['qq'], '9223372036854775807');
    assert.equal(event.message[2]?.data['id'], '40004');
    assert.equal(event.message[3]?.data['file_id'], 'opaque:file/0001');
    assert.equal(event.message[3]?.data['user_id'], '20002');
  });

  it('normalizes request and notice identifiers from both numbers and strings', () => {
    const request = normalizeOB11Event({
      time: 1,
      self_id: 10001,
      post_type: 'request',
      request_type: 'group',
      sub_type: 'add',
      group_id: 30003,
      user_id: '9223372036854775807',
      comment: '',
      flag: 'provider-opaque-flag',
    });
    assert.ok(request && request.post_type === 'request');
    assert.equal(request.group_id, '30003');
    assert.equal(request.user_id, '9223372036854775807');

    const requestWithoutComment = normalizeOB11Event({
      time: 1,
      self_id: 10001,
      post_type: 'request',
      request_type: 'group',
      group_id: 30003,
      user_id: 20002,
      flag: 'provider-opaque-flag-2',
    });
    assert.ok(requestWithoutComment && requestWithoutComment.post_type === 'request');
    assert.equal(requestWithoutComment.comment, '');

    const notice = normalizeOB11Event({
      time: 1,
      self_id: '00010001',
      post_type: 'notice',
      notice_type: 'group_increase',
      group_id: 30003,
      user_id: '9223372036854775807',
      operator_id: 40004,
      sub_type: 'approve',
    });
    assert.ok(notice && notice.post_type === 'notice');
    assert.equal(notice.self_id, '10001');
    assert.equal(notice.group_id, '30003');
    assert.equal(notice.user_id, '9223372036854775807');
    assert.equal(notice.operator_id, '40004');
  });

  it('accepts signed handles and CQ-string message bodies at ingress', () => {
    const event = normalizeOB11Message({
      time: 1,
      self_id: 10001,
      post_type: 'message',
      message_type: 'private',
      message_id: -2147483648,
      user_id: 20002,
      raw_message: 'captcha-answer',
      message: 'captcha-answer',
      sender: { user_id: 20002, nickname: 'applicant' },
    });
    assert.ok(event);
    assert.equal(event.message_id, '-2147483648');
    assert.deepEqual(event.message, []);

    const reply = normalizeOB11Message({
      ...event,
      message_type: 'group',
      group_id: 30003,
      message: [{ type: 'reply', data: { id: -99, message_id: '-000100' } }],
    });
    assert.ok(reply);
    assert.equal(reply.message[0]?.data['id'], '-99');
    assert.equal(reply.message[0]?.data['message_id'], '-100');
  });

  it('rejects malformed or already-rounded provider events before dispatch', () => {
    const base = {
      time: 1,
      self_id: 10001,
      post_type: 'message',
      message_type: 'group',
      message_id: 40004,
      user_id: 20002,
      group_id: 30003,
      raw_message: 'hello',
      message: [{ type: 'text', data: { text: 'hello' } }],
      sender: { user_id: 20002, nickname: 'member', role: 'member' },
    };
    assert.equal(normalizeOB11Message({ ...base, user_id: 9_007_199_254_740_992 }), null);
    assert.equal(normalizeOB11Message({ ...base, message_id: '1e6' }), null);
    assert.equal(normalizeOB11Message({ ...base, group_id: '-3' }), null);
    assert.equal(normalizeOB11Message({
      ...base,
      message: [{ type: 'at', data: { qq: 9_007_199_254_740_992 } }],
    }), null);
  });

  it('normalizes provider action responses before exposing them through the API', () => {
    assert.deepEqual(
      normalizeBotInfoResponse({ user_id: '9223372036854775807', nickname: 'guardian' }),
      { user_id: '9223372036854775807', nickname: 'guardian' },
    );
    assert.deepEqual(
      normalizeGroupListResponse([
        {
          group_id: 30003,
          group_name: 'safe numeric provider group',
          member_count: 10,
          max_member_count: 100,
        },
        {
          group_id: '9223372036854775807',
          group_name: 'exact string provider group',
          member_count: 20,
          max_member_count: 200,
        },
      ]),
      [
        {
          group_id: '30003',
          group_name: 'safe numeric provider group',
          member_count: 10,
          max_member_count: 100,
        },
        {
          group_id: '9223372036854775807',
          group_name: 'exact string provider group',
          member_count: 20,
          max_member_count: 200,
        },
      ],
    );
    assert.equal(
      normalizeBotInfoResponse({ user_id: 9_007_199_254_740_992, nickname: 'rounded' }),
      null,
    );
  });
});

describe('OneBot config migration', () => {
  it('converts safe legacy scalars and group keys to canonical strings', () => {
    const config = buildDefaults();
    config.core.selfId = 12345 as never;
    config.core.superAdmins = [9_007_199_254_740_991, '09223372036854775807'] as never;
    config.approval.groups['00067890'] = {
      enabled: true,
      action: 'manual',
      approveKeywords: [],
      rejectKeywords: [],
      approvePatterns: [],
      rejectPatterns: [],
      rejectReason: '',
      riskEnabled: true,
      autoKickBlacklisted: true,
      notifyOnRisk: false,
      notifyOnJoin: false,
      groupName: '',
      welcomeEnabled: false,
      welcomeTemplate: '',
      curfewEnabled: false,
      curfewStart: '23:00',
      curfewEnd: '07:00',
    };

    const migrated = migrateLegacyConfig({ schemaVersion: 4, config }).file;
    assert.equal(migrated.schemaVersion, 6);
    assert.equal(migrated.config.core.selfId, '12345');
    assert.deepEqual(migrated.config.core.superAdmins, [
      '9007199254740991',
      '9223372036854775807',
    ]);
    assert.deepEqual(Object.keys(migrated.config.approval.groups), ['67890']);
  });

  it('rejects lossy legacy numbers and non-canonical runtime config', () => {
    const unsafeLegacy = buildDefaults();
    unsafeLegacy.core.selfId = 9_007_199_254_740_992 as never;
    assert.throws(
      () => migrateLegacyConfig({ schemaVersion: 4, config: unsafeLegacy }),
      /unsigned 64-bit decimal identifier/,
    );

    const numericCanonical = buildDefaults();
    numericCanonical.core.selfId = 12345 as never;
    assert.throws(() => validateCanonicalConfig(numericCanonical), /canonical decimal string/);

    const leadingZeroCanonical = buildDefaults();
    leadingZeroCanonical.core.superAdmins = ['00012345'];
    assert.throws(() => validateCanonicalConfig(leadingZeroCanonical), /canonical decimal form/);

    const duplicateLegacy = buildDefaults();
    duplicateLegacy.approval.groups['12345'] = {} as never;
    duplicateLegacy.approval.groups['0012345'] = {} as never;
    assert.throws(
      () => migrateLegacyConfig({ schemaVersion: 4, config: duplicateLegacy }),
      /duplicate canonical group ID 12345/,
    );
  });

  it('keeps the NapCat settings boundary exact and rejects rounded numbers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-onebot-config-ui-'));
    try {
      configManager.init(root);
      await plugin_set_config({} as never, { selfId: '9223372036854775807' });
      assert.equal(configManager.get().core.selfId, '9223372036854775807');

      await plugin_set_config({} as never, { selfId: 12345 });
      assert.equal(configManager.get().core.selfId, '12345');

      await assert.rejects(
        plugin_set_config({} as never, { selfId: 9_007_199_254_740_992 }),
        /exact unsigned 64-bit decimal identifier/,
      );
      assert.equal(configManager.get().core.selfId, '12345');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
