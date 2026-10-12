import { DatabaseSync } from 'node:sqlite';

export const version = 7;
export const description = 'Deduplicate statistic snapshots and enforce one global row per period';

export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE stat_snapshots_deduplicated AS
      SELECT
        MIN(id) AS id,
        group_id,
        period,
        SUM(approvals_total) AS approvals_total,
        SUM(approvals_passed) AS approvals_passed,
        SUM(approvals_rejected) AS approvals_rejected,
        SUM(captchas_total) AS captchas_total,
        SUM(captchas_passed) AS captchas_passed,
        SUM(punishments_total) AS punishments_total,
        SUM(risk_detections) AS risk_detections,
        MIN(created_at) AS created_at
      FROM stat_snapshots
      GROUP BY group_id, period;

    DELETE FROM stat_snapshots;

    INSERT INTO stat_snapshots (
      id, group_id, period, approvals_total, approvals_passed,
      approvals_rejected, captchas_total, captchas_passed,
      punishments_total, risk_detections, created_at
    )
    SELECT
      id, group_id, period, approvals_total, approvals_passed,
      approvals_rejected, captchas_total, captchas_passed,
      punishments_total, risk_detections, created_at
    FROM stat_snapshots_deduplicated;

    DROP TABLE stat_snapshots_deduplicated;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_stat_snapshots_global_period
      ON stat_snapshots(period)
      WHERE group_id IS NULL;
  `);
}
