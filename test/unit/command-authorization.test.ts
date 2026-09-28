import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configManager } from '../../src/core/config/index.ts';
import { bus } from '../../src/core/events/index.ts';
import { closeDatabase, openDatabase } from '../../src/database/index.ts';
import { blacklistRepo } from '../../src/database/repositories/blacklist.ts';
import {
  CommandService,
  type TargetRoleLookup,
} from '../../src/modules/commands/index.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import type { InternalEventPayload } from '../../src/core/events/types.ts';
import type { RuntimeHost, RuntimeKind } from '../../src/ports/runtime.ts';
import type { OB11Message, OB11Sender } from '../../src/types/napcat.ts';

interface OneBotCall {
  action: string;
  params: Record<string, unknown>;
}

interface Harness {
  calls: OneBotCall[];
  logs: string[];
  auditEvents: InternalEventPayload<'AuditCreated'>[];
  setMemberInfo(handler: () => unknown | Promise<unknown>): void;
}

const BOT_ID = '10000';
const INVOKER_ID = '20001';
const GROUP_ID = '30001';
const TARGET_ID = '40001';

function event(
  invokerRole: NonNullable<OB11Sender['role']>,
  command = 'kick',
  target = TARGET_ID,
): OB11Message {
  const text = `/guard ${command} ${target}`;
  return {
    time: Math.floor(Date.now() / 1_000),
    self_id: BOT_ID,
    post_type: 'message',
    message_type: 'group',
    message_id: String(Date.now()),
    user_id: INVOKER_ID,
    group_id: GROUP_ID,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: {
      user_id: INVOKER_ID,
      nickname: 'operator',
      role: invokerRole,
    },
  };
}

function replyTexts(calls: OneBotCall[]): string[] {
  return calls
    .filter((call) => call.action === 'send_group_msg')
    .flatMap((call) => {
      const message = call.params['message'];
      if (!Array.isArray(message)) return [];
      return message.flatMap((segment) => {
        if (!segment || typeof segment !== 'object') return [];
        const data = (segment as { data?: unknown }).data;
        if (!data || typeof data !== 'object') return [];
        const text = (data as { text?: unknown }).text;
        return typeof text === 'string' ? [text] : [];
      });
    });
}

async function withHarness(kind: RuntimeKind, run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `guardian-command-auth-${kind}-`));
  const calls: OneBotCall[] = [];
  const logs: string[] = [];
  const auditEvents: InternalEventPayload<'AuditCreated'>[] = [];
  let memberInfoHandler: () => unknown | Promise<unknown> = () => ({
    group_id: GROUP_ID,
    user_id: TARGET_ID,
    role: 'member',
  });
  const captureLog = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  const runtime: RuntimeHost = {
    kind,
    pluginId: 'command-authorization-test',
    paths: {
      pluginPath: root,
      dataPath: join(root, 'data'),
      configDir: join(root, 'config'),
    },
    logger: {
      log: captureLog,
      debug: captureLog,
      info: captureLog,
      warn: captureLog,
      error: captureLog,
    },
    onebot: {
      async call(action, params = {}) {
        calls.push({ action, params });
        if (action === 'get_group_member_info') return await memberInfoHandler();
        return null;
      },
    },
    router: {} as RuntimeHost['router'],
  };
  const onAudit = (auditEvent: InternalEventPayload<'AuditCreated'>) => {
    auditEvents.push(auditEvent);
  };

  try {
    setRuntimeHost(runtime);
    configManager.init(runtime.paths.configDir);
    openDatabase(runtime.paths.dataPath);
    configManager.update({
      core: { selfId: BOT_ID },
      approval: { defaultGroupEnabled: true },
      commands: { enabled: true, prefix: '/guard' },
    });
    bus.on('AuditCreated', onAudit);
    await run({
      calls,
      logs,
      auditEvents,
      setMemberInfo(handler) {
        memberInfoHandler = handler;
      },
    });
  } finally {
    bus.removeListener('AuditCreated', onAudit);
    closeDatabase();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
}

