import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configManager } from '../../src/core/config/index.ts';
import { locks, withLock } from '../../src/core/locks.ts';
import { approvalRepo } from '../../src/database/repositories/approval.ts';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import {
  CAPTCHA_EXPIRY_SWEEP_CONCURRENCY,
  captchaChallengeCode,
  CaptchaService,
  captchaService,
  MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER,
} from '../../src/modules/captcha/index.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import type { RuntimeHost } from '../../src/ports/runtime.ts';

interface OneBotCall {
  action: string;
  params: Record<string, unknown>;
}

interface Harness {
  calls: OneBotCall[];
  onCall?: (action: string, params: Record<string, unknown>) => Promise<unknown>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'qq-guardian-captcha-routing-'));
  const calls: OneBotCall[] = [];
  const harness: Harness = { calls };
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
        if (harness.onCall) return harness.onCall(action, params);
        return null;
      },
    },
    router: {} as RuntimeHost['router'],
  };

  try {
    setRuntimeHost(host);
    configManager.init(host.paths.configDir);
    openDatabase(host.paths.dataPath);
    await run(harness);
  } finally {
    closeDatabase();
    clearRuntimeHost();
    rmSync(root, { recursive: true, force: true });
  }
}

function createCaptchaApproval(groupId: string, userId: string, flag: string) {
  return approvalRepo.create({
    groupId,
    userId,
    flag,
    comment: '',
    status: 'captcha',
    ttlSeconds: 300,
  });
}

function insertSession(options: {
  id: string;
  approvalId: number;
  groupId: string;
  userId: string;
  answer: string;
  createdAt: number;
  expiresAt?: number;
}): void {
  getDatabase().prepare(
    `INSERT INTO captcha_sessions (
       id, group_id, user_id, approval_id, type, challenge, answer,
       attempts, max_attempts, created_at, expires_at, solved
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    options.id,
    options.groupId,
    options.userId,
    options.approvalId,
    'question',
    `Challenge for ${options.groupId}`,
    options.answer,
    0,
    3,
    options.createdAt,
    options.expiresAt ?? Date.now() + 300_000,
    0
  );
}

function attempts(id: string): number {
  return (getDatabase()
    .prepare('SELECT attempts FROM captcha_sessions WHERE id = ?')
    .get(id) as { attempts: number }).attempts;
}

function privateReply(userId: string, rawMessage: string) {
  return { message_type: 'private', user_id: userId, raw_message: rawMessage } as never;
}

test('captcha codes route concurrent group sessions without cross-consuming attempts', async () => {
  await withHarness(async ({ calls }) => {
    const userId = '9007199254740993';
    const older = createCaptchaApproval('10001', userId, 'older-session');
    const newer = createCaptchaApproval('10002', userId, 'newer-session');
    insertSession({
      id: '11111111-1111-4111-8111-111111111111',
      approvalId: older.id,
      groupId: older.group_id,
      userId,
      answer: 'alpha',
      createdAt: Date.now() - 2_000,
    });
    insertSession({
      id: '22222222-2222-4222-8222-222222222222',
      approvalId: newer.id,
      groupId: newer.group_id,
      userId,
      answer: 'beta',
      createdAt: Date.now() - 1_000,
    });

    const olderCode = captchaChallengeCode('11111111-1111-4111-8111-111111111111');
    const newerCode = captchaChallengeCode('22222222-2222-4222-8222-222222222222');
    assert.notEqual(olderCode, newerCode);

    await captchaService.handlePrivateMessage(privateReply(userId, 'answer-without-a-code'));
    await captchaService.handlePrivateMessage(privateReply(userId, '#DEADBEEF00 answer'));
    assert.equal(attempts('11111111-1111-4111-8111-111111111111'), 0);
    assert.equal(attempts('22222222-2222-4222-8222-222222222222'), 0);
    assert.ok(
      calls.some((call) => call.action === 'send_private_msg'
        && String(call.params.message).includes(`#${olderCode} — group 10001`)
        && String(call.params.message).includes(`#${newerCode} — group 10002`)),
      'ambiguous or unknown codes should return a bounded session-selection hint'
    );

    await captchaService.handlePrivateMessage(privateReply(userId, `#${olderCode} wrong`));
    assert.equal(attempts('11111111-1111-4111-8111-111111111111'), 1);
    assert.equal(attempts('22222222-2222-4222-8222-222222222222'), 0);

    await captchaService.handlePrivateMessage(privateReply(userId, `#${olderCode.toLowerCase()} alpha`));
    assert.equal(approvalRepo.findById(older.id)?.status, 'approved');
    assert.equal(approvalRepo.findById(newer.id)?.status, 'captcha');

    const approvalsBeforeReplay = calls.filter(
      (call) => call.action === 'set_group_add_request' && call.params.flag === 'older-session'
    ).length;
    await captchaService.handlePrivateMessage(privateReply(userId, `#${olderCode} alpha`));
    assert.equal(attempts('22222222-2222-4222-8222-222222222222'), 0);
    assert.equal(
      calls.filter((call) => call.action === 'set_group_add_request' && call.params.flag === 'older-session').length,
      approvalsBeforeReplay,
      'replaying a solved-session code must not repeat moderation or consume another session'
    );

    await captchaService.handlePrivateMessage(privateReply(userId, 'beta'));
    assert.equal(approvalRepo.findById(newer.id)?.status, 'approved');

    const codeShaped = createCaptchaApproval('10003', userId, 'code-shaped-answer');
    insertSession({
      id: '33333333-3333-4333-8333-333333333333',
      approvalId: codeShaped.id,
      groupId: codeShaped.group_id,
      userId,
      answer: 'deadbeef00',
      createdAt: Date.now(),
    });
    await captchaService.handlePrivateMessage(privateReply(userId, 'DEADBEEF00'));
    assert.equal(
      approvalRepo.findById(codeShaped.id)?.status,
      'approved',
      'the explicit # prefix must keep code-shaped single-session answers backward compatible'
    );
  });
});

