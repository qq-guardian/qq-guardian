import { randomUUID, timingSafeEqual, createHash } from 'crypto';
import { getDatabase } from '../../database/index.ts';
import { approvalRepo } from '../../database/repositories/approval.ts';
import { configManager } from '../../core/config/index.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import { bus } from '../../core/events/index.ts';
import { withLock, tryWithLock, locks } from '../../core/locks.ts';
import { statisticsRepo } from '../../database/repositories/statistics.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { OB11Message } from '../../types/napcat.ts';
import type { DbCaptchaSession } from '../../database/models/index.ts';
import { approvalService } from '../approval/index.ts';
import type { OneBotId } from '../../types/onebot.ts';

const EXPIRY_SWEEP_MS = 60_000;
const CHALLENGE_CODE_LENGTH = 10;
const CHALLENGE_CODE_PATTERN = /^#[a-f0-9]{10}$/i;
export const MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER = 5;
export const CAPTCHA_EXPIRY_SWEEP_CONCURRENCY = 4;
export const CAPTCHA_EXPIRY_ACTION_TIMEOUT_MS = 15_000;

/**
 * Stable, non-sequential reply code derived from the session UUID. Existing
 * in-flight sessions therefore remain selectable after an upgrade without a
 * schema rewrite. Codes are always scoped to the private-message sender.
 */
export function captchaChallengeCode(sessionId: string): string {
  return createHash('sha256')
    .update(`qq-guardian-captcha:${sessionId}`)
    .digest('hex')
    .slice(0, CHALLENGE_CODE_LENGTH)
    .toUpperCase();
}

interface CaptchaAnswerSelection {
  session: DbCaptchaSession;
  answer: string;
}

interface CaptchaSessionReconciliation {
  active: DbCaptchaSession[];
  retired: DbCaptchaSession[];
}

type CaptchaIssueResult =
  | { kind: 'none'; retired: DbCaptchaSession[]; userId: OneBotId }
  | { kind: 'capped'; activeCount: number; retired: DbCaptchaSession[]; userId: OneBotId }
  | {
    kind: 'issued';
    challenge: string;
    code: string;
    groupId: OneBotId;
    id: string;
    retired: DbCaptchaSession[];
    ttlSeconds: number;
    userId: OneBotId;
  };

export class CaptchaService {
  private _sweepTimer: NodeJS.Timeout | null = null;
  private _sweepPromise: Promise<number> | null = null;
  private readonly _expiringSessions = new Map<string, Promise<void>>();
  private _activeExpiryActions = 0;

  init(): void {
    if (this._sweepTimer) return;
    bus.on('CaptchaRequired', async (payload) => {
      await this.issueChallenge(payload.approvalId).catch((error) =>
        getLogger().child({ module: 'captcha' }).error(error, 'Failed to issue challenge')
      );
    });
    this._sweepTimer = setInterval(() => {
      void this.expireAllStale();
    }, EXPIRY_SWEEP_MS);
  }

