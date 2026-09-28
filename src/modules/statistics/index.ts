import { statisticsRepo } from '../../database/repositories/statistics.ts';
import { approvalRepo } from '../../database/repositories/approval.ts';
import { blacklistRepo } from '../../database/repositories/blacklist.ts';
import { getLogger } from '../../core/logger/index.ts';

let _timer: NodeJS.Timeout | null = null;

// This is not a historical-retention policy: it only bounds the pre-existing
// deletion of blacklist entries that have already expired semantically.
const EXPIRED_BLACKLIST_BATCH_SIZE = 250;

export function initStatisticsModule(): void {
  runHourlyMaintenance();
  _timer = setInterval(runHourlyMaintenance, 3_600_000);
}

export function stopStatisticsModule(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Periodic database housekeeping for state that has already expired. Audit,
 * login, punishment, captcha, and update history are intentionally retained;
 * their deletion requires a separately approved, user-configured policy.
 */
export function runHourlyMaintenance(): void {
  const log = getLogger().child({ module: 'statistics' });
  try {
    const expiredApprovals = approvalRepo.expireOldPending();
    const expiredBlacklist = blacklistRepo.purgeExpired(EXPIRED_BLACKLIST_BATCH_SIZE);
    if (expiredApprovals > 0 || expiredBlacklist > 0) {
      log.debug({ expiredApprovals, expiredBlacklist }, 'Expired Guardian operational state');
    }
  } catch (error) {
    log.error(error, 'Maintenance error');
  }
}

export function getOverviewStats() {
  return {
    totals: statisticsRepo.totals(),
    approvalCounts: approvalRepo.countByStatus(),
    recent30Days: statisticsRepo.findRecent(30),
  };
}