test('challenge issuance includes group context and atomically enforces the per-user cap', async () => {
  await withHarness(async ({ calls }) => {
    const userId = '70001';
    const issued = createCaptchaApproval('80001', userId, 'issued-session');
    await captchaService.issueChallenge(issued.id);

    const row = getDatabase()
      .prepare('SELECT id FROM captcha_sessions WHERE approval_id = ?')
      .get(issued.id) as { id: string };
    const code = captchaChallengeCode(row.id);
    const delivery = calls.find(
      (call) => call.action === 'send_private_msg' && String(call.params.message).includes(`Session code: #${code}`)
    );
    assert.ok(delivery);
    assert.match(String(delivery.params.message), /verification for group 80001/i);

    const legacyUser = '70003';
    const legacyApprovals = [];
    for (let index = 0; index < MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER + 2; index += 1) {
      const approval = createCaptchaApproval(String(82000 + index), legacyUser, `legacy-${index}`);
      legacyApprovals.push(approval);
      insertSession({
        id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        approvalId: approval.id,
        groupId: approval.group_id,
        userId: legacyUser,
        answer: 'answer',
        createdAt: Date.now() + index,
      });
    }
    await captchaService.handlePrivateMessage(privateReply(legacyUser, 'ambiguous'));
    assert.equal(
      (getDatabase()
        .prepare('SELECT COUNT(*) AS count FROM captcha_sessions WHERE user_id = ? AND solved = 0')
        .get(legacyUser) as { count: number }).count,
      MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER,
      'pre-upgrade excess sessions must be reconciled into the bounded contract'
    );
    assert.deepEqual(
      legacyApprovals.slice(0, 2).map((approval) => approvalRepo.findById(approval.id)?.status),
      ['pending', 'pending'],
      'oldest excess requests return to manual review instead of becoming inaccessible'
    );
    assert.ok(calls.some((call) =>
      call.action === 'send_private_msg'
      && String(call.params.message).includes('2 older verification request(s) were returned to manual review')
    ));

    const cappedUser = '70002';
    for (let index = 0; index < MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER; index += 1) {
      const approval = createCaptchaApproval(String(81000 + index), cappedUser, `cap-${index}`);
      insertSession({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        approvalId: approval.id,
        groupId: approval.group_id,
        userId: cappedUser,
        answer: 'answer',
        createdAt: Date.now() + index,
      });
    }
    const overflow = createCaptchaApproval('81999', cappedUser, 'cap-overflow');
    await Promise.all([
      captchaService.issueChallenge(overflow.id),
      captchaService.issueChallenge(overflow.id),
    ]);

    assert.equal(approvalRepo.findById(overflow.id)?.status, 'pending');
    assert.equal(
      (getDatabase()
        .prepare('SELECT COUNT(*) AS count FROM captcha_sessions WHERE user_id = ? AND solved = 0')
        .get(cappedUser) as { count: number }).count,
      MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER
    );
  });
});