test('NapCat and SnowLuma enforce the destructive-command role matrix with matching target evidence', async (t) => {
  const cases: Array<{
    name: string;
    invokerRole: NonNullable<OB11Sender['role']>;
    superAdmin: boolean;
    targetRole: NonNullable<OB11Sender['role']>;
    consumed: boolean;
    allowed: boolean;
  }> = [
    { name: 'member invoker -> member', invokerRole: 'member', superAdmin: false, targetRole: 'member', consumed: false, allowed: false },
    { name: 'member invoker -> admin', invokerRole: 'member', superAdmin: false, targetRole: 'admin', consumed: false, allowed: false },
    { name: 'member invoker -> owner', invokerRole: 'member', superAdmin: false, targetRole: 'owner', consumed: false, allowed: false },
    { name: 'admin invoker -> member', invokerRole: 'admin', superAdmin: false, targetRole: 'member', consumed: true, allowed: true },
    { name: 'admin invoker -> admin', invokerRole: 'admin', superAdmin: false, targetRole: 'admin', consumed: true, allowed: false },
    { name: 'admin invoker -> owner', invokerRole: 'admin', superAdmin: false, targetRole: 'owner', consumed: true, allowed: false },
    { name: 'owner invoker -> member', invokerRole: 'owner', superAdmin: false, targetRole: 'member', consumed: true, allowed: true },
    { name: 'owner invoker -> admin', invokerRole: 'owner', superAdmin: false, targetRole: 'admin', consumed: true, allowed: true },
    { name: 'owner invoker -> owner', invokerRole: 'owner', superAdmin: false, targetRole: 'owner', consumed: true, allowed: true },
    { name: 'super admin -> member', invokerRole: 'member', superAdmin: true, targetRole: 'member', consumed: true, allowed: true },
    { name: 'super admin -> admin', invokerRole: 'member', superAdmin: true, targetRole: 'admin', consumed: true, allowed: true },
    { name: 'super admin -> owner', invokerRole: 'member', superAdmin: true, targetRole: 'owner', consumed: true, allowed: true },
  ];

  for (const kind of ['napcat', 'snowluma'] as const) {
    await t.test(kind, async () => {
      await withHarness(kind, async ({ calls, auditEvents, setMemberInfo }) => {
        for (const testCase of cases) {
          calls.length = 0;
          auditEvents.length = 0;
          configManager.update({
            core: { superAdmins: testCase.superAdmin ? [INVOKER_ID] : [] },
          });
          setMemberInfo(() => ({
            group_id: String(GROUP_ID),
            user_id: String(TARGET_ID),
            role: testCase.targetRole,
          }));

          const consumed = await new CommandService().handleGroupCommand(event(testCase.invokerRole));
          assert.equal(consumed, testCase.consumed, `${kind}: ${testCase.name} consumed`);
          assert.equal(
            calls.some((call) => call.action === 'set_group_kick'),
            testCase.allowed,
            `${kind}: ${testCase.name} action decision`,
          );

          if (!testCase.consumed) {
            assert.equal(calls.length, 0, `${kind}: ${testCase.name} must not reach OneBot`);
            continue;
          }

          assert.deepEqual(calls[0], {
            action: 'get_group_member_info',
            params: {
              group_id: String(GROUP_ID),
              user_id: String(TARGET_ID),
              no_cache: true,
            },
          }, `${kind}: ${testCase.name} member-info contract`);

          const denial = auditEvents.find((auditEvent) => auditEvent.action === 'command.authorization_denied');
          if (testCase.allowed) {
            assert.equal(denial, undefined, `${kind}: ${testCase.name} must not emit a denial`);
          } else {
            assert.equal(denial?.targetId, String(TARGET_ID), `${kind}: ${testCase.name} denial target`);
            assert.equal(denial?.details['reason'], 'target_privileged', `${kind}: ${testCase.name} denial reason`);
          }
        }
      });
    });
  }
});

