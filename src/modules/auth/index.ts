import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configManager } from '../../core/config/index.ts';
import { hashPassword, signAccessToken, signRefreshToken, verifyAccessToken, verifyPassword, verifyToken } from '../../core/crypto/index.ts';
import { auditRepo } from '../../database/repositories/audit.ts';
import { authSessionRepo } from '../../database/repositories/session.ts';
import { isUsableSuperAdmin, userRepo } from '../../database/repositories/user.ts';
import { getRuntimeHost } from '../../runtime/host.ts';
import type { DbUser } from '../../database/models/index.ts';

const LEGACY_CREDENTIALS_FILENAME = 'credentials.txt';
const BOOTSTRAP_CREDENTIALS_FILENAME = 'bootstrap-credentials.json';
const BOOTSTRAP_SCHEMA_VERSION = 1;
const FORCE_BOOTSTRAP_RECOVERY_ENV = 'QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY';
const MIN_PASSWORD_LENGTH = 12;

export type AuthRole = DbUser['role'];

const ROLE_RANK: Record<AuthRole, number> = {
  super_admin: 5,
  group_admin: 4,
  auditor: 3,
  viewer: 2,
  member: 1,
};

export function hasRole(userRole: AuthRole, required: AuthRole): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[required];
}

export function validatePasswordForCreation(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 1_024) return 'Password is too long';

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
    return 'Password must contain uppercase, lowercase, digit, and special character';
  }

  return null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  accessToken?: string;
  refreshToken?: string;
}

function normalizeUsername(value: string): string | null {
  const username = value.trim();
  if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) return null;
  return username;
}

function issueTokens(user: DbUser): TokenPair {
  const accessId = randomUUID();
  const refreshId = randomUUID();
  const accessToken = signAccessToken({ sub: user.id, role: user.role, jti: accessId });
  const refreshToken = signRefreshToken({ sub: user.id, jti: refreshId });
  const accessPayload = verifyAccessToken(accessToken);
  const refreshPayload = verifyToken(refreshToken);
  if (!accessPayload?.exp || !refreshPayload?.exp) throw new Error('Could not issue session tokens');
  const now = Date.now();
  authSessionRepo.purgeExpired(now);
  authSessionRepo.create({ tokenId: accessId, userId: user.id, kind: 'access', issuedAt: now, expiresAt: accessPayload.exp * 1_000 });
  authSessionRepo.create({ tokenId: refreshId, userId: user.id, kind: 'refresh', issuedAt: now, expiresAt: refreshPayload.exp * 1_000 });
  return { accessToken, refreshToken };
}

function bootstrapPath(dataPath: string): string {
  return join(dataPath, BOOTSTRAP_CREDENTIALS_FILENAME);
}

function removeFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // This file is no longer consulted after an account exists, so retaining
    // it cannot affect runtime auth. Operators are warned through docs.
  }
}

function writePrivateBootstrap(path: string, username: string, password: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify({
      schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
      username,
      password,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* Windows/virtual filesystems may not expose POSIX modes. */ }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    removeFile(temporary);
    throw error;
  }
}

function readJsonBootstrap(path: string): { username: string; password: string } | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const username = typeof value['username'] === 'string' ? normalizeUsername(value['username']) : null;
    const password = typeof value['password'] === 'string' ? value['password'] : '';
    if (value['schemaVersion'] !== BOOTSTRAP_SCHEMA_VERSION || !username || !password) return null;
    return { username, password };
  } catch {
    return null;
  }
}

const BOOTSTRAP_CREDENTIALS_ERROR =
  'Both valid QQ_GUARDIAN_BOOTSTRAP_USERNAME and QQ_GUARDIAN_BOOTSTRAP_PASSWORD are required';

function configuredBootstrapCredentials(): { username: string; password: string } | null {
  // Compose interpolation commonly injects both variables as empty strings.
  // Treat that exact empty pair as unset so the secure local one-time path
  // remains usable; a non-empty partial pair is always a configuration error.
  const configuredUsername = process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME']?.trim() ?? '';
  const configuredPassword = process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'] ?? '';
  if (!configuredUsername && !configuredPassword) return null;

  const username = normalizeUsername(configuredUsername);
  if (!username || !configuredPassword || validatePasswordForCreation(configuredPassword)) {
    throw new Error(BOOTSTRAP_CREDENTIALS_ERROR);
  }
  return { username, password: configuredPassword };
}

function bootstrapCredentials(dataPath: string): { username: string; password: string; oneTimeFile: boolean } {
  const configured = configuredBootstrapCredentials();
  if (configured) return { ...configured, oneTimeFile: false };

  const oneTimePath = bootstrapPath(dataPath);
  if (existsSync(oneTimePath)) {
    const credentials = readJsonBootstrap(oneTimePath);
    if (!credentials) throw new Error('Bootstrap credential file is malformed; replace it with explicit bootstrap environment credentials');
    return { ...credentials, oneTimeFile: true };
  }

  const credentials = { username: 'admin', password: randomBytes(24).toString('base64url') };
  writePrivateBootstrap(oneTimePath, credentials.username, credentials.password);
  return { ...credentials, oneTimeFile: true };
}

function discardLegacyCredentialFile(dataPath: string): void {
  removeFile(join(dataPath, LEGACY_CREDENTIALS_FILENAME));
}

