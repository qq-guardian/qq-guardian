import { getDatabase } from '../index.ts';

export type LoginRateLimitScope = 'ip' | 'global';

export interface LoginRateLimitResult {
  allowed: boolean;
  attempts: number;
  resetAt: number;
}

const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Durable fixed-window login limiter.
 *
 * SQLite owns the counter transition, so plugin reloads/restarts cannot reset
 * an active window and concurrent requests cannot race a read/modify/write
 * sequence in JavaScript. Expired rows are pruned at most once per minute with
 * one indexed DELETE instead of O(n) scans on the request path.
 */
export class LoginRateLimitRepository {
  private lastCleanupAt = 0;

  consume(
    scope: LoginRateLimitScope,
    bucketKey: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): LoginRateLimitResult {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('rate-limit limit must be a positive integer');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('rate-limit window must be a positive integer');
    if (!bucketKey) throw new TypeError('rate-limit bucket key must not be empty');

    this.pruneExpired(now);
    const resetAt = now + windowMs;
    const row = getDatabase().prepare(
      `INSERT INTO login_rate_limits (scope, bucket_key, attempts, reset_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(scope, bucket_key) DO UPDATE SET
         attempts = CASE
           WHEN login_rate_limits.reset_at <= ? THEN 1
           ELSE login_rate_limits.attempts + 1
         END,
         reset_at = CASE
           WHEN login_rate_limits.reset_at <= ? THEN excluded.reset_at
           ELSE login_rate_limits.reset_at
         END,
         updated_at = excluded.updated_at
       RETURNING attempts, reset_at`
    ).get(scope, bucketKey, resetAt, now, now, now) as { attempts: number; reset_at: number };

    return {
      allowed: row.attempts <= limit,
      attempts: row.attempts,
      resetAt: row.reset_at,
    };
  }

  pruneExpired(now = Date.now(), force = false): number {
    if (!force && now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return 0;
    this.lastCleanupAt = now;
    const result = getDatabase()
      .prepare('DELETE FROM login_rate_limits WHERE reset_at <= ?')
      .run(now);
    return Number(result.changes);
  }

  clearForTests(): void {
    getDatabase().prepare('DELETE FROM login_rate_limits').run();
    this.lastCleanupAt = 0;
  }
}

export const loginRateLimitRepo = new LoginRateLimitRepository();