test('expired approvals are closed and excluded from active-session routing and caps', async () => {
  await withHarness(async () => {
    const userId = '73001';
    const orphanSessionIds: string[] = [];
    for (let index = 0; index < MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER; index += 1) {
      const approval = createCaptchaApproval(String(83000 + index), userId, `expired-${index}`);
      const sessionId = `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      orphanSessionIds.push(sessionId);
      insertSession({
        id: sessionId,
        approvalId: approval.id,
        groupId: approval.group_id,
        userId,
        answer: 'orphan',
        createdAt: Date.now() + index,
      });
      getDatabase()
        .prepare("UPDATE approval_records SET status = 'expired' WHERE id = ?")
        .run(approval.id);
    }

    const current = createCaptchaApproval('83999', userId, 'current');
    await captchaService.issueChallenge(current.id);

    assert.equal(approvalRepo.findById(current.id)?.status, 'captcha');
    assert.equal(
      (getDatabase()
        .prepare('SELECT COUNT(*) AS count FROM captcha_sessions WHERE approval_id = ? AND solved = 0')
        .get(current.id) as { count: number }).count,
      1,
      'expired approvals must not consume the active-session cap'
    );
    for (const sessionId of orphanSessionIds) {
      assert.equal(
        (getDatabase()
          .prepare('SELECT solved FROM captcha_sessions WHERE id = ?')
          .get(sessionId) as { solved: number }).solved,
        1,
        'reconciliation should close orphan CAPTCHA rows'
      );
    }
  });
});

test('approval TTL expiry overrides a longer CAPTCHA TTL during routing and cap checks', async () => {
  await withHarness(async () => {
    const userId = '73002';
    const expired = [];
    for (let index = 0; index < MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER; index += 1) {
      const approval = createCaptchaApproval(String(83100 + index), userId, `approval-ttl-${index}`);
      expired.push(approval);
      insertSession({
        id: `41000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        approvalId: approval.id,
        groupId: approval.group_id,
        userId,
        answer: 'expired-approval',
        createdAt: Date.now() + index,
        expiresAt: Date.now() + 300_000,
      });
      getDatabase()
        .prepare('UPDATE approval_records SET expires_at = ? WHERE id = ?')
        .run(Date.now() - 1, approval.id);
    }

    const current = createCaptchaApproval('83199', userId, 'after-approval-ttl');
    await captchaService.issueChallenge(current.id);

    assert.equal(approvalRepo.findById(current.id)?.status, 'captcha');
    for (const approval of expired) {
      assert.equal(approvalRepo.findById(approval.id)?.status, 'expired');
      assert.equal(
        (getDatabase()
          .prepare('SELECT solved FROM captcha_sessions WHERE approval_id = ?')
          .get(approval.id) as { solved: number }).solved,
        1,
        'a request past its own TTL must be closed even while its CAPTCHA TTL remains active'
      );
    }
  });
});

test('legacy reconciliation notice cannot delay processing an addressed reply', async () => {
  await withHarness(async (harness) => {
    const userId = '73003';
    const approvals = [];
    for (let index = 0; index < MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER + 1; index += 1) {
      const approval = createCaptchaApproval(String(83200 + index), userId, `nonblocking-notice-${index}`);
      approvals.push(approval);
      insertSession({
        id: `42000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        approvalId: approval.id,
        groupId: approval.group_id,
        userId,
        answer: 'answer',
        createdAt: Date.now() + index,
      });
    }

    const newestSessionId = `42000000-0000-4000-8000-${String(MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER).padStart(12, '0')}`;
    const reconciliationStarted = deferred();
    const neverFinishReconciliation = deferred();
    harness.onCall = async (action, params) => {
      if (
        action === 'send_private_msg'
        && String(params.message).includes('older verification request(s) were returned to manual review')
      ) {
        reconciliationStarted.resolve();
        await neverFinishReconciliation.promise;
      }
      return null;
    };

    try {
      assert.equal(
        await withDeadline(
          captchaService.handlePrivateMessage(
            privateReply(userId, `#${captchaChallengeCode(newestSessionId)} answer`)
          ),
          250,
        ),
        true,
      );
      assert.equal(
        approvalRepo.findById(approvals[MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER]!.id)?.status,
        'approved',
      );
      await withDeadline(reconciliationStarted.promise, 250);
    } finally {
      neverFinishReconciliation.resolve();
    }
  });
});

