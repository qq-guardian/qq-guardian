import type { OneBotId } from '../types/onebot.ts';

/**
 * Named async locks.
 * Prevents duplicate concurrent operations: approvals, punishments, updates.
 *
 * Usage:
 *   await withLock('approval:123456', async () => { ... });
 */

const _locks = new Map<string, Promise<void>>();

/**
 * Acquire a named lock, run fn, then release.
 * If another call is already holding the lock, waits for it to finish.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const previous = _locks.get(name);
  _locks.set(name, current);

  // Queue behind the exact predecessor rather than polling the map. This
  // preserves FIFO ordering when several events for the same flag arrive in
  // one turn of the event loop and avoids deleting a successor's lock.
  if (previous) await previous;

  try {
    return await fn();
  } finally {
    release();
    if (_locks.get(name) === current) _locks.delete(name);
  }
}

/**
 * Run work only when the named lock can be acquired immediately. The check
 * and reservation are synchronous within one JavaScript turn, so callers can
 * skip busy resources without joining an unbounded lock queue.
 */
export async function tryWithLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  if (_locks.has(name)) return { acquired: false };
  return { acquired: true, value: await withLock(name, fn) };
}

// ─── Convenience named locks ──────────────────────────────────────────────────

export const locks = {
  /** One approval action at a time per join-request flag */
  approval: (flag: string) => `approval:${flag}`,

  /** One punishment at a time per user-group pair */
  punishment: (groupId: OneBotId, userId: OneBotId) => `punishment:${groupId}:${userId}`,

  /** One captcha state transition at a time per approval record. */
  captcha: (approvalId: number) => `captcha:${approvalId}`,

  /** Serialize captcha issuance and active-session limits per user. */
  captchaUser: (userId: OneBotId) => `captcha-user:${userId}`,

  /** One ordered admission pipeline at a time per user-group pair. */
  memberJoin: (groupId: OneBotId, userId: OneBotId) => `member-join:${groupId}:${userId}`,

  /** One update at a time globally */
  update: () => 'update:global',
};
