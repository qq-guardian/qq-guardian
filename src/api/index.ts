/**
 * REST API routes — registered as no-auth NapCat routes, but protected by
 * an application-level Bearer token check (requireAuth).
 *
 * From NapCat log (authoritative): no-auth routes resolve to
 *   /plugin/napcat-plugin-qq-guardian/api/<path>
 *
 * Response format matches NapCat convention: { code: 0, data } / { code: -1, message }
 */
import { getProviderTelemetry, getRuntimeHost as getCtx, callOneBot as callAction } from '../runtime/host.ts';
import { approvalRepo }    from '../database/repositories/approval.ts';
import { blacklistRepo }   from '../database/repositories/blacklist.ts';
import { punishmentRepo }  from '../database/repositories/punishment.ts';
import { auditRepo }       from '../database/repositories/audit.ts';
import { loginRateLimitRepo } from '../database/repositories/rate-limit.ts';
import { approvalService } from '../modules/approval/index.ts';
import { syncPendingJoinRequests } from '../modules/approval/sync.ts';
import { punishmentService } from '../modules/punishment/index.ts';
import { riskService }     from '../modules/risk/index.ts';
import { intelService }    from '../modules/intel/index.ts';
import { configManager }   from '../core/config/index.ts';
import { parseBoolean }    from '../core/config/boolean.ts';
import { resolveGroupConfig } from '../core/config/group.ts';
import {
  bootstrapGroups,
  getCachedBotInfo,
  getCachedGroupList,
  normalizeBotInfoResponse,
  normalizeGroupListResponse,
  type OneBotGroup,
} from '../modules/groups/index.ts';
import { getLastHealthStatus } from '../modules/monitor/index.ts';
import { getOverviewStats }    from '../modules/statistics/index.ts';
import { checkForUpdate, downloadUpdate, getCurrentVersion, fetchReleases, normalizeReleaseVersion } from '../modules/update/index.ts';
import { getDatabase }     from '../database/index.ts';
import { hashPassword } from '../core/crypto/index.ts';
import {
  authenticateAccessToken, login, refreshTokens,
  logout as logoutUser,
  hasRole, validatePasswordForCreation, type AuthRole,
} from '../modules/auth/index.ts';
import {
  isUsableSuperAdmin,
  UserAdminMutationError,
  userRepo,
  type UserAdministrativeUpdate,
} from '../database/repositories/user.ts';
import type { DbUser }     from '../database/models/index.ts';
import type { PluginConfig } from '../core/config/types.ts';
import type { GuardianHttpRequest as PluginHttpRequest, GuardianHttpResponse as PluginHttpResponse } from '../ports/http.ts';
import { ConfigValidationError, validatePersistedApprovalPatterns } from '../core/config/schema.ts';
import { validateRegexPattern } from '../core/regex/index.ts';
import { getLogger } from '../core/logger/index.ts';
import type { ProviderTelemetrySnapshot } from '../runtime/provider-telemetry.ts';
import { normalizeOneBotId } from '../types/onebot.ts';

type H = (req: PluginHttpRequest, res: PluginHttpResponse) => void | Promise<void>;

/** Wraps a handler with a generic 500 response while retaining detailed errors
 * only in the server log. */
function wrap(fn: H): H {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      getLogger().error(error, 'Unhandled API request error');
      if (error instanceof ConfigValidationError) {
        res.status(400).json({ code: -1, message: error.message });
        return;
      }
      res.status(500).json({ code: -1, message: 'Internal server error' });
    }
  };
}

/** Extracts the Bearer token from the Authorization header (case-insensitive). */
function extractBearer(req: PluginHttpRequest): string | undefined {
  const raw = req.headers['authorization'] ?? req.headers['Authorization'];
  const hdr = Array.isArray(raw) ? raw[0] : raw;
  return hdr?.startsWith('Bearer ') ? hdr.slice(7) : undefined;
}

/** Wraps fn with Bearer-token auth + RBAC (and wrap()'s exception guard). */
const authenticatedOperators = new WeakMap<PluginHttpRequest, number>();

function requireAuth(minRole: AuthRole, fn: H): H {
  return wrap(async (req, res) => {
    const token = extractBearer(req);
    if (!token) { res.status(401).json({ code: -1, message: 'Unauthorized' }); return; }
    const authenticated = authenticateAccessToken(token);
    if (!authenticated) { res.status(401).json({ code: -1, message: 'Invalid, expired, or revoked token' }); return; }
    if (!hasRole(authenticated.role, minRole)) { res.status(403).json({ code: -1, message: 'Forbidden' }); return; }
    authenticatedOperators.set(req, authenticated.user.id);
    try {
      await fn(req, res);
    } finally {
      authenticatedOperators.delete(req);
    }
  });
}