test('malformed hash selectors never consume the only active session attempt', async () => {
  await withHarness(async ({ calls }) => {
    const userId = '74001';
    const approval = createCaptchaApproval('84001', userId, 'malformed-selector');
    const sessionId = '50000000-0000-4000-8000-000000000001';
    insertSession({
      id: sessionId,
      approvalId: approval.id,
      groupId: approval.group_id,
      userId,
      answer: 'alpha',
      createdAt: Date.now(),
    });

    await captchaService.handlePrivateMessage(privateReply(userId, '#ABC alpha'));
    await captchaService.handlePrivateMessage(privateReply(userId, '#ABCDEF123 alpha'));
    assert.equal(attempts(sessionId), 0);
    assert.equal(approvalRepo.findById(approval.id)?.status, 'captcha');
    assert.ok(calls.some((call) =>
      call.action === 'send_private_msg'
      && String(call.params.message).includes(`#${captchaChallengeCode(sessionId)} — group 84001`)
    ));

    await captchaService.handlePrivateMessage(privateReply(userId, 'alpha'));
    assert.equal(approvalRepo.findById(approval.id)?.status, 'approved');
  });
});

test('a hash-prefixed answer remains valid for one unambiguous session', async () => {
  await withHarness(async () => {
    const userId = '74002';
    const approval = createCaptchaApproval('84002', userId, 'hash-answer');
    const sessionId = '50000000-0000-4000-8000-000000000002';
    insertSession({
      id: sessionId,
      approvalId: approval.id,
      groupId: approval.group_id,
      userId,
      answer: '#deadbeef00',
      createdAt: Date.now(),
    });

    await captchaService.handlePrivateMessage(privateReply(userId, '#DEADBEEF00'));

    assert.equal(approvalRepo.findById(approval.id)?.status, 'approved');
    assert.equal(attempts(sessionId), 1);
  });
});

test('challenge issuance revalidates an approval after waiting for the user lock', async () => {
  await withHarness(async () => {
    const userId = '74003';
    const approval = createCaptchaApproval('84003', userId, 'expired-while-waiting');
    const holderEntered = deferred();
    const releaseHolder = deferred();
    const holder = withLock(locks.captchaUser(userId), async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
    });
    await holderEntered.promise;

    const initialRead = deferred();
    const originalFindById = approvalRepo.findById.bind(approvalRepo);
    let matchingReads = 0;
    approvalRepo.findById = ((id: number) => {
      const record = originalFindById(id);
      if (id === approval.id && ++matchingReads === 1) initialRead.resolve();
      return record;
    }) as typeof approvalRepo.findById;

    try {
      const issuance = captchaService.issueChallenge(approval.id);
      await initialRead.promise;
      getDatabase()
        .prepare("UPDATE approval_records SET status = 'expired', processed_at = ? WHERE id = ?")
        .run(Date.now(), approval.id);
      releaseHolder.resolve();
      await Promise.all([holder, issuance]);
    } finally {
      approvalRepo.findById = originalFindById;
      releaseHolder.resolve();
      await holder;
    }

    assert.equal(approvalRepo.findById(approval.id)?.status, 'expired');
    assert.equal(
      (getDatabase()
        .prepare('SELECT COUNT(*) AS count FROM captcha_sessions WHERE approval_id = ?')
        .get(approval.id) as { count: number }).count,
      0,
      'an approval retired while queued must not receive a new session'
    );
  });
});

