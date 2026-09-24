import { bus } from '../../core/events/index.ts';
import { getLogger } from '../../core/logger/index.ts';
import { auditRepo } from '../../database/repositories/audit.ts';

export const AUDIT_RETENTION_DAYS = 90;
const AUDIT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
let retentionTimer: ReturnType<typeof setInterval> | null = null;

function pruneRetainedHistory(): void {
  const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  try {
    const pruned = auditRepo.pruneHistory(cutoff);
    const total = Object.values(pruned).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      getLogger().child({ module: 'audit' }).info({ retentionDays: AUDIT_RETENTION_DAYS, ...pruned }, 'Historical records pruned');
    }
  } catch (error) {
    getLogger().child({ module: 'audit' }).warn(error, 'Historical retention prune failed');
  }
}

export function initAuditModule(): void {
  bus.on('AuditCreated', (payload) => {
    auditRepo.log({
      action: payload.action,
      actorId: payload.actorId ?? undefined,
      targetType: payload.targetType ?? undefined,
      targetId: payload.targetId ?? undefined,
      details: payload.details,
    });
  });

  pruneRetainedHistory();
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = setInterval(pruneRetainedHistory, AUDIT_RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}

export function stopAuditModule(): void {
  if (!retentionTimer) return;
  clearInterval(retentionTimer);
  retentionTimer = null;
}