test('provider failures and malformed member-info responses fail closed without leaking internals', async (t) => {
  const secret = 'provider-token=must-not-leak';
  const fixtures: Array<{ name: string; handler: () => unknown | Promise<unknown> }> = [
    { name: 'transport rejection', handler: async () => { throw new Error(`disconnected ${secret}`); } },
    { name: 'timeout', handler: async () => { throw new Error(`action timed out ${secret}`); } },
    { name: 'logical failure', handler: async () => { throw new Error(`status=failed retcode=100 ${secret}`); } },
    { name: 'unsupported action', handler: async () => { throw new Error(`unsupported get_group_member_info ${secret}`); } },
    { name: 'null/absent-like response', handler: () => null },
    { name: 'missing role', handler: () => ({ group_id: GROUP_ID, user_id: TARGET_ID }) },
    { name: 'unknown role', handler: () => ({ group_id: GROUP_ID, user_id: TARGET_ID, role: 'moderator' }) },
    { name: 'mismatched group', handler: () => ({ group_id: '30002', user_id: TARGET_ID, role: 'member' }) },
    { name: 'mismatched user', handler: () => ({ group_id: GROUP_ID, user_id: '40002', role: 'member' }) },
    { name: 'array response', handler: () => [{ group_id: GROUP_ID, user_id: TARGET_ID, role: 'member' }] },
  ];

  for (const kind of ['napcat', 'snowluma'] as const) {
    await t.test(kind, async () => {
      await withHarness(kind, async ({ calls, logs, auditEvents, setMemberInfo }) => {
        for (const fixture of fixtures) {
          for (const command of ['mute', 'kick', 'ban']) {
            calls.length = 0;
            logs.length = 0;
            auditEvents.length = 0;
            setMemberInfo(fixture.handler);

            assert.equal(
              await new CommandService().handleGroupCommand(event('admin', command)),
              true,
              `${kind}: ${fixture.name}/${command} consumed`,
            );
            assert.equal(
              calls.some((call) => call.action === 'set_group_kick' || call.action === 'set_group_ban'),
              false,
              `${kind}: ${fixture.name}/${command} must fail closed`,
            );
            assert.equal(
              blacklistRepo.isBlacklisted(TARGET_ID, GROUP_ID),
              false,
              `${kind}: ${fixture.name}/${command} must not create a blacklist entry`,
            );
            assert.match(
              replyTexts(calls).at(-1) ?? '',
              /无法确认目标的群成员身份.*安全拒绝/,
              `${kind}: ${fixture.name}/${command} sanitized chat denial`,
            );

            const denial = auditEvents.find((auditEvent) => auditEvent.action === 'command.authorization_denied');
            assert.equal(denial?.targetId, String(TARGET_ID), `${kind}: ${fixture.name}/${command} denial target`);
            assert.equal(denial?.details['reason'], 'target_role_unavailable', `${kind}: ${fixture.name}/${command} denial reason`);
            assert.ok(
              denial?.details['lookupFailure'] === 'action_failed'
                || denial?.details['lookupFailure'] === 'malformed_response',
              `${kind}: ${fixture.name}/${command} sanitized lookup failure`,
            );

            const observableOutput = JSON.stringify({
              logs,
              auditEvents,
              replies: replyTexts(calls),
            });
            assert.doesNotMatch(observableOutput, /must-not-leak/, `${kind}: ${fixture.name}/${command} leaked provider detail`);
          }
        }
      });
    });
  }
});

test('pardon commands remain independent of target-role lookup availability', async (t) => {
  for (const kind of ['napcat', 'snowluma'] as const) {
    await t.test(kind, async () => {
      await withHarness(kind, async ({ calls, setMemberInfo }) => {
        setMemberInfo(async () => { throw new Error('member lookup must not run'); });

        for (const command of ['unmute', 'unban']) {
          calls.length = 0;
          assert.equal(await new CommandService().handleGroupCommand(event('admin', command)), true);
          assert.equal(calls.some((call) => call.action === 'get_group_member_info'), false);
          assert.match(replyTexts(calls).at(-1) ?? '', command === 'unmute' ? /已解除/ : /已将.*移出/);
        }
      });
    });
  }
});

test('confirmed-absent targets cannot trigger implicit pre-emptive blacklisting', async (t) => {
  for (const kind of ['napcat', 'snowluma'] as const) {
    await t.test(kind, async () => {
      await withHarness(kind, async ({ calls, auditEvents }) => {
        const confirmedAbsent = async (): Promise<TargetRoleLookup> => ({ kind: 'absent' });
        const service = new CommandService({ lookupTargetRole: confirmedAbsent });

        assert.equal(await service.handleGroupCommand(event('admin', 'ban')), true);
        assert.equal(calls.some((call) => call.action === 'get_group_member_info'), false);
        assert.equal(calls.some((call) => call.action === 'set_group_kick'), false);
        assert.equal(blacklistRepo.isBlacklisted(TARGET_ID, GROUP_ID), false);
        assert.match(replyTexts(calls).at(-1) ?? '', /预先拉黑尚未启用/);

        const denial = auditEvents.find((auditEvent) => auditEvent.action === 'command.authorization_denied');
        assert.equal(denial?.details['reason'], 'target_absent');
        assert.equal(denial?.details['lookupStatus'], 'absent');
      });
    });
  }
});