/**
 * Creates the first administrator without predictable credentials or secret
 * logging. Recovery is deliberately opt-in: a locked or otherwise unusable
 * super administrator is never silently replaced or reset during startup.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const { dataPath } = getRuntimeHost().paths;
  const recoverySetting = process.env[FORCE_BOOTSTRAP_RECOVERY_ENV]?.trim() ?? '';
  if (recoverySetting && recoverySetting !== '0' && recoverySetting !== '1') {
    throw new Error(`${FORCE_BOOTSTRAP_RECOVERY_ENV} must be 0, 1, or unset`);
  }
  const forceRecovery = recoverySetting === '1';
  const recoveryCredentials = forceRecovery ? configuredBootstrapCredentials() : null;
  if (forceRecovery && !recoveryCredentials) throw new Error(BOOTSTRAP_CREDENTIALS_ERROR);

  const users = userRepo.findAll();
  if (users.some((user) => isUsableSuperAdmin(user))) {
    // A generated one-time credential can outlive an interrupted first boot.
    // Keep it until a successful super-admin login consumes it; otherwise a
    // restart would strand the operator with no way to discover the random
    // first-admin password. The obsolete legacy plaintext file is never read.
    discardLegacyCredentialFile(dataPath);
    return;
  }

  if (users.length > 0 && !forceRecovery) {
    discardLegacyCredentialFile(dataPath);
    console.warn(
      '[qq-guardian] No currently usable super administrator exists. '
      + 'Startup recovery is disabled; wait for a temporary lock to expire or follow the documented break-glass recovery procedure.'
    );
    return;
  }

  const credentials = recoveryCredentials
    ? { ...recoveryCredentials, oneTimeFile: false }
    : bootstrapCredentials(dataPath);
  const passwordHash = await hashPassword(credentials.password);
  const recovered = forceRecovery
    ? userRepo.recoverSuperAdmin({ username: credentials.username, passwordHash })
    : userRepo.createBootstrapAdmin({
        username: credentials.username,
        passwordHash,
        role: 'super_admin',
      });

  // Another writer may have restored a usable administrator while hashing.
  // Preserve the one-time file because this process did not consume it.
  if (!recovered) {
    discardLegacyCredentialFile(dataPath);
    return;
  }

  // A legacy plaintext file is now redundant and is preserved only by the
  // immutable migration backup. Generated bootstrap credentials remain until
  // this account successfully logs in exactly once.
  removeFile(join(dataPath, LEGACY_CREDENTIALS_FILENAME));
  if (!credentials.oneTimeFile) removeFile(bootstrapPath(dataPath));
  console.info(
    forceRecovery
      ? '[qq-guardian] Break-glass super-administrator recovery completed and audited. Remove QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY before the next start; no secret was written to logs.'
      : '[qq-guardian] Bootstrap administrator created. Read the local one-time bootstrap credential file or use the configured environment credential; no secret was written to logs.'
  );
}

function consumeBootstrapAfterLogin(user: DbUser): void {
  if (user.role === 'super_admin') removeFile(bootstrapPath(getRuntimeHost().paths.dataPath));
}

export async function login(usernameInput: string, password: string, ip: string, userAgent?: string): Promise<LoginResult> {
  const username = normalizeUsername(usernameInput);
  const config = configManager.get().auth;
  const user = username ? userRepo.findByUsername(username) : null;
  if (!user?.password_hash) return { ok: false, error: 'Invalid credentials' };
  if (user.locked_until && Date.now() < user.locked_until) return { ok: false, error: 'Account temporarily locked' };

  if (!(await verifyPassword(user.password_hash, password))) {
    const outcome = userRepo.recordLoginFailure(user.id, config.maxLoginAttempts, Date.now() + config.lockoutSeconds * 1_000);
    auditRepo.logLogin({ userId: user.id, ip, userAgent, success: false });
    return { ok: false, error: outcome?.locked ? 'Account temporarily locked' : 'Invalid credentials' };
  }

  userRepo.resetLoginAttempts(user.id);
  auditRepo.logLogin({ userId: user.id, ip, userAgent, success: true });
  consumeBootstrapAfterLogin(user);
  return { ok: true, ...issueTokens(user) };
}

export function refreshTokens(refreshToken: string): TokenPair | null {
  const payload = verifyToken(refreshToken);
  if (!payload || payload.type !== 'refresh') return null;
  if (!authSessionRepo.findActive(payload.jti, payload.sub, 'refresh')) return null;
  const user = userRepo.findById(payload.sub);
  if (!user || (user.locked_until && Date.now() < user.locked_until)) return null;
  // Atomic compare-and-set semantics are provided by the revoked_at guard.
  if (!authSessionRepo.revoke(payload.jti)) return null;
  return issueTokens(user);
}

export function authenticateAccessToken(token: string): { user: DbUser; role: AuthRole } | null {
  const payload = verifyAccessToken(token);
  if (!payload || !authSessionRepo.findActive(payload.jti, payload.sub, 'access')) return null;
  const user = userRepo.findById(payload.sub);
  if (!user || (user.locked_until && Date.now() < user.locked_until) || user.role !== payload.role) return null;
  return { user, role: user.role };
}

export function logout(token: string): void {
  const payload = verifyToken(token);
  if (payload) authSessionRepo.revoke(payload.jti);
}

export function revokeUserSessions(userId: number): void {
  authSessionRepo.revokeAllForUser(userId);
}