test('provider delivery does not block answers for another session owned by the same user', async () => {
  await withHarness(async (harness) => {
    const userId = '74004';
    const existing = createCaptchaApproval('84004', userId, 'existing-answer');
    insertSession({
      id: '50000000-0000-4000-8000-000000000004',
      approvalId: existing.id,
      groupId: existing.group_id,
      userId,
      answer: 'alpha',
      createdAt: Date.now() - 1_000,
    });
    const newer = createCaptchaApproval('84005', userId, 'blocked-delivery');
    const deliveryStarted = deferred();
    const releaseDelivery = deferred();
    harness.onCall = async (action, params) => {
      if (
        action === 'send_private_msg'
        && String(params.message).includes('Session code:')
        && String(params.message).includes(`group ${newer.group_id}`)
      ) {
        deliveryStarted.resolve();
        await releaseDelivery.promise;
      }
      return null;
    };

    const issuance = captchaService.issueChallenge(newer.id);
    await deliveryStarted.promise;
    const answer = captchaService.handlePrivateMessage(
      privateReply(userId, `#${captchaChallengeCode('50000000-0000-4000-8000-000000000004')} alpha`)
    );

    try {
      assert.equal(await withDeadline(answer, 250), true);
      assert.equal(approvalRepo.findById(existing.id)?.status, 'approved');
    } finally {
      releaseDelivery.resolve();
      await Promise.all([issuance, answer]);
    }
  });
});

