/**
 * Complete plugin configuration schema.
 * All fields have defaults defined in defaults.ts.
 */
import type { OneBotId } from '../../types/onebot.ts';

export interface PluginConfig {
  core: CoreConfig;
  webui: WebuiConfig;
  approval: ApprovalConfig;
  captcha: CaptchaConfig;
  risk: RiskConfig;
  punishment: PunishmentConfig;
  blacklist: BlacklistConfig;
  auth: AuthConfig;
  monitor: MonitorConfig;
  update: UpdateConfig;
  ai: AIConfig;
  commands: CommandsConfig;
  intel: IntelConfig;
}

export interface CoreConfig {
  /** Bot's own QQ ID (self_id) */
  selfId: OneBotId;
  /** Super admin QQ IDs */
  superAdmins: OneBotId[];
  /** IANA timezone used to interpret schedule times (e.g. curfew windows).
   *  QQ's user base is effectively UTC+8, while Docker hosts often run UTC —
   *  so schedules are NOT interpreted in server-local time by default.
   *  Falls back to server-local time if the value is invalid. */
  timezone: string;
}

/** WebUI session settings. The UI itself is served through ctx.router —
 *  the plugin never runs its own HTTP server. */
export interface WebuiConfig {
  /** Session secret for JWT signing */
  jwtSecret: string;
  jwtExpiresIn: string;
  refreshExpiresIn: string;
}

export interface ApprovalConfig {
  /** Default action for groups not explicitly configured */
  defaultAction: 'auto_approve' | 'auto_reject' | 'manual' | 'captcha';
  /** Per-group overrides, keyed by group_id string */
  groups: Record<string, GroupApprovalConfig>;
  /** Request expires after N seconds */
  pendingTtlSeconds: number;
  /** Whether newly-discovered groups (never configured before) start with
   *  protection enabled or disabled. Safer default: false — an admin must
   *  explicitly opt a new group in before any automated action runs there. */
  defaultGroupEnabled: boolean;
  /** Screen join-request comments against the built-in spam/ad/fraud reject
   *  list in addition to each group's own reject keywords. */
  useBuiltinRejectKeywords: boolean;
  /** High-risk opt-in: auto-approve join requests whose attacker-controlled
   *  comment matches a generic referral phrase (e.g. 朋友推荐/群友邀请). Applies
   *  only to manual-review groups and defaults off. Explicit per-group allow
   *  rules are separate. Reject screening always runs first. */
  useBuiltinApproveKeywords: boolean;
  /** Poll get_group_system_msg so join requests are processed even when the
   *  OB11 request event was missed (bot offline / NapCat restart / plugin
   *  reload). Every unchecked request goes through the same screening
   *  pipeline as live events, with the latest penalty and red-flag data. */
  realtimeSyncEnabled: boolean;
  /** Interval between admission-sync polls, seconds (min 10). */
  syncIntervalSeconds: number;
}

/** Cloud intel feed — live network-reported red-flag users, professional
 *  warning keywords and reject patterns, fetched at runtime (never baked in
 *  statically) so every decision uses the latest published data. */
export interface IntelConfig {
  /** Master toggle. When off, all intel getters return empty data. */
  enabled: boolean;
  /** Observe never permits a remote document to cause a OneBot action.
   *  Enforce requires an exact SHA-256 pin for every configured feed. */
  enforcementMode: 'observe' | 'enforce';
  /** JSON feed URLs, fetched and merged. See intel/feed.json in the repo for
   *  the document shape. */
  feedUrls: string[];
  /** Canonical feed URL -> lowercase SHA-256 of the exact response bytes. */
  feedPins: Record<string, string>;
  /** Cache TTL / scheduled refresh interval, seconds (min 60). Decision
   *  points (join requests, member joins) also refresh on demand whenever
   *  the cached copy is older than this. */
  refreshIntervalSeconds: number;
}

export interface GroupApprovalConfig {
  /** Master toggle — if false, the plugin skips ALL processing (approval/risk/blacklist) for this group.
   *  One deliberate exception: if the curfew scheduler itself whole-group-muted
   *  the group, turning this off still performs a single final unmute — leaving
   *  a group muted forever would be strictly worse than one corrective action. */
  enabled: boolean;
  action: 'auto_approve' | 'auto_reject' | 'manual' | 'captcha';
  /** Approve if comment matches any of these keywords */
  approveKeywords: string[];
  /** Reject if comment matches any of these keywords */
  rejectKeywords: string[];
  /** Approve if comment matches any of these regex patterns */
  approvePatterns: string[];
  /** Reject if comment matches any of these regex patterns */
  rejectPatterns: string[];
  rejectReason: string;
  /** Per-group override for risk.enabled (falls back to global when unset) */
  riskEnabled: boolean;
  /** Per-group override for blacklist.autoKickOnJoin (falls back to global when unset) */
  autoKickBlacklisted: boolean;
  /** Notify super admins when risk is detected in this group */
  notifyOnRisk: boolean;
  /** Notify super admins when a new member joins this group */
  notifyOnJoin: boolean;
  /** Cached display name from the last successful get_group_list fetch.
   *  Persisted so the WebUI can still show a name even if a live fetch fails. */
  groupName: string;
  /** Send a welcome message when a new member joins this group */
  welcomeEnabled: boolean;
  /** Welcome template. Placeholders: {user} → new member's QQ, {group} → group name.
   *  Empty string = use the built-in default text. */
  welcomeTemplate: string;
  /** Scheduled whole-group mute window ("curfew" / 宵禁) */
  curfewEnabled: boolean;
  /** Curfew window start, 24h "HH:MM", interpreted in core.timezone
   *  (default Asia/Shanghai — NOT server-local time) */
  curfewStart: string;
  /** Curfew window end, 24h "HH:MM". May be earlier than curfewStart —
   *  the window then wraps past midnight (e.g. 23:00 → 07:00). */
  curfewEnd: string;
}