  stop(): void {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  async issueChallenge(approvalId: number): Promise<void> {
    await withLock(locks.captcha(approvalId), async () => {
      const rec = approvalRepo.findById(approvalId);
      if (!rec || rec.status !== 'captcha') return;

      const issuance = await withLock(locks.captchaUser(rec.user_id), async (): Promise<CaptchaIssueResult> => {
        const db = getDatabase();
        // Hourly maintenance is not serialized by the CAPTCHA locks. Re-read
        // after waiting for the user lock, then use a conditional update below
        // so an expired/manual decision can never be resurrected.
        const current = approvalRepo.findById(approvalId);
        if (!current || current.status !== 'captcha' || current.expires_at < Date.now()) {
          return { kind: 'none', retired: [], userId: rec.user_id };
        }
        const existing = db
          .prepare('SELECT id FROM captcha_sessions WHERE approval_id = ? AND solved = 0 LIMIT 1')
          .get(approvalId) as { id: string } | undefined;
        if (existing) return { kind: 'none', retired: [], userId: current.user_id };

        const now = Date.now();
        const { active, retired } = this._reconcileActiveSessions(current.user_id, now);
        if (active.length >= MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER) {
          this._markApprovalPending(approvalId, 'captcha_active_session_limit');
          return { kind: 'capped', activeCount: active.length, retired, userId: current.user_id };
        }

        const activeCodes = new Set(active.map((session) => captchaChallengeCode(session.id)));
        let id = randomUUID();
        for (let attempt = 0; activeCodes.has(captchaChallengeCode(id)) && attempt < 8; attempt += 1) {
          id = randomUUID();
        }
        const code = captchaChallengeCode(id);
        if (activeCodes.has(code)) throw new Error('Could not allocate a unique captcha challenge code');

        const cfg = configManager.get().captcha;
        const type = cfg.types[Math.floor(Math.random() * cfg.types.length)] ?? 'math';
        const { challenge, answer } = this._generate(type);

        db.prepare(
          `INSERT INTO captcha_sessions (id, group_id, user_id, approval_id, type, challenge, answer, attempts, max_attempts, created_at, expires_at, solved)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, current.group_id, current.user_id, approvalId, type, challenge, answer, 0, cfg.maxAttempts, now, now + cfg.ttlSeconds * 1000, 0);

        const claimed = db.prepare(
          `UPDATE approval_records
           SET captcha_id = ?, processed_at = ?
           WHERE id = ? AND status = 'captcha' AND expires_at >= ?`
        ).run(id, now, approvalId, now);
        if (Number(claimed.changes) !== 1) {
          this._closeSession(id);
          return { kind: 'none', retired, userId: current.user_id };
        }
        statisticsRepo.bump(current.group_id, 'captchas_total');
        return {
          kind: 'issued', challenge, code, groupId: current.group_id, id,
          retired, ttlSeconds: cfg.ttlSeconds, userId: current.user_id,
        };
      });

      // Provider I/O must never hold the per-user lock: replies to an existing
      // challenge remain routable even when delivery of a newer one is slow.
      if (issuance.retired.length > 0) {
        await this._sendReconciliationNotice(issuance.userId, issuance.retired);
      }
      if (issuance.kind === 'none') return;
      if (issuance.kind === 'capped') {
        await this._sendNotice(
          issuance.userId,
          `You already have ${MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER} active verification sessions. `
            + 'Complete or wait for one to expire before requesting another; this request is pending manual review.'
        );
        getLogger().child({ module: 'captcha' }).warn(
          { user_id: issuance.userId, active_sessions: issuance.activeCount },
          'Captcha active-session limit reached'
        );
        return;
      }

      try {
        await callAction('send_private_msg', {
          user_id: String(issuance.userId),
          message: this._buildMsg(
            issuance.challenge,
            issuance.ttlSeconds,
            issuance.code,
            issuance.groupId,
          ),
        });
      } catch (error) {
        // A challenge that could not be delivered is not usable. Keep the
        // approval in the normal manual queue and retain the closed session
        // for auditability rather than allowing a stale answer later.
        this._closeSession(issuance.id);
        this._markApprovalPending(approvalId, 'captcha_delivery_failed');
        throw error;
      }

      getLogger().child({ module: 'captcha' }).info(
        { session_id: issuance.id, user_id: issuance.userId },
        'Captcha issued'
      );
    });
  }

  async handlePrivateMessage(event: OB11Message): Promise<boolean> {
    if (event.message_type !== 'private') return false;
    const now = Date.now();
    const { active, retired } = await withLock(
      locks.captchaUser(event.user_id),
      async () => this._reconcileActiveSessions(event.user_id, now)
    );
    try {
      if (active.length === 0) {
        // Preserve the old immediate-expiry behavior for the newest stale row;
        // the deterministic sweep will close any remaining stale sessions.
        const stale = getDatabase()
          .prepare(
            `SELECT captcha_sessions.* FROM captcha_sessions
             INNER JOIN approval_records ON approval_records.id = captcha_sessions.approval_id
             WHERE captcha_sessions.user_id = ?
               AND captcha_sessions.solved = 0
               AND captcha_sessions.expires_at < ?
               AND approval_records.status = 'captcha'
             ORDER BY captcha_sessions.expires_at ASC,
               captcha_sessions.created_at ASC,
               captcha_sessions.id ASC
             LIMIT 1`
          )
          .get(event.user_id, now) as DbCaptchaSession | undefined;
        return stale ? await this._processAnswer(stale, event.raw_message) : false;
      }

      const selection = this._selectAnswer(active, event.raw_message);
      if (!selection) {
        await this._sendSelectionHint(event.user_id, active);
        return true;
      }
      return await this._processAnswer(selection.session, selection.answer);
    } finally {
      // Legacy-reconciliation messaging is informational. Start it only after
      // the reply has been handled and never let slow provider I/O hold up a
      // valid answer received before its deadline.
      if (retired.length > 0) void this._sendReconciliationNotice(event.user_id, retired);
    }
  }

  expireAllStale(actionTimeoutMs = CAPTCHA_EXPIRY_ACTION_TIMEOUT_MS): Promise<number> {
    if (this._sweepPromise) return this._sweepPromise;
    const sweep = this._expireAllStale(actionTimeoutMs);
    this._sweepPromise = sweep;
    void sweep.finally(() => {
      if (this._sweepPromise === sweep) this._sweepPromise = null;
    }).catch(() => undefined);
    return sweep;
  }

  private async _expireAllStale(actionTimeoutMs: number): Promise<number> {
    if (!Number.isSafeInteger(actionTimeoutMs) || actionTimeoutMs < 1) {
      throw new Error('Captcha expiry action timeout must be a positive integer');
    }
    const stale = getDatabase()
      .prepare(
        `SELECT * FROM captcha_sessions
         WHERE solved = 0 AND expires_at < ?
         ORDER BY expires_at ASC, created_at ASC, id ASC`
      )
      .all(Date.now()) as unknown as DbCaptchaSession[];

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < stale.length) {
        const session = stale[nextIndex++]!;
        if (this._expiringSessions.has(session.id)) continue;
        const action = this._tryStartExpiryAction(session);
        // A timed-out provider promise keeps its slot until it actually
        // settles. End this worker when every slot is occupied; a later sweep
        // will retry queued sessions as soon as capacity returns.
        if (!action) return;
        try {
          await this._awaitExpiryAction(action, actionTimeoutMs);
        } catch (error) {
          getLogger().child({ module: 'captcha' }).error(error, 'Failed to expire captcha session');
        }
      }
    };
    const workerCount = Math.min(CAPTCHA_EXPIRY_SWEEP_CONCURRENCY, stale.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return stale.length;
  }

  private async _processAnswer(candidate: DbCaptchaSession, answer: string): Promise<boolean> {
    return withLock(locks.captcha(candidate.approval_id), async () => {
      const session = this._findSession(candidate.id);
      if (!session || session.solved !== 0) return true;

      if (Date.now() > session.expires_at) {
        await this._rejectSessionLocked(
          session,
          'Captcha expired',
          '⏰ Verification timed out. Your join request has been rejected.'
        );
        return true;
      }

      const result = getDatabase()
        .prepare(
          `UPDATE captcha_sessions
           SET attempts = attempts + 1
           WHERE id = ? AND solved = 0 AND expires_at >= ?`
        )
        .run(session.id, Date.now());
      if (Number(result.changes) !== 1) return true;

      const attempts = session.attempts + 1;
      const actual = this._digest(answer);
      const expected = this._digest(session.answer);
      if (timingSafeEqual(actual, expected)) {
        await this._approveSessionLocked(session);
        return true;
      }

      const remaining = session.max_attempts - attempts;
      if (remaining <= 0) {
        await this._rejectSessionLocked(
          session,
          'Too many wrong attempts',
          '❌ Verification failed: Too many wrong attempts. Your join request has been rejected.'
        );
        return true;
      }

      await this._sendNotice(
        session.user_id,
        `❌ Wrong answer. ${remaining} attempt(s) left.\n\n${session.challenge}`
      );
      return true;
    });
  }

  /**
   * Reconciles unlimited pre-upgrade rows into the bounded runtime contract.
   * The newest uniquely-addressable sessions remain active; older or
   * code-colliding requests return to manual review instead of being rejected.
   */
  private _reconcileActiveSessions(userId: OneBotId, now: number): CaptchaSessionReconciliation {
    const db = getDatabase();
    const active: DbCaptchaSession[] = [];
    const retired: DbCaptchaSession[] = [];
    const codes = new Set<string>();

    db.exec('BEGIN IMMEDIATE');
    try {
      // The approval request can have a shorter TTL than its CAPTCHA. Retire
      // that request transactionally so it cannot remain routable or consume
      // one of the user's active-session slots until hourly maintenance runs.
      db.prepare(
        `UPDATE approval_records
         SET status = 'expired', processed_at = ?
         WHERE user_id = ? AND status = 'captcha' AND expires_at < ?`
      ).run(now, userId, now);

      // Approval expiry and manual decisions can retire an approval before its
      // longer CAPTCHA TTL. Close those orphan rows first so they cannot consume
      // the per-user cap, answer routing, or future expiry-sweep capacity.
      db.prepare(
        `UPDATE captcha_sessions
         SET solved = 1
         WHERE user_id = ? AND solved = 0
           AND NOT EXISTS (
             SELECT 1 FROM approval_records
             WHERE approval_records.id = captcha_sessions.approval_id
               AND approval_records.status = 'captcha'
           )`
      ).run(userId);

      const candidates = db
        .prepare(
          `SELECT captcha_sessions.* FROM captcha_sessions
           INNER JOIN approval_records ON approval_records.id = captcha_sessions.approval_id
           WHERE captcha_sessions.user_id = ?
              AND captcha_sessions.solved = 0
              AND captcha_sessions.expires_at >= ?
              AND approval_records.status = 'captcha'
              AND approval_records.expires_at >= ?
            ORDER BY captcha_sessions.created_at DESC, captcha_sessions.id DESC`
        )
        .all(userId, now, now) as unknown as DbCaptchaSession[];

      for (const session of candidates) {
        const code = captchaChallengeCode(session.id);
        if (active.length < MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER && !codes.has(code)) {
          codes.add(code);
          active.push(session);
        } else {
          retired.push(session);
        }
      }

      const closeSession = db.prepare(
        'UPDATE captcha_sessions SET solved = 1 WHERE id = ? AND solved = 0'
      );
      const returnToManualReview = db.prepare(
        `UPDATE approval_records
         SET status = 'pending', reason = ?, operator_id = NULL, processed_at = NULL
         WHERE id = ? AND status = 'captcha'`
      );
      for (const session of retired) {
        closeSession.run(session.id);
        returnToManualReview.run('captcha_active_session_limit_migration', session.approval_id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { active, retired };
  }

  private async _sendReconciliationNotice(userId: OneBotId, retired: DbCaptchaSession[]): Promise<void> {
    const groups = retired.slice(0, 10).map((session) => session.group_id).join(', ');
    const suffix = retired.length > 10 ? ` and ${retired.length - 10} more` : '';
    await this._sendNotice(
      userId,
      `For safety, ${retired.length} older verification request(s) were returned to manual review `
        + `(group ${groups}${suffix}). Your newest ${MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER} sessions remain selectable.`
    );
  }

  private _selectAnswer(sessions: DbCaptchaSession[], rawMessage: string): CaptchaAnswerSelection | null {
    const trimmed = rawMessage.trim();
    // A configured answer may itself begin with "#" or look exactly like a
    // routing token. In the unambiguous single-session case, recognize the
    // correct answer before interpreting selector syntax. Mistyped selectors
    // still produce a hint without consuming an attempt.
    if (sessions.length === 1 && timingSafeEqual(this._digest(trimmed), this._digest(sessions[0]!.answer))) {
      return { session: sessions[0]!, answer: trimmed };
    }
    const firstWhitespace = trimmed.search(/\s/);
    const firstToken = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
    const explicitAnswer = firstWhitespace === -1 ? '' : trimmed.slice(firstWhitespace).trim();
    const looksExplicit = CHALLENGE_CODE_PATTERN.test(firstToken);

    // A hash-prefixed first token is always a selector attempt. Mistyped or
    // truncated selectors must produce a routing hint instead of becoming an
    // answer and consuming the sole session's attempt budget.
    if (firstToken.startsWith('#') && !looksExplicit) return null;

    if (looksExplicit) {
      if (!explicitAnswer) return null;
      const suppliedCode = firstToken.slice(1);
      const selected = sessions.find(
        (session) => timingSafeEqual(
          Buffer.from(captchaChallengeCode(session.id).toLowerCase()),
          Buffer.from(suppliedCode.toLowerCase())
        )
      );
      return selected ? { session: selected, answer: explicitAnswer } : null;
    }

    // Backward compatibility is deliberately limited to the unambiguous case.
    // With multiple sessions, answer-only replies cannot be routed safely.
    return sessions.length === 1 ? { session: sessions[0]!, answer: trimmed } : null;
  }

  private async _sendSelectionHint(userId: OneBotId, sessions: DbCaptchaSession[]): Promise<void> {
    const choices = sessions
      .slice(0, MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER)
      .map((session) => `#${captchaChallengeCode(session.id)} — group ${session.group_id}`)
      .join('\n');
    const instruction = sessions.length === 1
      ? `Reply with your answer, or use "#${captchaChallengeCode(sessions[0]!.id)} <answer>".`
      : 'Multiple verification sessions are pending. Reply with "#<code> <answer>" for the intended group.';
    await this._sendNotice(userId, `${instruction}\n\n${choices}`);
  }

  private async _approveSessionLocked(session: DbCaptchaSession): Promise<void> {
    const rec = approvalRepo.findById(session.approval_id);
    if (!rec || rec.status !== 'captcha') {
      this._closeSession(session.id);
      return;
    }

    let approved: boolean;
    try {
      approved = await approvalService.approveAfterCaptcha(rec);
    } catch (error) {
      this._closeSession(session.id);
      getLogger().child({ module: 'captcha' }).warn(
        { approval_id: session.approval_id, session_id: session.id },
        'Captcha answer accepted, but OneBot approval failed; queued for manual review'
      );
      await this._sendNotice(session.user_id, 'Verification was received, but your join request is pending administrator review.');
      return;
    }

    this._closeSession(session.id);
    if (!approved) return;

    statisticsRepo.bump(session.group_id, 'captchas_passed');
    await this._sendNotice(session.user_id, '✅ Verification passed! Your join request has been approved.');
  }

  private async _rejectSessionLocked(session: DbCaptchaSession, reason: string, notice: string): Promise<void> {
    const rec = approvalRepo.findById(session.approval_id);
    if (!rec || rec.status !== 'captcha') {
      this._closeSession(session.id);
      return;
    }

    let rejected: boolean;
    try {
      rejected = await approvalService.rejectAfterCaptchaFail(rec, reason);
    } catch (error) {
      this._closeSession(session.id);
      getLogger().child({ module: 'captcha' }).warn(
        { approval_id: session.approval_id, session_id: session.id },
        'Captcha rejection failed; queued for manual review'
      );
      await this._sendNotice(session.user_id, 'Verification could not be completed. Your join request is pending administrator review.');
      return;
    }

    this._closeSession(session.id);
    if (rejected) await this._sendNotice(session.user_id, notice);
  }

  private _findSession(id: string): DbCaptchaSession | null {
    return (
      (getDatabase().prepare('SELECT * FROM captcha_sessions WHERE id = ?').get(id) as DbCaptchaSession | undefined)
      ?? null
    );
  }

  private _closeSession(id: string): void {
    getDatabase().prepare('UPDATE captcha_sessions SET solved = 1 WHERE id = ? AND solved = 0').run(id);
  }

  private _markApprovalPending(approvalId: number, code: string): void {
    getDatabase()
      .prepare(
        `UPDATE approval_records
         SET status = 'pending', reason = ?, operator_id = NULL, processed_at = NULL
         WHERE id = ? AND status = 'captcha'`
      )
      .run(code, approvalId);
  }

  private _digest(value: string): Buffer {
    return createHash('sha256').update(value.trim().toLowerCase()).digest();
  }

  private async _sendNotice(userId: OneBotId, message: string): Promise<void> {
    try {
      await callAction('send_private_msg', { user_id: String(userId), message });
    } catch (error) {
      getLogger().child({ module: 'captcha' }).warn(
        { user_id: userId },
        'Could not send captcha private message'
      );
    }
  }

  private _generate(type: 'math' | 'text' | 'question'): { challenge: string; answer: string } {
    if (type === 'question') {
      const qs = configManager.get().captcha.questions;
      if (qs.length > 0) {
        const q = qs[Math.floor(Math.random() * qs.length)];
        return { challenge: q.q, answer: q.a.trim().toLowerCase() };
      }
    }
    if (type === 'text') {
      const n = Math.floor(Math.random() * 9000) + 1000;
      return { challenge: `Please reply with the number: ${n}`, answer: String(n) };
    }
    const ops = ['+', '-', '*'] as const;
    const op = ops[Math.floor(Math.random() * ops.length)];
    const a = Math.floor(Math.random() * 20) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    const result = op === '+' ? a + b : op === '-' ? a - b : a * b;
    return { challenge: `🔢 Math verification: What is ${a} ${op} ${b}? Reply with the number only.`, answer: String(result) };
  }

  private _buildMsg(challenge: string, ttlSeconds: number, code: string, groupId: OneBotId): string {
    return `👋 Welcome! Please complete verification for group ${groupId}.\n\n`
      + `Session code: #${code}\n${challenge}\n\n`
      + `⏱ You have ${Math.round(ttlSeconds / 60)} minute(s) to answer. `
      + `Reply "#${code} <answer>" when you have multiple pending sessions; with only one, the answer alone still works.`;
  }

  private _tryStartExpiryAction(session: DbCaptchaSession): Promise<void> | null {
    if (
      this._expiringSessions.has(session.id)
      || this._activeExpiryActions >= CAPTCHA_EXPIRY_SWEEP_CONCURRENCY
    ) return null;

    const action = this._rejectExpiredSessionIfAvailable(session);
    this._expiringSessions.set(session.id, action);
    void action.finally(() => {
      if (this._expiringSessions.get(session.id) === action) {
        this._expiringSessions.delete(session.id);
      }
    }).catch(() => undefined);
    return action;
  }

  private async _rejectExpiredSessionIfAvailable(candidate: DbCaptchaSession): Promise<void> {
    await tryWithLock(locks.captcha(candidate.approval_id), async () => {
      const session = this._findSession(candidate.id);
      if (!session || session.solved !== 0) return;

      // Busy CAPTCHA locks are skipped before this point, so only provider
      // work that can start now consumes a global moderation slot. A timed-out
      // provider call retains that slot until its underlying promise settles.
      if (this._activeExpiryActions >= CAPTCHA_EXPIRY_SWEEP_CONCURRENCY) return;
      this._activeExpiryActions += 1;
      try {
        await this._rejectSessionLocked(
          session,
          'Captcha expired',
          '⏰ Verification timed out. Your join request has been rejected.',
        );
      } finally {
        this._activeExpiryActions -= 1;
      }
    });
  }

  private async _awaitExpiryAction(action: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        action,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Captcha expiry provider action exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const captchaService = new CaptchaService();