test('expiry sweeps are non-overlapping and use bounded provider concurrency', async () => {
  await withHarness(async (harness) => {
    const userId = '75001';
    const staleCount = CAPTCHA_EXPIRY_SWEEP_CONCURRENCY + 3;
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseCalls!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCalls = resolve;
    });
    harness.onCall = async (action) => {
      if (action !== 'set_group_add_request') return null;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return null;
    };

    for (let index = 0; index < staleCount; index += 1) {
      const approval = createCaptchaApproval(String(85000 + index), userId, `stale-${index}`);
      insertSession({
        id: `60000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        approvalId: approval.id,
        groupId: approval.group_id,
        userId,
        answer: 'expired',
        createdAt: Date.now() - 10_000 + index,
        expiresAt: Date.now() - 1_000,
      });
    }

    const firstSweep = captchaService.expireAllStale();
    const overlappingSweep = captchaService.expireAllStale();
    assert.equal(overlappingSweep, firstSweep, 'overlapping timer ticks should share one sweep');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(inFlight, CAPTCHA_EXPIRY_SWEEP_CONCURRENCY);
    assert.equal(maxInFlight, CAPTCHA_EXPIRY_SWEEP_CONCURRENCY);

    releaseCalls();
    assert.deepEqual(await Promise.all([firstSweep, overlappingSweep]), [staleCount, staleCount]);
    assert.equal(maxInFlight, CAPTCHA_EXPIRY_SWEEP_CONCURRENCY);
    assert.equal(
      harness.calls.filter((call) => call.action === 'set_group_add_request').length,
      staleCount,
      'the overlapping sweep must not reject a session twice'
    );
  });
});

test('a timed-out provider action cannot permanently block later expiry sweeps', async () => {
  await withHarness(async (harness) => {
    const userId = '75002';
    const first = createCaptchaApproval('85020', userId, 'hung-expiry');
    insertSession({
      id: '60000000-0000-4000-8000-000000000020',
      approvalId: first.id,
      groupId: first.group_id,
      userId,
      answer: 'expired',
      createdAt: Date.now() - 2_000,
      expiresAt: Date.now() - 1_000,
    });

    const releaseFirstModeration = deferred();
    let moderationCalls = 0;
    harness.onCall = async (action) => {
      if (action !== 'set_group_add_request') return null;
      moderationCalls += 1;
      if (moderationCalls === 1) await releaseFirstModeration.promise;
      return null;
    };

    assert.equal(await withDeadline(captchaService.expireAllStale(20), 250), 1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const second = createCaptchaApproval('85021', userId, 'recoverable-expiry');
    insertSession({
      id: '60000000-0000-4000-8000-000000000021',
      approvalId: second.id,
      groupId: second.group_id,
      userId,
      answer: 'expired',
      createdAt: Date.now() - 1_500,
      expiresAt: Date.now() - 500,
    });

    assert.equal(await withDeadline(captchaService.expireAllStale(20), 250), 2);
    assert.equal(approvalRepo.findById(first.id)?.status, 'captcha');
    assert.equal(approvalRepo.findById(second.id)?.status, 'rejected');
    assert.equal(moderationCalls, 2, 'the next sweep should skip only the still-running session');
    releaseFirstModeration.resolve();
    await withDeadline((async () => {
      while (approvalRepo.findById(first.id)?.status !== 'rejected') {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    })(), 250);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

test('timed-out expiry actions retain their provider concurrency slots until settled', async () => {
  await withHarness(async (harness) => {
    const isolatedService = new CaptchaService();
    const userId = '75003';
    const staleCount = CAPTCHA_EXPIRY_SWEEP_CONCURRENCY + 3;
    const releaseModeration = deferred();
    let moderationCalls = 0;
    harness.onCall = async (action) => {
      if (action !== 'set_group_add_request') return null;
      moderationCalls += 1;
      await releaseModeration.promise;
      return null;
    };

    const approvals = [];
    for (let index = 0; index < staleCount; index += 1) {
      const approval = createCaptchaApproval(String(85030 + index), userId, `bounded-timeout-${index}`);
      approvals.push(approval);
      insertSession({
        id: `60000000-0000-4000-8000-${String(30 + index).padStart(12, '0')}`,
        approvalId: approval.id,
        groupId: approval.group_id,
        userId,
        answer: 'expired',
        createdAt: Date.now() - 2_000 + index,
        expiresAt: Date.now() - 1_000,
      });
    }

    assert.equal(await withDeadline(isolatedService.expireAllStale(20), 250), staleCount);
    assert.equal(moderationCalls, CAPTCHA_EXPIRY_SWEEP_CONCURRENCY);
    assert.equal(await withDeadline(isolatedService.expireAllStale(20), 250), staleCount);
    assert.equal(
      moderationCalls,
      CAPTCHA_EXPIRY_SWEEP_CONCURRENCY,
      'a later sweep must not exceed the provider limit while timed-out calls are still running'
    );

    releaseModeration.resolve();
    await withDeadline((async () => {
      while (approvals.slice(0, CAPTCHA_EXPIRY_SWEEP_CONCURRENCY)
        .some((approval) => approvalRepo.findById(approval.id)?.status !== 'rejected')) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    })(), 250);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      await withDeadline(isolatedService.expireAllStale(100), 250),
      staleCount - CAPTCHA_EXPIRY_SWEEP_CONCURRENCY,
    );
    assert.equal(moderationCalls, staleCount);
    assert.ok(approvals.every((approval) => approvalRepo.findById(approval.id)?.status === 'rejected'));
  });
});

test('busy CAPTCHA locks do not consume provider expiry slots or block unrelated sessions', async () => {
  await withHarness(async (harness) => {
    const isolatedService = new CaptchaService();
    const userId = '75004';
    const releaseLocks = deferred();
    const holders = [];
    for (let index = 0; index < CAPTCHA_EXPIRY_SWEEP_CONCURRENCY; index += 1) {
      const approval = createCaptchaApproval(String(85050 + index), userId, `busy-lock-${index}`);
      insertSession({
        id: `61000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        approvalId: approval.id,
        groupId: approval.group_id,
        userId,
        answer: 'expired',
        createdAt: Date.now() - 3_000 + index,
        expiresAt: Date.now() - 2_000 + index,
      });
      holders.push(withLock(locks.captcha(approval.id), async () => releaseLocks.promise));
    }

    const available = createCaptchaApproval('85099', userId, 'available-after-busy-locks');
    insertSession({
      id: '61000000-0000-4000-8000-000000000099',
      approvalId: available.id,
      groupId: available.group_id,
      userId,
      answer: 'expired',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() - 500,
    });

    let moderationCalls = 0;
    harness.onCall = async (action) => {
      if (action === 'set_group_add_request') moderationCalls += 1;
      return null;
    };

    try {
      assert.equal(await withDeadline(isolatedService.expireAllStale(100), 250), 5);
      assert.equal(moderationCalls, 1);
      assert.equal(approvalRepo.findById(available.id)?.status, 'rejected');
    } finally {
      releaseLocks.resolve();
      await Promise.all(holders);
    }
  });
});