export interface CaptchaConfig {
  /** Seconds before captcha expires */
  ttlSeconds: number;
  /** Max attempts before rejection */
  maxAttempts: number;
  /** Supported captcha types */
  types: ('math' | 'text' | 'question')[];
  /** Custom Q&A pairs for question-type captcha */
  questions: Array<{ q: string; a: string }>;
}

/** What happens when a detector matches. 'off' disables the detector entirely. */
export type RiskDetectorAction = 'mute' | 'kick' | 'notify_admin' | 'log_only' | 'off';

export interface RiskConfig {
  enabled: boolean;
  /** Each detector maps DIRECTLY to its consequence — no opaque scoring.
   *  (The old 0-100 score + threshold model required a message to trip
   *  three separate detector categories before anything happened; a plain
   *  ad matching only the advertising patterns was silently ignored.)
   *  When several detectors match one message, the most severe action wins:
   *  kick > mute > notify_admin > log_only. Repeat offenders escalate
   *  through the existing punishment escalation settings. */
  detectorActions: {
    advertising: RiskDetectorAction;
    fraud: RiskDetectorAction;
    grayMarket: RiskDetectorAction;
    pornography: RiskDetectorAction;
    political: RiskDetectorAction;
    gambling: RiskDetectorAction;
    shortLinks: RiskDetectorAction;
    duplicateMessages: RiskDetectorAction;
    spam: RiskDetectorAction;
    /** Rich json/miniapp cards are not inherently malicious; default is log_only. */
    cardMessage: RiskDetectorAction;
    aiViolation: RiskDetectorAction;
  };
  muteDurationSeconds: number;
  /** AI analysis genuinely returns a 0-100 score; results at or above this
   *  count as an aiViolation hit. The one numeric knob that remains. */
  aiMinScore: number;
  /** Also recall (delete) the offending message when risk is detected.
   *  Runs in addition to the configured action, never instead of it. */
  recallMessage: boolean;
}

export interface PunishmentConfig {
  /** Default mute duration seconds */
  defaultMuteDurationSeconds: number;
  /** Escalation: after N active, unrevoked punishments escalate to kick.
   *  Expired records do not count; zero disables automatic kick escalation. */
  escalateToKickAfter: number;
  /** Escalation: after N active, unrevoked kick records escalate to blacklist.
   *  Mutes never count; zero disables automatic blacklist escalation. */
  escalateToBlacklistAfter: number;
}

export interface BlacklistConfig {
  /** Auto kick on join if blacklisted */
  autoKickOnJoin: boolean;
}

export interface AuthConfig {
  /** Max login attempts before lockout */
  maxLoginAttempts: number;
  /** Lockout duration seconds */
  lockoutSeconds: number;
  /** Rate limit: requests per window */
  rateLimitRequests: number;
  rateLimitWindowMs: number;
}

export interface MonitorConfig {
  /** Health check interval ms */
  intervalMs: number;
  /** Alert if disk free below this MB */
  diskAlertMb: number;
  /** Alert if memory usage above this % */
  memoryAlertPercent: number;
}

export interface UpdateConfig {
  /** GitHub repo for release checks, e.g. "ShiYuPIay/napcat-plugin-qq-guardian" */
  githubRepo: string;
  /** Auto-check for updates on startup */
  autoCheckOnStartup: boolean;
}

export interface AIConfig {
  provider: 'openai' | 'anthropic' | 'custom' | 'disabled';
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** System prompt for risk assessment */
  riskPrompt: string;
}

export interface CommandsConfig {
  /** Master toggle for in-chat admin commands */
  enabled: boolean;
  /** Command prefix, e.g. "/guard" → "/guard mute @user 10" */
  prefix: string;
}

/** Recursive partial used by configManager.update() — lets callers pass just
 *  the fields they change with full type checking (arrays stay atomic). */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer _U)[] ? T[K]
    : T[K] extends object ? DeepPartial<T[K]>
    : T[K];
};
