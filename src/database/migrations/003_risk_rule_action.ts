import { DatabaseSync } from 'node:sqlite';

export const version = 3;
export const description = 'Add per-rule action column to risk_rules';

export function up(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(risk_rules)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'action')) {
    db.exec(`ALTER TABLE risk_rules ADD COLUMN action TEXT NOT NULL DEFAULT 'mute';`);
  }
}