// NapCat response convention: code:0 = success, code:-1 = error
const ok  = (res: PluginHttpResponse, data: unknown = {}) => res.json({ code: 0, data });
const bad = (res: PluginHttpResponse, status: number, message: string) =>
  res.status(status).json({ code: -1, message });

function respondToUserMutationError(res: PluginHttpResponse, error: unknown): boolean {
  if (!(error instanceof UserAdminMutationError)) return false;
  const status = error.code === 'user_not_found'
    ? 404
    : error.code === 'self_delete' ? 400 : 409;
  bad(res, status, error.message);
  return true;
}

/** Parses a query parameter into a bounded non-negative integer. Garbage,
 *  negatives, and NaN fall back to the default — SQLite throws 'datatype
 *  mismatch' on NaN and treats a negative LIMIT as unlimited. */
function intParam(value: string | string[] | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(Array.isArray(value) ? value[0] ?? '' : value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/** Parses internal SQLite row identifiers; these remain safe JS integers. */
function positiveRowId(value: unknown): number | null {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function pagination(req: PluginHttpRequest): { limit: number; offset: number } {
  return {
    limit:  intParam(req.query['limit'], 50, 200),
    offset: intParam(req.query['offset'], 0, Number.MAX_SAFE_INTEGER),
  };
}

/** Login throttling is durable in SQLite; restarts cannot reset an active window. */
/**
 * Extract a representative client IP from the request.
 *
 * Priority:
 * 1. x-real-ip   — a single canonical IP written by nginx/traefik. Only
 *                  meaningful when a trusted reverse proxy sets it; a direct
 *                  client can forge it, which is why checkIpRateLimit is
 *                  backed by the global bucket above.
 * 2. x-forwarded-for (rightmost) — appended by the nearest trusted proxy;
 *                  safer than the leftmost (client-supplied) entry.
 * 3. 127.0.0.1   — fallback for direct connections. NapCat's PluginHttpRequest
 *                  does not expose req.socket.remoteAddress, so all direct
 *                  (non-proxied) connections share one rate-limit bucket.
 */
function getClientIp(req: PluginHttpRequest): string {
  const realIp = req.headers['x-real-ip'] ?? req.headers['X-Real-IP'];
  if (realIp) {
    const ip = (Array.isArray(realIp) ? realIp[0] : realIp)?.trim();
    if (ip) return ip;
  }
  const fwd = req.headers['x-forwarded-for'] ?? req.headers['X-Forwarded-For'];
  if (fwd) {
    const header = Array.isArray(fwd) ? fwd.join(',') : fwd;
    const ips = header.split(',').map((s) => s.trim()).filter(Boolean);
    const ip = ips[ips.length - 1];
    if (ip) return ip;
  }
  return '127.0.0.1';
}

function checkIpRateLimit(ip: string): boolean {
  const cfg = configManager.get().auth;
  const now = Date.now();

  const global = loginRateLimitRepo.consume(
    'global',
    '*',
    cfg.rateLimitRequests * 5,
    cfg.rateLimitWindowMs,
    now,
  );
  if (!global.allowed) return false;

  return loginRateLimitRepo.consume(
    'ip',
    ip,
    cfg.rateLimitRequests,
    cfg.rateLimitWindowMs,
    now,
  ).allowed;
}

/** Extracts the authenticated user's numeric ID from a Bearer token.
 *  Only call inside a requireAuth() handler — the token is guaranteed valid there. */
function operatorId(req: PluginHttpRequest): number {
  const id = authenticatedOperators.get(req);
  if (id === undefined) throw new Error('Authenticated operator context is unavailable');
  return id;
}

/** Clones the live config with every secret masked. Used by GET /config;
 *  POST /config strips masked values back out so a redacted round-trip can
 *  never clobber a stored secret. */
const REDACTED = '[redacted]';
function redactSecrets(raw: PluginConfig) {
  return {
    ...raw,
    webui: { ...raw.webui, jwtSecret: REDACTED },
    ai:    { ...raw.ai, apiKey: raw.ai.apiKey ? REDACTED : "" },
  };
}

const APPROVAL_ACTIONS = new Set(['auto_approve', 'auto_reject', 'manual', 'captcha']);
const USER_ROLES = new Set<string>(['super_admin', 'group_admin', 'auditor', 'viewer', 'member']);
const RISK_ACTIONS = new Set(['mute', 'kick', 'notify_admin', 'log_only', 'off']);
/** QQ caps set_group_ban at 30 days. */
const MAX_MUTE_SECONDS = 30 * 86_400;

/**
 * Return the authenticated, payload-free provider health view. Metric names
 * are stable gauges/counters for dashboards; provider details carry the
 * low-cardinality labels and correlation ID needed to investigate a failure.
 */
type ProviderTelemetryView = Omit<ProviderTelemetrySnapshot, 'provider'> & { provider: string };

export function buildProviderTelemetryPayload(provider: ProviderTelemetrySnapshot | null): {
  provider: ProviderTelemetryView;
  providers: ProviderTelemetryView[];
  metrics: Record<string, number | null>;
  correlation_id: string | null;
} {
  const providerView: ProviderTelemetryView = provider ?? {
    provider: 'unknown',
    transport: 'unknown',
    state: 'unknown',
    stateChangedAt: 0,
    connectedAt: null,
    reconnectAttempts: 0,
    connectionAgeMs: null,
    stateAgeMs: 0,
    lastSuccessAt: null,
    lastEventAt: null,
    lastHeartbeatAt: null,
    lastCorrelationId: null,
    lastErrorAt: null,
    lastErrorCategory: null,
    errorsTotal: 0,
    actions: { total: 0, succeeded: 0, failed: 0, inFlight: 0 },
    events: { total: 0, dropped: 0 },
  };
  return {
    provider: providerView,
    providers: [providerView],
    metrics: {
      provider_transport_connections: providerView.state === 'connected' ? 1 : 0,
      provider_transport_errors_total: providerView.errorsTotal,
      provider_last_heartbeat_time: providerView.lastHeartbeatAt,
    },
    correlation_id: providerView.lastCorrelationId,
  };
}

function providerTelemetryPayload() {
  let provider: ReturnType<typeof getProviderTelemetry> | null = null;
  try { provider = getProviderTelemetry(); } catch { /* host is still starting */ }
  return buildProviderTelemetryPayload(provider);
}

function metricsPayload() {
  return { ...getLastHealthStatus(), ...providerTelemetryPayload() };
}

function verboseHealthPayload() {
  const health = getLastHealthStatus();
  const telemetry = providerTelemetryPayload();
  return {
    healthy: health.healthy,
    status: health.status,
    timestamp: health.timestamp,
    components: health.components,
    providers: telemetry.providers,
    metrics: telemetry.metrics,
    correlation_id: telemetry.correlation_id,
  };
}


/** Group list merged with per-group settings — shared by /groups and /groups/refresh. */
function mergedGroupList(list: OneBotGroup[]) {
  const cfg = configManager.get();
  return list.map(g => ({
    group_id: g.group_id,
    group_name: g.group_name,
    member_count: g.member_count,
    max_member_count: g.max_member_count,
    ...resolveGroupConfig(cfg, g.group_id),
  }));
}

export function registerRoutes(): void {
  const ctx = getCtx();
  const r   = ctx.router;

  // ── Auth (no token required — these endpoints issue/revoke tokens) ──────────
  r.postNoAuth('/auth/login', wrap(async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const ip = getClientIp(req);
    if (!checkIpRateLimit(ip)) {
      res.status(429).json({ code: -1, message: 'Too many login attempts. Please try again later.' });
      return;
    }
    const result = await login(
      String(b['username'] ?? ''),
      String(b['password'] ?? ''),
      ip,
      (() => { const ua = req.headers['user-agent'] ?? req.headers['User-Agent']; return Array.isArray(ua) ? ua[0] : ua; })(),
    );
    if (!result.ok) return bad(res, 401, result.error ?? 'Login failed');
    ok(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
  }));

  r.postNoAuth('/auth/refresh', wrap(async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const oldRefreshToken = String(b['refreshToken'] ?? '');
    const tokens = refreshTokens(oldRefreshToken);
    if (!tokens) return bad(res, 401, 'Invalid, expired, or revoked refresh token');
    ok(res, tokens);
  }));

  r.postNoAuth('/auth/logout', wrap(async (req, res) => {
    const token = extractBearer(req);
    if (token) logoutUser(token);
    // Also blacklist the refresh token if the client sends it, preventing
    // post-logout reuse even if the token was captured by an attacker.
    const refreshToken = String((req.body as Record<string, unknown>)['refreshToken'] ?? '');
    if (refreshToken) logoutUser(refreshToken);
    ok(res);
  }));

  r.getNoAuth('/auth/me', requireAuth('viewer', (req, res) => {
    const user = userRepo.findById(operatorId(req));
    ok(res, { id: user?.id, username: user?.username, role: user?.role });
  }));

  // ── Stats / health ───────────────────────────────────────── (viewer) ───────
  r.getNoAuth('/stats',   requireAuth('viewer', (_req, res) => ok(res, getOverviewStats())));
  r.getNoAuth('/metrics', requireAuth('viewer', (_req, res) => ok(res, metricsPayload())));
  r.getNoAuth('/health/verbose', requireAuth('viewer', (_req, res) => ok(res, verboseHealthPayload())));

  // ── Bot account + groups ─────────────────────────────────── (viewer) ───────
  r.getNoAuth('/bot/info', requireAuth('viewer', async (_req, res) => {
    const cached = getCachedBotInfo();
    if (cached) { ok(res, cached); return; }
    const info = normalizeBotInfoResponse(await callAction('get_login_info', {}));
    if (!info) throw new Error('get_login_info returned an unexpected shape');
    ok(res, info);
  }));

  r.getNoAuth('/groups', requireAuth('viewer', async (_req, res) => {
    const list = getCachedGroupList() ?? normalizeGroupListResponse(await callAction('get_group_list', {}));
    if (!list) throw new Error('get_group_list returned an unexpected shape');
    ok(res, mergedGroupList(list));
  }));

  // Re-runs the full sequenced bootstrap. ─────────────────── (group_admin) ───
  r.postNoAuth('/groups/refresh', requireAuth('group_admin', async (_req, res) => {
    await bootstrapGroups();
    ok(res, mergedGroupList(getCachedGroupList() ?? []));
  }));

  r.postNoAuth('/groups/:groupId', requireAuth('group_admin', async (req, res) => {
    // A non-numeric key would pollute config.json forever: nothing ever
    // deletes group entries, and the curfew scheduler skips them silently.
    const groupId = normalizeOneBotId(req.params['groupId']);
    if (!groupId) return bad(res, 400, 'groupId must be a positive integer');
    const gid = groupId;
    const b = req.body as Record<string, unknown>;
    const cfg = configManager.get();
    const existing = resolveGroupConfig(cfg, groupId);
    const bool = (key: string, fallback: boolean): boolean => {
      const v = b[key];
      if (v === undefined || v === null) return fallback;
      // Never use Boolean(untrusted): Boolean("false") is true. Invalid
      // representations preserve the existing value instead of flipping it.
      return parseBoolean(v) ?? fallback;
    };
    const strArr = (key: string, fallback: string[], maxItemLength = 1024): string[] | null => {
      const value = b[key];
      if (value === undefined) return fallback;
      if (!Array.isArray(value) || value.length > 100) return null;
      if (value.some((entry) => typeof entry !== 'string' || entry.length > maxItemLength)) return null;
      return [...value] as string[];
    };

    // An unknown approval action would silently degrade to 'manual' in the
    // approval switch while the WebUI select shows nothing — reject instead.
    if (b['action'] !== undefined && !APPROVAL_ACTIONS.has(String(b['action']))) {
      return bad(res, 400, 'action must be one of auto_approve|auto_reject|manual|captcha');
    }

    // Curfew times must be strict 24h "HH:MM" — reject early with a 400 rather
    // than persisting a value the scheduler would silently ignore every tick.
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const key of ['curfewStart', 'curfewEnd'] as const) {
      const v = b[key];
      if (v !== undefined && (typeof v !== 'string' || !HHMM.test(v))) {
        return bad(res, 400, `${key} must be a 24h "HH:MM" string`);
      }
    }
    if (b['welcomeTemplate'] !== undefined
        && (typeof b['welcomeTemplate'] !== 'string' || b['welcomeTemplate'].length > 500)) {
      return bad(res, 400, 'welcomeTemplate must be a string of at most 500 characters');
    }
    const approveKeywords = strArr('approveKeywords', existing.approveKeywords);
    const rejectKeywords = strArr('rejectKeywords', existing.rejectKeywords);
    const approvePatterns = strArr('approvePatterns', existing.approvePatterns, 512);
    const rejectPatterns = strArr('rejectPatterns', existing.rejectPatterns, 512);
    if (!approveKeywords || !rejectKeywords || !approvePatterns || !rejectPatterns) {
      return bad(res, 400, 'Keyword/pattern lists must contain at most 100 bounded strings');
    }
    try {
      for (const pattern of [...approvePatterns, ...rejectPatterns]) await validateRegexPattern(pattern);
    } catch (error) {
      return bad(res, 400, error instanceof Error ? error.message : 'Invalid approval pattern');
    }
    {
      // A zero-length window is always a misconfiguration: a user typing
      // 00:00–00:00 plausibly means "always muted", which curfew refuses to
      // be. Only enforce when the caller is actually CHANGING the window —
      // pre-1.2.0 configs could legitimately store equal times (the scheduler
      // treats them as "no curfew"), and the WebUI modal always resends both
      // fields, so rejecting an unchanged pair would block unrelated edits.
      const effStart = typeof b['curfewStart'] === 'string' ? b['curfewStart'] : existing.curfewStart;
      const effEnd   = typeof b['curfewEnd']   === 'string' ? b['curfewEnd']   : existing.curfewEnd;
      const changingWindow = effStart !== existing.curfewStart || effEnd !== existing.curfewEnd;
      if (changingWindow && effStart === effEnd) {
        return bad(res, 400, 'curfew window cannot be zero-length (start must differ from end)');
      }
    }

    configManager.update({
      approval: {
        groups: {
          [gid]: {
            enabled:             bool('enabled', existing.enabled),
            action:              b['action'] !== undefined ? (b['action'] as typeof existing.action) : existing.action,
            approveKeywords,
            rejectKeywords,
            approvePatterns,
            rejectPatterns,
            rejectReason:        typeof b['rejectReason'] === 'string' ? b['rejectReason'] : existing.rejectReason,
            riskEnabled:         bool('riskEnabled', existing.riskEnabled),
            autoKickBlacklisted: bool('autoKickBlacklisted', existing.autoKickBlacklisted),
            notifyOnRisk:        bool('notifyOnRisk', existing.notifyOnRisk),
            notifyOnJoin:        bool('notifyOnJoin', existing.notifyOnJoin),
            groupName:           existing.groupName,
            welcomeEnabled:      bool('welcomeEnabled', existing.welcomeEnabled),
            welcomeTemplate:     typeof b['welcomeTemplate'] === 'string' ? b['welcomeTemplate'] : existing.welcomeTemplate,
            curfewEnabled:       bool('curfewEnabled', existing.curfewEnabled),
            curfewStart:         typeof b['curfewStart'] === 'string' ? b['curfewStart'] : existing.curfewStart,
            curfewEnd:           typeof b['curfewEnd'] === 'string' ? b['curfewEnd'] : existing.curfewEnd,
          },
        },
      },
    });
    ok(res);
  }));

  // ── Approvals ────────────────────────────────────────────── (viewer / group_admin)
  r.getNoAuth('/approvals', requireAuth('viewer', (req, res) => {
    const { limit, offset } = pagination(req);
    ok(res, approvalRepo.findAllPending(limit, offset));
  }));

  r.postNoAuth('/approvals/:id/approve', requireAuth('group_admin', async (req, res) => {
    // Use the authenticated user's ID from the JWT, not a caller-supplied value,
    // to prevent any group_admin from forging another admin's identity in audit logs.
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    await approvalService.approveManually(id, String(operatorId(req)));
    ok(res);
  }));

  r.postNoAuth('/approvals/:id/reject', requireAuth('group_admin', async (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    const b = req.body as Record<string, unknown>;
    await approvalService.rejectManually(
      id, String(operatorId(req)),
      String(b['reason'] ?? '已被管理员拒绝')
    );
    ok(res);
  }));

  // ── Blacklist ────────────────────────────────────────────── (viewer / group_admin)
  r.getNoAuth('/blacklist', requireAuth('viewer', (req, res) => {
    const { limit, offset } = pagination(req);
    ok(res, blacklistRepo.findAll(limit, offset));
  }));

  r.postNoAuth('/blacklist', requireAuth('group_admin', (req, res) => {
    const b = req.body as Record<string, unknown>;
    const userId = normalizeOneBotId(b['userId']);
    const groupId = b['groupId'] === undefined || b['groupId'] === null || b['groupId'] === ''
      ? null
      : normalizeOneBotId(b['groupId']);
    const reason = b['reason'];
    if (!userId) return bad(res, 400, 'userId must be a positive integer');
    if (groupId === null && b['groupId'] !== undefined && b['groupId'] !== null && b['groupId'] !== '') {
      return bad(res, 400, 'groupId must be a positive integer when provided');
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 512)) {
      return bad(res, 400, 'reason must be a string of at most 512 characters');
    }
    ok(res, blacklistRepo.add({
      userId,
      groupId,
      reason: typeof reason === 'string' ? reason : '',
      // JWT identity, never a caller-supplied value — same accountability rule
      // as approvals and punishments.
      createdBy: String(operatorId(req)),
    }));
  }));

  r.deleteNoAuth('/blacklist/:userId', requireAuth('group_admin', (req, res) => {
    const userId = normalizeOneBotId(req.params['userId']);
    const queryGroupId = req.query['groupId'];
    const groupIdValue = Array.isArray(queryGroupId) ? queryGroupId[0] : queryGroupId;
    const gid = groupIdValue === undefined ? null : normalizeOneBotId(groupIdValue);
    if (!userId || (groupIdValue !== undefined && !gid)) return bad(res, 400, 'userId and groupId must be positive integers');
    blacklistRepo.remove(userId, gid);
    ok(res);
  }));

  // ── Punishments ──────────────────────────────────────────── (viewer / group_admin)
  r.getNoAuth('/punishments', requireAuth('viewer', (req, res) => {
    const { limit, offset } = pagination(req);
    ok(res, punishmentRepo.findAll(limit, offset));
  }));

  r.postNoAuth('/punishments/mute', requireAuth('group_admin', async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const groupId = normalizeOneBotId(b['groupId']);
    const userId = normalizeOneBotId(b['userId']);
    const reason = b['reason'];
    if (!groupId || !userId) return bad(res, 400, 'groupId and userId must be positive integers');
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 512)) {
      return bad(res, 400, 'reason must be a string of at most 512 characters');
    }
    // A cleared WebUI duration field arrives as '' → Number('') === 0, and
    // set_group_ban with duration 0 means UNMUTE — validate, don't coerce.
    const duration = b['durationSeconds'] === undefined || b['durationSeconds'] === ''
      ? 600
      : Number(b['durationSeconds']);
    if (!Number.isInteger(duration) || duration < 1 || duration > MAX_MUTE_SECONDS) {
      return bad(res, 400, `durationSeconds must be an integer between 1 and ${MAX_MUTE_SECONDS}`);
    }
    ok(res, await punishmentService.mute(
      groupId, userId,
      duration, typeof reason === 'string' ? reason : '',
      String(operatorId(req))
    ));
  }));

  r.postNoAuth('/punishments/kick', requireAuth('group_admin', async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const groupId = normalizeOneBotId(b['groupId']);
    const userId = normalizeOneBotId(b['userId']);
    const reason = b['reason'];
    if (!groupId || !userId) return bad(res, 400, 'groupId and userId must be positive integers');
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 512)) {
      return bad(res, 400, 'reason must be a string of at most 512 characters');
    }
    ok(res, await punishmentService.kick(
      groupId, userId,
      typeof reason === 'string' ? reason : '', String(operatorId(req))
    ));
  }));

  r.postNoAuth('/punishments/:id/revoke', requireAuth('group_admin', async (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    await punishmentService.revoke(id, String(operatorId(req)));
    ok(res);
  }));

  // ── Risk rules ───────────────────────────────────────────── (viewer / super_admin)
  r.getNoAuth('/risk/rules', requireAuth('viewer', (_req, res) =>
    ok(res, getDatabase().prepare('SELECT * FROM risk_rules ORDER BY created_at DESC').all())
  ));

  r.postNoAuth('/risk/rules', requireAuth('super_admin', async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const action = String(b['action'] ?? 'mute');
    const name = b['name'];
    const pattern = b['pattern'];
    if (!RISK_ACTIONS.has(action)) {
      return bad(res, 400, 'action must be one of mute|kick|notify_admin|log_only|off');
    }
    if (typeof name !== 'string' || name.length < 1 || name.length > 128) {
      return bad(res, 400, 'name must be a string of 1-128 characters');
    }
    if (typeof pattern !== 'string' || pattern.length < 1 || pattern.length > 512) {
      return bad(res, 400, 'pattern must be a string of 1-512 characters');
    }
    try {
      ok(res, await riskService.addRule({
        name,
        pattern,
        action: action as Parameters<typeof riskService.addRule>[0]['action'],
      }));
    } catch (error) {
      return bad(res, 400, error instanceof Error ? error.message : 'Invalid risk rule');
    }
  }));

  r.postNoAuth('/risk/rules/:id/toggle', requireAuth('super_admin', (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    const b = req.body as Record<string, unknown>;
    const enabled = parseBoolean(b['enabled']);
    if (enabled === undefined) return bad(res, 400, 'enabled must be a boolean');
    riskService.toggleRule(id, enabled);
    ok(res);
  }));

  r.deleteNoAuth('/risk/rules/:id', requireAuth('super_admin', (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    getDatabase().prepare('DELETE FROM risk_rules WHERE id = ?').run(id);
    riskService.reloadRules();
    ok(res);
  }));

  // ── Audit logs ───────────────────────────────────────────── (auditor) ───────
  r.getNoAuth('/audit', requireAuth('auditor', (req, res) => {
    const { limit, offset } = pagination(req);
    ok(res, auditRepo.findAll({ limit, offset }));
  }));

  // ── Config ───────────────────────────────────────────────── (viewer / super_admin)
  r.getNoAuth('/config', requireAuth('viewer', (_req, res) => {
    ok(res, redactSecrets(configManager.get()));
  }));

  r.postNoAuth('/config', requireAuth('super_admin', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return bad(res, 400, 'Configuration update body must be an object');
    }
    const body = req.body as Record<string, unknown>;
    // Only these top-level sections may be updated at runtime.
    // 'webui' is intentionally absent — the jwtSecret must be changed via the
    // server-side config file, not the REST API.
    const ALLOWED = new Set(['core', 'approval', 'captcha', 'risk', 'punishment', 'blacklist', 'auth', 'monitor', 'update', 'ai', 'commands', 'intel']);
    const unknown = Object.keys(body).filter((k) => !ALLOWED.has(k));
    if (unknown.length > 0) {
      return bad(res, 400, `Unknown or non-updatable config section(s): ${unknown.join(', ')}`);
    }
    // A GET /config → POST /config round trip carries the '[redacted]' mask —
    // strip it so it can never overwrite the stored secret.
    const update = { ...body };
    const ai = body['ai'];
    if (ai && typeof ai === 'object' && !Array.isArray(ai)) {
      const safeAi = { ...(ai as Record<string, unknown>) };
      if (safeAi['apiKey'] === REDACTED) delete safeAi['apiKey'];
      update['ai'] = safeAi;
    }
    // Build and worker-validate the full merged candidate before any on-disk
    // change. This closes the generic config route as a bypass around the
    // dedicated group endpoint's async regex guard.
    await configManager.updateValidated(
      update as Parameters<typeof configManager.update>[0],
      validatePersistedApprovalPatterns,
    );
    ok(res);
  }));

  // ── Cloud intel ──────────────────────────────────────────── (viewer / group_admin)
  r.getNoAuth('/intel/status', requireAuth('viewer', (_req, res) => {
    ok(res, intelService.getStatus());
  }));

  r.postNoAuth('/intel/refresh', requireAuth('group_admin', async (_req, res) => {
    await intelService.refresh(true);
    ok(res, intelService.getStatus());
  }));

  // On-demand admission sweep — same pipeline as the scheduled poll.
  r.postNoAuth('/approvals/sync', requireAuth('group_admin', async (_req, res) => {
    ok(res, { processed: await syncPendingJoinRequests() });
  }));

  // ── Update ───────────────────────────────────────────────── (viewer / super_admin)
  r.getNoAuth('/update/check', requireAuth('viewer', async (_req, res) =>
    ok(res, { current: getCurrentVersion(), latest: await checkForUpdate() })
  ));

  r.getNoAuth('/update/releases', requireAuth('viewer', async (_req, res) => {
    const releases = await fetchReleases();
    ok(res, {
      current: getCurrentVersion(),
      githubRepo: configManager.get().update.githubRepo,
      releases,
    });
  }));

  // Route is intentionally named "download" not "apply": the endpoint streams
  // the release zip to disk. The operator must then extract it and restart
  // NapCat. There is no in-process hot-swap.
  r.postNoAuth('/update/download', requireAuth('super_admin', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return bad(res, 400, 'Update download body must be an object');
    }
    const body = req.body as Record<string, unknown>;
    const version = body['version'];
    const downloadUrl = body['downloadUrl'];
    const checksumUrl = body['checksumUrl'];
    const normalizedVersion = normalizeReleaseVersion(version);
    if (
      !normalizedVersion
      || typeof downloadUrl !== 'string' || downloadUrl.length > 2048
      || typeof checksumUrl !== 'string' || checksumUrl.length > 2048
    ) {
      return bad(res, 400, 'version must be SemVer; downloadUrl and checksumUrl are required strings');
    }
    await downloadUpdate({
      version: normalizedVersion,
      downloadUrl,
      checksumUrl,
      publishedAt: '',
      releaseUrl: '',
      releaseNotes: '',
    });
    ok(res);
  }));

  // ── Users ─────────────────────────────────────────────────── (super_admin only)
  // Strip sensitive fields before sending any user record to the client.
  function sanitizeUser(user: NonNullable<ReturnType<typeof userRepo.findById>>) {
    const { password_hash: _, ...sanitized } = user;
    return { ...sanitized, is_usable_super_admin: isUsableSuperAdmin(user) };
  }

  r.getNoAuth('/users', requireAuth('super_admin', (_req, res) => {
    ok(res, userRepo.findAll().map(u => sanitizeUser(u)));
  }));

  r.getNoAuth('/users/:id', requireAuth('super_admin', (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    const user = userRepo.findById(id);
    if (!user) { bad(res, 404, 'User not found'); return; }
    ok(res, sanitizeUser(user));
  }));

  r.postNoAuth('/users', requireAuth('super_admin', async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const username = String(b['username'] ?? '').trim();
    const password = String(b['password'] ?? '');
    const role     = String(b['role'] ?? 'viewer');
    if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username) || !password) {
      bad(res, 400, 'username and password are required');
      return;
    }
    if (!USER_ROLES.has(role)) { bad(res, 400, 'invalid role'); return; }
    const passwordError = validatePasswordForCreation(password);
    if (passwordError) { bad(res, 400, passwordError); return; }
    if (userRepo.findByUsername(username)) { bad(res, 409, 'username already exists'); return; }
    const qqId = b['qqId'];
    const normalizedQqId = qqId === undefined ? undefined : normalizeOneBotId(qqId);
    if (qqId !== undefined && normalizedQqId === null) {
      bad(res, 400, 'qqId must be an unsigned 64-bit decimal identifier');
      return;
    }
    const passwordHash = await hashPassword(password);
    const created = userRepo.createByAdministrator({
      username,
      passwordHash,
      role: role as DbUser['role'],
      qqId: normalizedQqId ?? undefined,
    }, operatorId(req));
    ok(res, sanitizeUser(created));
  }));

  r.putNoAuth('/users/:id', requireAuth('super_admin', async (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    const b = req.body as Record<string, unknown>;
    const update: UserAdministrativeUpdate = {};
    if (b['role'] !== undefined) {
      if (!USER_ROLES.has(String(b['role']))) { bad(res, 400, 'invalid role'); return; }
      update.role = b['role'] as DbUser['role'];
    }
    if (b['password'] !== undefined) {
      const password = String(b['password']);
      const passwordError = validatePasswordForCreation(password);
      if (passwordError) { bad(res, 400, passwordError); return; }
      update.passwordHash = await hashPassword(password);
    }
    try {
      const user = Object.keys(update).length
        ? userRepo.updateByAdministrator(id, update, operatorId(req))
        : userRepo.findById(id);
      if (!user) return bad(res, 404, 'User not found');
      ok(res, sanitizeUser(user));
    } catch (error) {
      if (respondToUserMutationError(res, error)) return;
      throw error;
    }
  }));

  r.deleteNoAuth('/users/:id', requireAuth('super_admin', (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    try {
      userRepo.deleteByAdministrator(id, operatorId(req));
      ok(res);
    } catch (error) {
      if (respondToUserMutationError(res, error)) return;
      throw error;
    }
  }));

  r.postNoAuth('/users/:id/unlock', requireAuth('super_admin', (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    try {
      userRepo.updateByAdministrator(
        id,
        { loginAttempts: 0, lockedUntil: null },
        operatorId(req),
      );
      ok(res);
    } catch (error) {
      if (respondToUserMutationError(res, error)) return;
      throw error;
    }
  }));

  r.postNoAuth('/users/:id/password', requireAuth('super_admin', async (req, res) => {
    const id = positiveRowId(req.params['id']);
    if (!id) return bad(res, 400, 'id must be a positive integer');
    const password = String((req.body as Record<string, unknown>)['password'] ?? '');
    if (!password) { bad(res, 400, 'password is required'); return; }
    const passwordError = validatePasswordForCreation(password);
    if (passwordError) { bad(res, 400, passwordError); return; }
    try {
      userRepo.updateByAdministrator(
        id,
        { passwordHash: await hashPassword(password) },
        operatorId(req),
      );
      ok(res);
    } catch (error) {
      if (respondToUserMutationError(res, error)) return;
      throw error;
    }
  }));
}
