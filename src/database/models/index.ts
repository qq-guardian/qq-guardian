/**
 * Database model types.
 * Each interface maps 1-to-1 to a SQLite table row (snake_case columns).
 */
import type { OneBotId } from '../../types/onebot.ts';

export interface DbUser {
  id: number;
  qq_id: OneBotId | null;
  username: string | null;
  password_hash: string | null;
  role: 'super_admin' | 'group_admin' | 'auditor' | 'viewer' | 'member';
  login_attempts: number;
  locked_until: number | null;
  last_login: number | null;
  created_at: number;
  updated_at: number;
}

export interface DbApprovalRecord {
  id: number;
  group_id: OneBotId;
  user_id: OneBotId;
  flag: string;
  comment: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'captcha';
  reason: string | null;
  operator_id: string | null;
  captcha_id: string | null;
  created_at: number;
  processed_at: number | null;
  expires_at: number;
}

export interface DbCaptchaSession {
  id: string;  // UUID
  group_id: OneBotId;
  user_id: OneBotId;
  approval_id: number;
  type: 'math' | 'text' | 'question';
  challenge: string;  // Question text
  answer: string;     // Correct answer (lowercase)
  attempts: number;
  max_attempts: number;
  created_at: number;
  expires_at: number;
  solved: 0 | 1;
}

export interface DbBlacklistEntry {
  id: number;
  user_id: OneBotId;
  group_id: OneBotId | null;  // null = global across all groups
  reason: string;
  /** null denotes an automated legacy action whose runtime self id was unknown. */
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface DbPunishmentRecord {
  id: number;
  group_id: OneBotId;
  user_id: OneBotId;
  type: 'mute' | 'kick';
  duration_seconds: number | null;  // null = permanent
  reason: string;
  /** null denotes an automated legacy action whose runtime self id was unknown. */
  operator_id: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface DbAuditLog {
  id: number;
  action: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  details: string;  // JSON string
  ip: string | null;
  created_at: number;
}

export interface DbLoginLog {
  id: number;
  user_id: number;
  ip: string;
  user_agent: string | null;
  success: 0 | 1;
  created_at: number;
}

export interface DbStatSnapshot {
  id: number;
  group_id: OneBotId | null;
  period: string;  // e.g. "2024-01-15"
  approvals_total: number;
  approvals_passed: number;
  approvals_rejected: number;
  captchas_total: number;
  captchas_passed: number;
  punishments_total: number;
  risk_detections: number;
  created_at: number;
}

export interface DbRiskRule {
  id: number;
  name: string;
  pattern: string;
  /** What happens when this rule matches: mute | kick | notify_admin | log_only | off */
  action: string;
  enabled: 0 | 1;
  created_at: number;
  updated_at: number;
}

/** Server-side session state keyed by the token's opaque jti/token id. */
export interface DbAuthSession {
  token_id: string;
  user_id: number;
  kind: 'access' | 'refresh';
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}
