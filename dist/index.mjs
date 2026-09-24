var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/types/onebot.ts
var DECIMAL = /^\d+$/;
var SIGNED_DECIMAL = /^-?\d+$/;
var UINT64_MAX = "18446744073709551615";
var INT64_MIN_ABSOLUTE = "9223372036854775808";
var MAX_RAW_DIGITS = 128;
function withinUnsigned64Bit(value) {
  return value.length < UINT64_MAX.length || value.length === UINT64_MAX.length && value <= UINT64_MAX;
}
function normalizeOneBotId(value, options = {}) {
  let digits;
  if (typeof value === "string") {
    if (value.length === 0 || value.length > MAX_RAW_DIGITS || !DECIMAL.test(value)) return null;
    digits = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return null;
    digits = String(value);
  } else if (typeof value === "bigint") {
    if (value < 0n) return null;
    digits = value.toString(10);
  } else {
    return null;
  }
  const canonical = digits.replace(/^0+(?=\d)/, "");
  if (canonical === "0" && !options.allowZero) return null;
  return withinUnsigned64Bit(canonical) ? canonical : null;
}
function normalizeOneBotMessageId(value) {
  let raw;
  if (typeof value === "string") {
    if (value.length === 0 || value.length > MAX_RAW_DIGITS || !SIGNED_DECIMAL.test(value)) return null;
    raw = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return null;
    raw = String(value);
  } else if (typeof value === "bigint") {
    raw = value.toString(10);
  } else {
    return null;
  }
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");
  if (digits === "0") return null;
  if (!negative) return withinUnsigned64Bit(digits) ? digits : null;
  if (digits.length > INT64_MIN_ABSOLUTE.length || digits.length === INT64_MIN_ABSOLUTE.length && digits > INT64_MIN_ABSOLUTE) return null;
  return `-${digits}`;
}
function normalizeOneBotFileId(value) {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? String(value) : null;
  }
  if (typeof value === "bigint") return value >= 0n ? value.toString(10) : null;
  return null;
}

// src/types/onebot-event.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function eventTime(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function optionalId(source, key) {
  if (source[key] === void 0 || source[key] === null || source[key] === "") return { valid: true };
  const value = normalizeOneBotId(source[key]);
  return value === null ? { valid: false } : { valid: true, value };
}
var SEGMENT_ID_KEYS = [
  "self_id",
  "user_id",
  "group_id",
  "target_id",
  "operator_id"
];
function normalizeSegment(value) {
  const segment = record(value);
  if (!segment || typeof segment["type"] !== "string") return null;
  const sourceData = record(segment["data"]);
  if (!sourceData) return null;
  const data = { ...sourceData };
  for (const key of SEGMENT_ID_KEYS) {
    if (data[key] === void 0 || data[key] === null || data[key] === "") continue;
    const id = normalizeOneBotId(data[key]);
    if (id === null) return null;
    data[key] = id;
  }
  if (data["message_id"] !== void 0 && data["message_id"] !== null && data["message_id"] !== "") {
    const messageId = normalizeOneBotMessageId(data["message_id"]);
    if (messageId === null) return null;
    data["message_id"] = messageId;
  }
  if (segment["type"] === "at" && data["qq"] !== void 0 && data["qq"] !== "all") {
    const qq = normalizeOneBotId(data["qq"]);
    if (qq === null) return null;
    data["qq"] = qq;
  }
  if (segment["type"] === "reply" && data["id"] !== void 0) {
    const id = normalizeOneBotMessageId(data["id"]);
    if (id === null) return null;
    data["id"] = id;
  }
  if (data["file_id"] !== void 0) {
    const fileId = normalizeOneBotFileId(data["file_id"]);
    if (fileId === null) return null;
    data["file_id"] = fileId;
  }
  return { type: segment["type"], data };
}
function normalizeOB11Message(value) {
  const event = record(value);
  if (!event || event["post_type"] !== "message" && event["post_type"] !== "message_sent") return null;
  if (event["message_type"] !== "private" && event["message_type"] !== "group") return null;
  const time = eventTime(event["time"]);
  const selfId = normalizeOneBotId(event["self_id"]);
  const messageId = normalizeOneBotMessageId(event["message_id"]);
  const userId = normalizeOneBotId(event["user_id"]);
  const group = optionalId(event, "group_id");
  const sender = record(event["sender"]);
  const senderId = normalizeOneBotId(sender?.["user_id"]);
  if (time === null || selfId === null || messageId === null || userId === null || !group.valid || !sender || senderId === null || typeof sender["nickname"] !== "string" || typeof event["raw_message"] !== "string" || !Array.isArray(event["message"]) && typeof event["message"] !== "string" || event["message_type"] === "group" && group.value === void 0) return null;
  const segments = Array.isArray(event["message"]) ? event["message"].map(normalizeSegment) : [];
  if (segments.some((segment) => segment === null)) return null;
  const role = sender["role"];
  if (role !== void 0 && role !== "owner" && role !== "admin" && role !== "member") return null;
  if (sender["card"] !== void 0 && typeof sender["card"] !== "string") return null;
  return {
    time,
    self_id: selfId,
    post_type: event["post_type"],
    message_type: event["message_type"],
    message_id: messageId,
    user_id: userId,
    ...group.value === void 0 ? {} : { group_id: group.value },
    message: segments,
    raw_message: event["raw_message"],
    sender: {
      user_id: senderId,
      nickname: sender["nickname"],
      ...sender["card"] === void 0 ? {} : { card: sender["card"] },
      ...role === void 0 ? {} : { role }
    }
  };
}
function normalizeRequestEvent(event) {
  if (event["request_type"] !== "group" && event["request_type"] !== "friend") return null;
  const time = eventTime(event["time"]);
  const selfId = normalizeOneBotId(event["self_id"]);
  const userId = normalizeOneBotId(event["user_id"]);
  const group = optionalId(event, "group_id");
  const comment = event["comment"] === void 0 || event["comment"] === null ? "" : typeof event["comment"] === "string" ? event["comment"] : null;
  if (time === null || selfId === null || userId === null || !group.valid || comment === null || typeof event["flag"] !== "string" || event["flag"].length === 0 || event["request_type"] === "group" && group.value === void 0 || event["sub_type"] !== void 0 && typeof event["sub_type"] !== "string") return null;
  return {
    time,
    self_id: selfId,
    post_type: "request",
    request_type: event["request_type"],
    ...event["sub_type"] === void 0 ? {} : { sub_type: event["sub_type"] },
    ...group.value === void 0 ? {} : { group_id: group.value },
    user_id: userId,
    comment,
    flag: event["flag"]
  };
}
function normalizeNoticeEvent(event) {
  const time = eventTime(event["time"]);
  const selfId = normalizeOneBotId(event["self_id"]);
  const group = optionalId(event, "group_id");
  const user = optionalId(event, "user_id");
  const operator = optionalId(event, "operator_id");
  if (time === null || selfId === null || !group.valid || !user.valid || !operator.valid || typeof event["notice_type"] !== "string" || event["sub_type"] !== void 0 && typeof event["sub_type"] !== "string") return null;
  return {
    time,
    self_id: selfId,
    post_type: "notice",
    notice_type: event["notice_type"],
    ...group.value === void 0 ? {} : { group_id: group.value },
    ...user.value === void 0 ? {} : { user_id: user.value },
    ...operator.value === void 0 ? {} : { operator_id: operator.value },
    ...event["sub_type"] === void 0 ? {} : { sub_type: event["sub_type"] }
  };
}
function normalizeOB11Event(value) {
  const event = record(value);
  if (!event) return null;
  if (event["post_type"] === "request") return normalizeRequestEvent(event);
  if (event["post_type"] === "notice") return normalizeNoticeEvent(event);
  return null;
}

// src/modules/captcha/index.ts
import { randomUUID as randomUUID2, timingSafeEqual, createHash as createHash2 } from "crypto";

// src/database/index.ts
import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";

// src/database/migrations/001_initial.ts
var initial_exports = {};
__export(initial_exports, {
  description: () => description,
  up: () => up,
  version: () => version
});
var version = 1;
var description = "Initial schema";
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      qq_id          INTEGER UNIQUE,
      username       TEXT UNIQUE,
      password_hash  TEXT,
      role           TEXT NOT NULL DEFAULT 'member',
      totp_secret    TEXT,
      totp_enabled   INTEGER NOT NULL DEFAULT 0,
      login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until   INTEGER,
      last_login     INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id     INTEGER NOT NULL,
      user_id      INTEGER NOT NULL,
      flag         TEXT NOT NULL,
      comment      TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      reason       TEXT,
      operator_id  INTEGER,
      captcha_id   TEXT,
      created_at   INTEGER NOT NULL,
      processed_at INTEGER,
      expires_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_records(status);
    CREATE INDEX IF NOT EXISTS idx_approval_user   ON approval_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_approval_group  ON approval_records(group_id);

    CREATE TABLE IF NOT EXISTS captcha_sessions (
      id           TEXT PRIMARY KEY,
      group_id     INTEGER NOT NULL,
      user_id      INTEGER NOT NULL,
      approval_id  INTEGER NOT NULL,
      type         TEXT NOT NULL,
      challenge    TEXT NOT NULL,
      answer       TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      solved       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      group_id   INTEGER,
      reason     TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      UNIQUE(user_id, group_id)
    );

    CREATE INDEX IF NOT EXISTS idx_blacklist_user  ON blacklist(user_id);
    CREATE INDEX IF NOT EXISTS idx_blacklist_group ON blacklist(group_id);

    CREATE TABLE IF NOT EXISTS punishment_records (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id         INTEGER NOT NULL,
      user_id          INTEGER NOT NULL,
      type             TEXT NOT NULL,
      duration_seconds INTEGER,
      reason           TEXT NOT NULL DEFAULT '',
      operator_id      INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER,
      revoked_at       INTEGER,
      revoked_by       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_punishment_user  ON punishment_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_punishment_group ON punishment_records(group_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      actor_id    INTEGER,
      target_type TEXT,
      target_id   TEXT,
      details     TEXT NOT NULL DEFAULT '{}',
      ip          TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_logs(created_at);

    CREATE TABLE IF NOT EXISTS login_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      ip         TEXT NOT NULL,
      user_agent TEXT,
      success    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stat_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id            INTEGER,
      period              TEXT NOT NULL,
      approvals_total     INTEGER NOT NULL DEFAULT 0,
      approvals_passed    INTEGER NOT NULL DEFAULT 0,
      approvals_rejected  INTEGER NOT NULL DEFAULT 0,
      captchas_total      INTEGER NOT NULL DEFAULT 0,
      captchas_passed     INTEGER NOT NULL DEFAULT 0,
      punishments_total   INTEGER NOT NULL DEFAULT 0,
      risk_detections     INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      UNIQUE(group_id, period)
    );

    CREATE TABLE IF NOT EXISTS risk_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL,
      pattern    TEXT NOT NULL,
      weight     REAL NOT NULL DEFAULT 1.0,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

// src/database/migrations/002_captcha_index.ts
var captcha_index_exports = {};
__export(captcha_index_exports, {
  description: () => description2,
  up: () => up2,
  version: () => version2
});
var version2 = 2;
var description2 = "Add index on captcha_sessions(user_id, solved)";
function up2(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_captcha_user
    ON captcha_sessions(user_id, solved);
  `);
}

// src/database/migrations/003_risk_rule_action.ts
var risk_rule_action_exports = {};
__export(risk_rule_action_exports, {
  description: () => description3,
  up: () => up3,
  version: () => version3
});
var version3 = 3;
var description3 = "Add per-rule action column to risk_rules";
function up3(db) {
  const columns = db.prepare("PRAGMA table_info(risk_rules)").all();
  if (!columns.some((column) => column.name === "action")) {
    db.exec(`ALTER TABLE risk_rules ADD COLUMN action TEXT NOT NULL DEFAULT 'mute';`);
  }
}

// src/database/migrations/004_canonical_storage.ts
var canonical_storage_exports = {};
__export(canonical_storage_exports, {
  description: () => description4,
  up: () => up4,
  version: () => version4
});
var version4 = 4;
var description4 = "Replace retired score/TOTP storage and add durable auth sessions";
function up4(db) {
  const dependentObjects = db.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_master
    WHERE tbl_name IN ('users', 'risk_rules')
      AND ((type = 'trigger') OR (type = 'index' AND name NOT LIKE 'sqlite_autoindex%'))
  `).all();
  if (dependentObjects.length > 0) {
    throw new Error(
      `Cannot safely rebuild tables with custom dependent objects: ${dependentObjects.map((object) => `${object.type}:${object.tbl_name}:${object.name}`).join(", ")}`
    );
  }
  db.exec(`
    CREATE TABLE users_v4 (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      qq_id          INTEGER UNIQUE,
      username       TEXT UNIQUE,
      password_hash  TEXT,
      role           TEXT NOT NULL DEFAULT 'member',
      login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until   INTEGER,
      last_login     INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    INSERT INTO users_v4 (
      id, qq_id, username, password_hash, role, login_attempts,
      locked_until, last_login, created_at, updated_at
    )
    SELECT
      id, qq_id, username, password_hash, role, login_attempts,
      locked_until, last_login, created_at, updated_at
    FROM users;

    DROP TABLE users;
    ALTER TABLE users_v4 RENAME TO users;

    CREATE TABLE risk_rules_v4 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      pattern    TEXT NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('mute', 'kick', 'notify_admin', 'log_only', 'off')),
      enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO risk_rules_v4 (id, name, pattern, action, enabled, created_at, updated_at)
    SELECT id, name, pattern, action, enabled, created_at, updated_at
    FROM risk_rules;

    DROP TABLE risk_rules;
    ALTER TABLE risk_rules_v4 RENAME TO risk_rules;

    CREATE INDEX IF NOT EXISTS idx_risk_rules_enabled ON risk_rules(enabled);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_id   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
      ON auth_sessions(user_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
      ON auth_sessions(expires_at);
  `);
}

// src/database/migrations/005_onebot_identifiers.ts
var onebot_identifiers_exports = {};
__export(onebot_identifiers_exports, {
  description: () => description5,
  up: () => up5,
  version: () => version5
});
var version5 = 5;
var description5 = "Store provider-facing OneBot identifiers as exact decimal text";
var REBUILT_TABLES = [
  "users",
  "auth_sessions",
  "approval_records",
  "captcha_sessions",
  "blacklist",
  "punishment_records",
  "audit_logs",
  "stat_snapshots"
];
var RECREATED_INDEXES = /* @__PURE__ */ new Set([
  "idx_auth_sessions_user_active",
  "idx_auth_sessions_expiry",
  "idx_approval_status",
  "idx_approval_user",
  "idx_approval_group",
  "idx_captcha_user",
  "idx_blacklist_user",
  "idx_blacklist_group",
  "idx_punishment_user",
  "idx_punishment_group",
  "idx_audit_action",
  "idx_audit_actor",
  "idx_audit_time"
]);
var IDENTIFIER_COLUMNS = {
  users: ["qq_id"],
  approval_records: ["group_id", "user_id", "operator_id"],
  captcha_sessions: ["group_id", "user_id"],
  blacklist: ["user_id", "group_id", "created_by"],
  punishment_records: ["group_id", "user_id", "operator_id", "revoked_by"],
  audit_logs: ["actor_id"],
  stat_snapshots: ["group_id"]
};
var LEGACY_SYSTEM_ACTOR_COLUMNS = /* @__PURE__ */ new Set([
  "approval_records.operator_id",
  "blacklist.created_by",
  "punishment_records.operator_id",
  "punishment_records.revoked_by",
  "audit_logs.actor_id"
]);
var REBUILT_AUTOINCREMENT_TABLES = [
  "users",
  "approval_records",
  "blacklist",
  "punishment_records",
  "audit_logs",
  "stat_snapshots"
];
function quoted(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
function invalidIdentifierSql(column, allowLegacySystemActor = false) {
  const name = quoted(column);
  return `${name} IS NOT NULL AND (
    typeof(${name}) NOT IN ('integer', 'text')
    OR CAST(${name} AS TEXT) = ''
    ${allowLegacySystemActor ? "" : `OR CAST(${name} AS TEXT) = '0'`}
    OR CAST(${name} AS TEXT) GLOB '*[^0-9]*'
    OR (length(CAST(${name} AS TEXT)) > 1 AND substr(CAST(${name} AS TEXT), 1, 1) = '0')
    OR length(CAST(${name} AS TEXT)) > 20
    OR (length(CAST(${name} AS TEXT)) = 20 AND CAST(${name} AS TEXT) > '18446744073709551615')
  )`;
}
function textIdCheck(column, nullable = false) {
  const name = quoted(column);
  const exact = `typeof(${name}) = 'text'
    AND ${name} <> ''
    AND ${name} <> '0'
    AND ${name} NOT GLOB '*[^0-9]*'
    AND (length(${name}) = 1 OR substr(${name}, 1, 1) <> '0')
    AND (length(${name}) < 20 OR (length(${name}) = 20 AND ${name} <= '18446744073709551615'))`;
  return `CHECK (${nullable ? `${name} IS NULL OR (` : ""}${exact}${nullable ? ")" : ""})`;
}
function assertSourceIdentifiers(db) {
  for (const [table, columns] of Object.entries(IDENTIFIER_COLUMNS)) {
    for (const column of columns) {
      const allowLegacySystemActor = LEGACY_SYSTEM_ACTOR_COLUMNS.has(`${table}.${column}`);
      const invalid = db.prepare(
        `SELECT rowid FROM ${quoted(table)} WHERE ${invalidIdentifierSql(column, allowLegacySystemActor)} LIMIT 1`
      ).get();
      if (invalid) {
        throw new Error(`Cannot canonicalize ${table}.${column}: row ${invalid.rowid} is not a positive unsigned 64-bit decimal identifier`);
      }
    }
  }
}
function assertNoUnknownDependentObjects(db) {
  const placeholders = REBUILT_TABLES.map(() => "?").join(", ");
  const objects = db.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_master
    WHERE tbl_name IN (${placeholders})
      AND (type = 'trigger' OR (type = 'index' AND name NOT LIKE 'sqlite_autoindex%'))
  `).all(...REBUILT_TABLES);
  const unknown = objects.filter((object) => object.type !== "index" || !RECREATED_INDEXES.has(object.name));
  if (unknown.length > 0) {
    throw new Error(
      `Cannot safely rebuild tables with custom dependent objects: ${unknown.map((object) => `${object.type}:${object.tbl_name}:${object.name}`).join(", ")}`
    );
  }
}
function up5(db) {
  assertNoUnknownDependentObjects(db);
  assertSourceIdentifiers(db);
  const sequences = db.prepare(`
    SELECT name, CAST(seq AS TEXT) AS seq
    FROM sqlite_sequence
    WHERE name IN (${REBUILT_AUTOINCREMENT_TABLES.map(() => "?").join(", ")})
  `).all(...REBUILT_AUTOINCREMENT_TABLES);
  db.exec(`
    CREATE TABLE users_v5 (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      qq_id          TEXT UNIQUE ${textIdCheck("qq_id", true)},
      username       TEXT UNIQUE,
      password_hash  TEXT,
      role           TEXT NOT NULL DEFAULT 'member',
      login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until   INTEGER,
      last_login     INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    INSERT INTO users_v5 (
      id, qq_id, username, password_hash, role, login_attempts,
      locked_until, last_login, created_at, updated_at
    )
    SELECT
      id, CASE WHEN qq_id IS NULL THEN NULL ELSE CAST(qq_id AS TEXT) END,
      username, password_hash, role, login_attempts,
      locked_until, last_login, created_at, updated_at
    FROM users;

    CREATE TABLE auth_sessions_v5 (
      token_id   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users_v5(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    INSERT INTO auth_sessions_v5
      SELECT token_id, user_id, kind, issued_at, expires_at, revoked_at FROM auth_sessions;

    CREATE TABLE approval_records_v5 (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id     TEXT NOT NULL ${textIdCheck("group_id")},
      user_id      TEXT NOT NULL ${textIdCheck("user_id")},
      flag         TEXT NOT NULL,
      comment      TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      reason       TEXT,
      operator_id  TEXT ${textIdCheck("operator_id", true)},
      captcha_id   TEXT,
      created_at   INTEGER NOT NULL,
      processed_at INTEGER,
      expires_at   INTEGER NOT NULL
    );
    INSERT INTO approval_records_v5
    SELECT id, CAST(group_id AS TEXT), CAST(user_id AS TEXT), flag, comment, status, reason,
      CASE WHEN operator_id IS NULL OR CAST(operator_id AS TEXT) = '0' THEN NULL ELSE CAST(operator_id AS TEXT) END,
      captcha_id, created_at, processed_at, expires_at
    FROM approval_records;

    CREATE TABLE captcha_sessions_v5 (
      id           TEXT PRIMARY KEY,
      group_id     TEXT NOT NULL ${textIdCheck("group_id")},
      user_id      TEXT NOT NULL ${textIdCheck("user_id")},
      approval_id  INTEGER NOT NULL,
      type         TEXT NOT NULL,
      challenge    TEXT NOT NULL,
      answer       TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      solved       INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO captcha_sessions_v5
    SELECT id, CAST(group_id AS TEXT), CAST(user_id AS TEXT), approval_id, type, challenge,
      answer, attempts, max_attempts, created_at, expires_at, solved
    FROM captcha_sessions;

    CREATE TABLE blacklist_v5 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL ${textIdCheck("user_id")},
      group_id   TEXT ${textIdCheck("group_id", true)},
      reason     TEXT NOT NULL DEFAULT '',
      created_by TEXT ${textIdCheck("created_by", true)},
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      UNIQUE(user_id, group_id)
    );
    INSERT INTO blacklist_v5
    SELECT id, CAST(user_id AS TEXT), CASE WHEN group_id IS NULL THEN NULL ELSE CAST(group_id AS TEXT) END,
      reason, CASE WHEN CAST(created_by AS TEXT) = '0' THEN NULL ELSE CAST(created_by AS TEXT) END,
      created_at, expires_at
    FROM blacklist;

    CREATE TABLE punishment_records_v5 (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id         TEXT NOT NULL ${textIdCheck("group_id")},
      user_id          TEXT NOT NULL ${textIdCheck("user_id")},
      type             TEXT NOT NULL,
      duration_seconds INTEGER,
      reason           TEXT NOT NULL DEFAULT '',
      operator_id      TEXT ${textIdCheck("operator_id", true)},
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER,
      revoked_at       INTEGER,
      revoked_by       TEXT ${textIdCheck("revoked_by", true)}
    );
    INSERT INTO punishment_records_v5
    SELECT id, CAST(group_id AS TEXT), CAST(user_id AS TEXT), type, duration_seconds, reason,
      CASE WHEN CAST(operator_id AS TEXT) = '0' THEN NULL ELSE CAST(operator_id AS TEXT) END,
      created_at, expires_at, revoked_at,
      CASE WHEN revoked_by IS NULL OR CAST(revoked_by AS TEXT) = '0' THEN NULL ELSE CAST(revoked_by AS TEXT) END
    FROM punishment_records;

    CREATE TABLE audit_logs_v5 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      actor_id    TEXT ${textIdCheck("actor_id", true)},
      target_type TEXT,
      target_id   TEXT,
      details     TEXT NOT NULL DEFAULT '{}',
      ip          TEXT,
      created_at  INTEGER NOT NULL
    );
    INSERT INTO audit_logs_v5
    SELECT id, action,
      CASE WHEN actor_id IS NULL OR CAST(actor_id AS TEXT) = '0' THEN NULL ELSE CAST(actor_id AS TEXT) END,
      target_type, target_id, details, ip, created_at
    FROM audit_logs;

    CREATE TABLE stat_snapshots_v5 (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id            TEXT ${textIdCheck("group_id", true)},
      period              TEXT NOT NULL,
      approvals_total     INTEGER NOT NULL DEFAULT 0,
      approvals_passed    INTEGER NOT NULL DEFAULT 0,
      approvals_rejected  INTEGER NOT NULL DEFAULT 0,
      captchas_total      INTEGER NOT NULL DEFAULT 0,
      captchas_passed     INTEGER NOT NULL DEFAULT 0,
      punishments_total   INTEGER NOT NULL DEFAULT 0,
      risk_detections     INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      UNIQUE(group_id, period)
    );
    INSERT INTO stat_snapshots_v5
    SELECT id, CASE WHEN group_id IS NULL THEN NULL ELSE CAST(group_id AS TEXT) END, period,
      approvals_total, approvals_passed, approvals_rejected, captchas_total,
      captchas_passed, punishments_total, risk_detections, created_at
    FROM stat_snapshots;

    DROP TABLE auth_sessions;
    DROP TABLE users;
    DROP TABLE approval_records;
    DROP TABLE captcha_sessions;
    DROP TABLE blacklist;
    DROP TABLE punishment_records;
    DROP TABLE audit_logs;
    DROP TABLE stat_snapshots;

    ALTER TABLE users_v5 RENAME TO users;
    ALTER TABLE auth_sessions_v5 RENAME TO auth_sessions;
    ALTER TABLE approval_records_v5 RENAME TO approval_records;
    ALTER TABLE captcha_sessions_v5 RENAME TO captcha_sessions;
    ALTER TABLE blacklist_v5 RENAME TO blacklist;
    ALTER TABLE punishment_records_v5 RENAME TO punishment_records;
    ALTER TABLE audit_logs_v5 RENAME TO audit_logs;
    ALTER TABLE stat_snapshots_v5 RENAME TO stat_snapshots;

    CREATE INDEX idx_auth_sessions_user_active ON auth_sessions(user_id, revoked_at);
    CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE INDEX idx_approval_status ON approval_records(status);
    CREATE INDEX idx_approval_user ON approval_records(user_id);
    CREATE INDEX idx_approval_group ON approval_records(group_id);
    CREATE INDEX idx_captcha_user ON captcha_sessions(user_id, solved);
    CREATE INDEX idx_blacklist_user ON blacklist(user_id);
    CREATE INDEX idx_blacklist_group ON blacklist(group_id);
    CREATE INDEX idx_punishment_user ON punishment_records(user_id);
    CREATE INDEX idx_punishment_group ON punishment_records(group_id);
    CREATE INDEX idx_audit_action ON audit_logs(action);
    CREATE INDEX idx_audit_actor ON audit_logs(actor_id);
    CREATE INDEX idx_audit_time ON audit_logs(created_at);
  `);
  for (const { name, seq } of sequences) {
    const updated = db.prepare("UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = ?").run(seq, name);
    if (Number(updated.changes) === 0) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))").run(name, seq);
    }
  }
}

// src/database/migrations/006_login_rate_limits.ts
var login_rate_limits_exports = {};
__export(login_rate_limits_exports, {
  description: () => description6,
  up: () => up6,
  version: () => version6
});
var version6 = 6;
var description6 = "Persist login rate-limit buckets and audit account locks";
function up6(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_rate_limits (
      scope      TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      reset_at   INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, bucket_key)
    );

    CREATE INDEX IF NOT EXISTS idx_login_rate_limits_reset
      ON login_rate_limits(reset_at);

    CREATE TRIGGER IF NOT EXISTS trg_users_account_locked_audit
    AFTER UPDATE OF locked_until ON users
    WHEN NEW.locked_until IS NOT NULL
      AND (OLD.locked_until IS NULL OR NEW.locked_until > OLD.locked_until)
    BEGIN
      INSERT INTO audit_logs (
        action, actor_id, target_type, target_id, details, created_at
      ) VALUES (
        'account_locked',
        NULL,
        'user',
        CAST(NEW.id AS TEXT),
        '{}',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      );
    END;
  `);
}

// src/runtime/provider-telemetry.ts
import { randomUUID } from "node:crypto";
var MAX_LABEL_LENGTH = 64;
var SAFE_LABEL = /^[a-z0-9][a-z0-9_.:-]*$/;
function safeTimestamp(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
function normalizeTelemetryLabel(value, fallback) {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 0 && normalized.length <= MAX_LABEL_LENGTH && SAFE_LABEL.test(normalized)) {
    return normalized;
  }
  return fallback;
}
var ProviderConnectionDiagnostics = class {
  options;
  state;
  stateChangedAt;
  connectedAt;
  reconnectAttempts = 0;
  everConnected;
  lastKnownConnected;
  constructor(options) {
    this.options = { ...options, now: options.now ?? Date.now };
    const now = safeTimestamp(this.options.now());
    const connected = this.readConnected();
    this.lastKnownConnected = connected;
    this.everConnected = connected === true;
    this.state = connected === null ? "unknown" : connected ? "connected" : "disconnected";
    this.stateChangedAt = now;
    this.connectedAt = connected ? now : null;
  }
  snapshot() {
    const now = safeTimestamp(this.options.now());
    const connected = this.readConnected();
    if (connected === null) {
      this.transition("unknown", now);
    } else if (connected) {
      if (this.lastKnownConnected !== true) this.connectedAt = now;
      this.transition("connected", now);
      this.everConnected = true;
      this.lastKnownConnected = true;
    } else {
      if (this.lastKnownConnected !== false && this.everConnected) this.reconnectAttempts += 1;
      this.transition(this.everConnected ? "reconnecting" : "disconnected", now);
      this.lastKnownConnected = false;
    }
    const transport = typeof this.options.transport === "function" ? this.options.transport() : this.options.transport;
    return {
      provider: this.options.provider,
      transport: normalizeTelemetryLabel(transport, "unknown"),
      state: this.state,
      stateChangedAt: this.stateChangedAt,
      connectedAt: this.connectedAt,
      reconnectAttempts: this.reconnectAttempts
    };
  }
  readConnected() {
    try {
      return this.options.isConnected();
    } catch {
      return null;
    }
  }
  transition(state2, now) {
    if (this.state === state2) return;
    this.state = state2;
    this.stateChangedAt = now;
  }
};
function createProviderDiagnostics(options) {
  return new ProviderConnectionDiagnostics(options);
}
function providerPortCategory(error) {
  if (!error || typeof error !== "object") return null;
  if (!("category" in error) || typeof error.category !== "string") return null;
  return error.category;
}
function categorizeProviderError(error) {
  const typedCategory = providerPortCategory(error);
  if (typedCategory) {
    if (typedCategory === "authentication") return "authentication";
    if (typedCategory === "timeout") return "timeout";
    if (typedCategory === "transport" || typedCategory === "connection") return "transport";
    if (typedCategory === "protocol" || typedCategory === "invalid_response") return "protocol";
    if (typedCategory === "unsupported" || typedCategory === "capability_mismatch") return "unsupported_action";
    if (typedCategory === "logical") return "provider";
    if (typedCategory === "invalid_parameters" || typedCategory === "adapter_internal") return "unknown";
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${name} ${message}`.toLowerCase();
  if (/unauthori[sz]ed|forbidden|authentication|authorization|auth[_ -]?failed|invalid[^\n]*token|\b(?:401|403)\b/.test(text)) {
    return "authentication";
  }
  if (name === "AbortError" || /timed?\s*out|timeout/.test(text)) return "timeout";
  if (/unsupported[^\n]*action|unknown[^\n]*action|action[^\n]*not supported/.test(text)) {
    return "unsupported_action";
  }
  if (/malformed|invalid (?:onebot )?(?:packet|response)|protocol|frame|retcode|json|binary/.test(text)) {
    return "protocol";
  }
  if (/not connected|disconnect|connection[^\n]*(?:closed|failed|refused|reset)|econn(?:refused|reset)|\bepipe\b|network|fetch failed|websocket[^\n]*closed/.test(text)) {
    return "transport";
  }
  if (/onebot[^\n]*failed|provider[^\n]*failed|action[^\n]*failed/.test(text)) return "provider";
  return "unknown";
}
var ProviderTelemetryTracker = class {
  diagnostics;
  now;
  correlationId;
  lastSuccessAt = null;
  lastEventAt = null;
  lastErrorAt = null;
  lastErrorCategory = null;
  lastHeartbeatAt = null;
  lastCorrelationId = null;
  errorsTotal = 0;
  stateOverride = null;
  stateOverrideAt = null;
  actionsTotal = 0;
  actionsSucceeded = 0;
  actionsFailed = 0;
  actionsInFlight = 0;
  eventsTotal = 0;
  eventsDropped = 0;
  constructor(diagnostics, options = {}) {
    this.diagnostics = diagnostics;
    this.now = options.now ?? Date.now;
    this.correlationId = options.correlationId ?? randomUUID;
  }
  beginAction(action) {
    this.actionsInFlight += 1;
    const correlationId = normalizeTelemetryLabel(this.correlationId(), randomUUID());
    this.lastCorrelationId = correlationId;
    return {
      action: normalizeTelemetryLabel(action, "unknown_action"),
      correlationId,
      startedAt: safeTimestamp(this.now())
    };
  }
  finishActionSuccess(span) {
    const finishedAt = safeTimestamp(this.now());
    this.finishAction();
    this.actionsSucceeded += 1;
    this.lastSuccessAt = finishedAt;
    this.stateOverride = null;
    this.stateOverrideAt = null;
    return this.actionLog(span, finishedAt, "ok");
  }
  finishActionError(span, error) {
    const finishedAt = safeTimestamp(this.now());
    const category = categorizeProviderError(error);
    this.finishAction();
    this.actionsFailed += 1;
    this.recordError(category, finishedAt);
    return this.actionLog(span, finishedAt, "error", category);
  }
  recordEvent(isHeartbeat = false) {
    this.eventsTotal += 1;
    const at = safeTimestamp(this.now());
    this.lastEventAt = at;
    if (isHeartbeat) this.lastHeartbeatAt = at;
    const correlationId = normalizeTelemetryLabel(this.correlationId(), randomUUID());
    this.lastCorrelationId = correlationId;
    this.stateOverride = null;
    this.stateOverrideAt = null;
    return correlationId;
  }
  recordEventDrop() {
    this.eventsDropped += 1;
    const correlationId = normalizeTelemetryLabel(this.correlationId(), randomUUID());
    this.lastCorrelationId = correlationId;
    return correlationId;
  }
  recordProviderError(error) {
    const category = categorizeProviderError(error);
    const correlationId = normalizeTelemetryLabel(this.correlationId(), randomUUID());
    this.lastCorrelationId = correlationId;
    this.recordError(category, safeTimestamp(this.now()));
    return { category, correlationId };
  }
  snapshot() {
    const now = safeTimestamp(this.now());
    const connection = this.diagnostics.snapshot();
    if (this.stateOverride && this.stateOverrideAt !== null && connection.state === "connected" && connection.stateChangedAt > this.stateOverrideAt) {
      this.stateOverride = null;
      this.stateOverrideAt = null;
    }
    const state2 = this.stateOverride ?? connection.state;
    const stateChangedAt = this.stateOverrideAt ?? connection.stateChangedAt;
    return {
      ...connection,
      state: state2,
      stateChangedAt,
      connectionAgeMs: connection.connectedAt === null ? null : Math.max(0, now - connection.connectedAt),
      stateAgeMs: Math.max(0, now - stateChangedAt),
      lastSuccessAt: this.lastSuccessAt,
      lastEventAt: this.lastEventAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorCategory: this.lastErrorCategory,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastCorrelationId: this.lastCorrelationId,
      errorsTotal: this.errorsTotal,
      actions: {
        total: this.actionsTotal,
        succeeded: this.actionsSucceeded,
        failed: this.actionsFailed,
        inFlight: this.actionsInFlight
      },
      events: {
        total: this.eventsTotal,
        dropped: this.eventsDropped
      }
    };
  }
  finishAction() {
    this.actionsTotal += 1;
    this.actionsInFlight = Math.max(0, this.actionsInFlight - 1);
  }
  recordError(category, at) {
    this.errorsTotal += 1;
    this.lastErrorAt = at;
    this.lastErrorCategory = category;
    if (category === "authentication") this.stateOverride = "auth_failed";
    else if (category === "transport") this.stateOverride = "disconnected";
    else return;
    this.stateOverrideAt = at;
  }
  actionLog(span, finishedAt, status, errorCategory) {
    const snapshot = this.snapshot();
    return {
      operation: "onebot.action",
      provider: snapshot.provider,
      transport: snapshot.transport,
      connection_state: snapshot.state,
      action: span.action,
      correlation_id: span.correlationId,
      duration_ms: Math.max(0, finishedAt - span.startedAt),
      status,
      ...errorCategory ? { error_category: errorCategory } : {}
    };
  }
};

// src/runtime/host.ts
var currentHost = null;
var providerTelemetry = null;
function setRuntimeHost(host) {
  if (currentHost && currentHost !== host) {
    throw new Error("[qq-guardian] Runtime host is already initialized");
  }
  currentHost = host;
  providerTelemetry ??= new ProviderTelemetryTracker(host.provider ?? createProviderDiagnostics({
    provider: host.kind,
    transport: "unknown",
    isConnected: () => null
  }));
}
function clearRuntimeHost() {
  currentHost = null;
  providerTelemetry = null;
}
function getRuntimeHost() {
  if (!currentHost) throw new Error("[qq-guardian] Runtime host is not initialized");
  return currentHost;
}
function tryGetRuntimeHost() {
  return currentHost;
}
function getProviderTelemetry() {
  if (!providerTelemetry) throw new Error("[qq-guardian] Provider telemetry is not initialized");
  return providerTelemetry.snapshot();
}
function recordProviderEvent(isHeartbeat = false) {
  return providerTelemetry?.recordEvent(isHeartbeat) ?? null;
}
function recordProviderEventDrop() {
  return providerTelemetry?.recordEventDrop() ?? null;
}
async function callOneBot(action, params) {
  const host = getRuntimeHost();
  if (!providerTelemetry) providerTelemetry = new ProviderTelemetryTracker(host.provider ?? createProviderDiagnostics({
    provider: host.kind,
    transport: "unknown",
    isConnected: () => null
  }));
  const span = providerTelemetry.beginAction(action);
  const log = getLogger().child({ module: "provider" });
  try {
    const result = await host.onebot.call(action, params);
    log.info(providerTelemetry.finishActionSuccess(span), "Provider action completed");
    return result;
  } catch (error) {
    log.warn(providerTelemetry.finishActionError(span, error), "Provider action failed");
    throw error;
  }
}

// src/core/logger/redaction.ts
var REDACTED = "[REDACTED]";
var OMITTED = "[OMITTED]";
var MAX_DEPTH = 8;
var SECRET_KEY = /^(?:access_?token|refresh_?token|token|authorization|proxy-authorization|auth|secret|password|passwd|credentials?|api[_-]?key|cookie|set-cookie|jwt)$/i;
var PAYLOAD_KEY = /^(?:params?|payload|body|raw|raw_message|private_message|message|content|comment|request|response|event|data)$/i;
var SECRET_NAME = "(?:access_?token|refresh_?token|token|authorization|proxy-authorization|auth|secret|password|passwd|credentials?|api[_-]?key|cookie|jwt)";
function redactLogText(value) {
  return value.replace(/(\b(?:bearer|basic)\s+)[a-z0-9._~+/=-]+/gi, "$1[REDACTED]").replace(new RegExp(`([?&]${SECRET_NAME}=)[^&#\\s]*`, "gi"), "$1[REDACTED]").replace(new RegExp(`((?:${SECRET_NAME})["']?\\s*[:=]\\s*)["'][^"']*["']`, "gi"), '$1"[REDACTED]"').replace(new RegExp(`((?:${SECRET_NAME})\\s*[:=]\\s*)[^\\s,;&]+`, "gi"), "$1[REDACTED]").replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@").replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, REDACTED);
}
function redactLogValue(value) {
  return redactValue(value, /* @__PURE__ */ new WeakSet(), 0);
}
function redactValue(value, seen, depth) {
  if (typeof value === "string") return redactLogText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === void 0) {
    return value;
  }
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Error) {
    return {
      name: redactLogText(value.name),
      message: redactLogText(value.message)
    };
  }
  if (depth >= MAX_DEPTH) return OMITTED;
  if (typeof value !== "object") return redactLogText(String(value));
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, seen, depth + 1));
    }
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) output[key] = REDACTED;
      else if (PAYLOAD_KEY.test(key)) output[key] = OMITTED;
      else output[key] = redactValue(entry, seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

// src/core/logger/index.ts
function describe(o) {
  if (o instanceof Error) return `${redactLogText(o.name)}: ${redactLogText(o.message)}`;
  if (typeof o === "string") return redactLogText(o);
  try {
    return JSON.stringify(redactLogValue(o));
  } catch {
    return '"[UNSERIALIZABLE]"';
  }
}
function fmt(prefix, objOrMsg, msg) {
  if (msg) {
    const extra = objOrMsg === void 0 || objOrMsg === null ? "" : " " + describe(objOrMsg);
    return `[${prefix}] ${redactLogText(msg)}${extra}`;
  }
  return `[${prefix}] ${describe(objOrMsg)}`;
}
function makeLogger(prefix) {
  const write = (level, obj, msg) => {
    const text = fmt(prefix, obj, msg);
    const host = tryGetRuntimeHost();
    if (host) {
      host.logger[level](text);
    } else {
      console[level](text);
    }
  };
  return {
    info: (o, m) => write("info", o, m),
    warn: (o, m) => write("warn", o, m),
    error: (o, m) => write("error", o, m),
    debug: (o, m) => write("debug", o, m),
    child: (b) => makeLogger(b["module"] ? `${prefix}:${String(b["module"])}` : prefix)
  };
}
var _root = makeLogger("guardian");
function getLogger() {
  return _root;
}

// src/database/migrations/index.ts
var DATABASE_SCHEMA_VERSION = 6;
var MIGRATIONS = [initial_exports, captcha_index_exports, risk_rule_action_exports, canonical_storage_exports, onebot_identifiers_exports, login_rate_limits_exports];
function runMigrations(db) {
  const log = getLogger().child({ module: "migrations" });
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version)
  );
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    log.info("Schema up to date");
    return;
  }
  for (const migration of pending) {
    log.info({ version: migration.version }, `Applying: ${migration.description}`);
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(migration.version, Date.now());
      db.exec("COMMIT");
      log.info({ version: migration.version }, "Applied OK");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

// src/database/index.ts
var DATABASE_FILENAME = "qqadmin.db";
var _db = null;
var _generation = 0;
function getDatabasePath(dataDir) {
  return join(dataDir, DATABASE_FILENAME);
}
function openDatabaseFile(databasePath, readOnly = false) {
  const db = new DatabaseSync(databasePath, { readOnly, timeout: 5e3 });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (!readOnly) db.exec("PRAGMA synchronous = NORMAL");
  return db;
}
function openDatabase(dataDir) {
  if (_db) return _db;
  mkdirSync(dataDir, { recursive: true });
  const dbPath = getDatabasePath(dataDir);
  _db = openDatabaseFile(dbPath);
  _db.exec("PRAGMA journal_mode = WAL");
  runMigrations(_db);
  _generation += 1;
  getLogger().info({ path: dbPath }, "Database opened (node:sqlite)");
  return _db;
}
function getDatabase() {
  if (!_db) throw new Error("Database not initialized. Call openDatabase() first.");
  return _db;
}
function getDatabaseGeneration() {
  return _generation;
}
function closeDatabase() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// src/database/repositories/approval.ts
var ApprovalRepository = class {
  findById(id) {
    return getDatabase().prepare("SELECT * FROM approval_records WHERE id = ?").get(id) ?? null;
  }
  /** Latest record for a given OneBot request flag. The admission-sync
   *  poller uses this to skip requests the live event stream (or an earlier
   *  sweep) already routed. */
  findByFlag(flag) {
    return getDatabase().prepare("SELECT * FROM approval_records WHERE flag = ? ORDER BY created_at DESC LIMIT 1").get(flag) ?? null;
  }
  findAllPending(limit = 50, offset = 0) {
    return getDatabase().prepare(
      `SELECT * FROM approval_records WHERE status IN ('pending','captcha')
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(limit, offset);
  }
  create(data) {
    const now = Date.now();
    const result = getDatabase().prepare(
      `INSERT INTO approval_records
         (group_id, user_id, flag, comment, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.groupId,
      data.userId,
      data.flag,
      data.comment,
      data.status,
      now,
      now + data.ttlSeconds * 1e3
    );
    return this.findById(Number(result.lastInsertRowid));
  }
  updateStatus(id, status, operatorId2 = null, reason = null, captchaId = null) {
    getDatabase().prepare(
      `UPDATE approval_records
         SET status = ?, operator_id = ?, reason = ?, captcha_id = ?, processed_at = ?
         WHERE id = ?`
    ).run(status, operatorId2, reason, captchaId, Date.now(), id);
  }
  expireOldPending() {
    const result = getDatabase().prepare(
      `UPDATE approval_records SET status = 'expired', processed_at = ?
         WHERE status IN ('pending','captcha') AND expires_at < ?`
    ).run(Date.now(), Date.now());
    return Number(result.changes);
  }
  countByStatus() {
    const rows = getDatabase().prepare("SELECT status, COUNT(*) as cnt FROM approval_records GROUP BY status").all();
    return Object.fromEntries(rows.map((r) => [r.status, r.cnt]));
  }
};
var approvalRepo = new ApprovalRepository();

// src/core/config/index.ts
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync as mkdirSync2,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { join as join2 } from "path";

// src/core/config/defaults.ts
import { randomBytes } from "crypto";
function buildDefaults() {
  return {
    core: {
      selfId: "0",
      superAdmins: [],
      timezone: "Asia/Shanghai"
    },
    webui: {
      jwtSecret: randomBytes(32).toString("hex"),
      jwtExpiresIn: "2h",
      refreshExpiresIn: "7d"
    },
    approval: {
      defaultAction: "manual",
      groups: {},
      pendingTtlSeconds: 86400,
      // 24h
      defaultGroupEnabled: false,
      useBuiltinRejectKeywords: true,
      // Applicant-controlled referral text is not authentication. Operators
      // may explicitly enable this convenience heuristic after accepting the
      // admission-bypass risk; manual review must remain manual by default.
      useBuiltinApproveKeywords: false,
      realtimeSyncEnabled: true,
      syncIntervalSeconds: 30
    },
    captcha: {
      ttlSeconds: 300,
      maxAttempts: 3,
      types: ["math", "question"],
      questions: []
    },
    risk: {
      enabled: true,
      detectorActions: {
        advertising: "mute",
        fraud: "mute",
        grayMarket: "mute",
        pornography: "kick",
        political: "kick",
        gambling: "mute",
        shortLinks: "log_only",
        duplicateMessages: "mute",
        spam: "mute",
        cardMessage: "log_only",
        aiViolation: "off"
      },
      muteDurationSeconds: 600,
      aiMinScore: 70,
      recallMessage: false
    },
    punishment: {
      defaultMuteDurationSeconds: 600,
      escalateToKickAfter: 3,
      escalateToBlacklistAfter: 5
    },
    blacklist: {
      autoKickOnJoin: true
    },
    auth: {
      maxLoginAttempts: 5,
      lockoutSeconds: 900,
      rateLimitRequests: 100,
      rateLimitWindowMs: 6e4
    },
    monitor: {
      intervalMs: 3e4,
      diskAlertMb: 500,
      memoryAlertPercent: 90
    },
    update: {
      githubRepo: "ShiYuPIay/napcat-plugin-qq-guardian",
      autoCheckOnStartup: true
    },
    ai: {
      provider: "disabled",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      timeoutMs: 15e3,
      riskPrompt: 'Analyze the following QQ group message for risk. Respond with JSON: {"score":0-100,"reason":"...","tags":[]}. Score: 0=safe, 100=extremely harmful.'
    },
    commands: {
      enabled: true,
      prefix: "/guard"
    },
    intel: {
      // Fetching is opt-in and enforcement is a second, pinned opt-in. Legacy
      // enabled configurations migrate to observation-only behavior.
      enabled: false,
      enforcementMode: "observe",
      feedUrls: [
        "https://raw.githubusercontent.com/ShiYuPIay/napcat-plugin-qq-guardian/main/intel/feed.json"
      ],
      feedPins: {},
      refreshIntervalSeconds: 300
    }
  };
}

// src/core/config/boolean.ts
function parseBoolean(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return void 0;
}

// src/core/config/intel.ts
function normalizeIntelFeedUrls(values) {
  const normalized = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    try {
      const url = new URL(value.trim());
      url.hash = "";
      const canonical = url.toString();
      if (!seen.has(canonical)) {
        seen.add(canonical);
        normalized.push(canonical);
      }
    } catch {
    }
  }
  return normalized;
}

// src/core/regex/index.ts
import { Worker } from "worker_threads";
var MAX_PATTERN_LENGTH = 512;
var PROBE_TIMEOUT_MS = 250;
var PROBE_INPUTS = [
  "a".repeat(60),
  "a".repeat(59) + "!",
  "ab".repeat(30),
  "aa ".repeat(20) + "b",
  "1".repeat(60),
  "1".repeat(59) + "!",
  "12".repeat(30),
  // Exercise delayed ambiguity after a literal prefix without allowing an
  // unbounded feed to allocate arbitrarily large probe inputs.
  "a".repeat(512),
  "a".repeat(511) + "!",
  "ab".repeat(256),
  "1".repeat(512),
  "1".repeat(511) + "!",
  "12".repeat(256)
];
function hasNestedQuantifier(pattern) {
  return /\([^)]*[+*][^)]*\)[+*{]/.test(pattern);
}
function repetitionUpperBoundAt(pattern, offset) {
  const marker = pattern[offset];
  if (marker === "*" || marker === "+") return Number.POSITIVE_INFINITY;
  if (marker !== "{") return null;
  const match = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(offset));
  if (!match) return null;
  if (match[2] === void 0) return Number(match[1]);
  return match[2] === "" ? Number.POSITIVE_INFINITY : Number(match[2]);
}
function alternativesAtTopLevel(groupSource) {
  let source = groupSource;
  if (source.startsWith("?:") || source.startsWith("?=") || source.startsWith("?!")) source = source.slice(2);
  else if (source.startsWith("?<=") || source.startsWith("?<!")) source = source.slice(3);
  else if (source.startsWith("?<")) {
    const nameEnd = source.indexOf(">");
    if (nameEnd !== -1) source = source.slice(nameEnd + 1);
  }
  const alternatives = [];
  let start = 0;
  let depth = 0;
  let inCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (character === "|" && depth === 0) {
      alternatives.push(source.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(source.slice(start));
  return alternatives;
}
function hasAmbiguousQuantifiedAlternation(pattern) {
  const groups = [];
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === "(") {
      groups.push(index);
      continue;
    }
    if (character !== ")") continue;
    const start = groups.pop();
    const maximum = repetitionUpperBoundAt(pattern, index + 1);
    if (start === void 0 || maximum === null || maximum <= 1) continue;
    const alternatives = alternativesAtTopLevel(pattern.slice(start + 1, index));
    if (alternatives.length < 2) continue;
    let hasAmbiguity = false;
    for (let left = 0; left < alternatives.length; left += 1) {
      for (let right = left + 1; right < alternatives.length; right += 1) {
        const a = alternatives[left];
        const b = alternatives[right];
        if (!a || !b || a.startsWith(b) || b.startsWith(a)) {
          hasAmbiguity = true;
          break;
        }
      }
      if (hasAmbiguity) break;
    }
    if (!hasAmbiguity) continue;
    const boundedCombinations = Number.isFinite(maximum) ? Math.pow(alternatives.length, maximum) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(maximum) || maximum > 8 || boundedCombinations > 1024) return true;
  }
  return false;
}
function probePatternInWorker(pattern) {
  const src = `
    const { parentPort, workerData } = require('worker_threads');
    const re = new RegExp(workerData.pattern);
    for (const input of workerData.inputs) re.test(input);
    parentPort.postMessage(true);
  `;
  return new Promise((resolve4) => {
    const worker = new Worker(src, { eval: true, workerData: { pattern, inputs: PROBE_INPUTS } });
    let killTimer = null;
    const finish = (verdict) => {
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(hardCap);
      void worker.terminate();
      resolve4(verdict);
    };
    const hardCap = setTimeout(() => finish(false), 5e3);
    worker.once("online", () => {
      killTimer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    });
    worker.once("message", () => finish(true));
    worker.once("error", () => finish(false));
  });
}
async function probePatternsInWorkers(patterns) {
  const distinct = [...new Set(patterns)];
  const results = /* @__PURE__ */ new Map();
  const workerCount = Math.min(4, distinct.length);
  let next = 0;
  const probeNext = async () => {
    while (next < distinct.length) {
      const pattern = distinct[next++];
      results.set(pattern, await probePatternInWorker(pattern));
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => probeNext()));
  return results;
}
async function validateRegexPattern(pattern) {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Pattern too long (max ${MAX_PATTERN_LENGTH} characters)`);
  }
  if (hasNestedQuantifier(pattern)) {
    throw new Error("Pattern contains potentially catastrophic nested quantifier");
  }
  if (hasAmbiguousQuantifiedAlternation(pattern)) {
    throw new Error("Pattern contains an ambiguous quantified alternation");
  }
  try {
    new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regex: ${e instanceof Error ? e.message : e}`);
  }
  if (!await probePatternInWorker(pattern)) {
    throw new Error("Pattern failed performance test (possible ReDoS)");
  }
}

// src/core/config/schema.ts
var CONFIG_SCHEMA_VERSION = 6;
var CONFIG_FILENAME = "config.json";
var ConfigValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigValidationError";
  }
};
var UNSAFE_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var EXTENSION_MAX_BYTES = 64 * 1024;
var EXTENSION_MAX_DEPTH = 8;
var EXTENSION_MAX_ENTRIES = 256;
var EXTENSION_MAX_ARRAY_ITEMS = 128;
var EXTENSION_MAX_STRING_LENGTH = 4096;
var CONFIG_CLONE_MAX_DEPTH = 64;
var CONFIG_CLONE_MAX_ENTRIES = 1e5;
var SECRET_KEY_FRAGMENTS = [
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "credential",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "token"
];
var APPROVAL_ACTIONS = /* @__PURE__ */ new Set([
  "auto_approve",
  "auto_reject",
  "manual",
  "captcha"
]);
var RISK_ACTIONS = /* @__PURE__ */ new Set([
  "mute",
  "kick",
  "notify_admin",
  "log_only",
  "off"
]);
var CAPTCHA_TYPES = /* @__PURE__ */ new Set(["math", "text", "question"]);
var AI_PROVIDERS = /* @__PURE__ */ new Set(["openai", "anthropic", "custom", "disabled"]);
var INTEL_ENFORCEMENT_MODES = /* @__PURE__ */ new Set(["observe", "enforce"]);
var RETIRED_RISK_FIELDS = /* @__PURE__ */ new Set([
  "threshold",
  "severeThreshold",
  "action",
  "severeAction",
  "weights",
  "detectors"
]);
function fail(path, message) {
  throw new ConfigValidationError(`${path}: ${message}`);
}
function asRecord(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value;
}
function assertKnownKeys(record2, allowed, path) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record2)) {
    if (UNSAFE_KEYS.has(key)) fail(path, `contains unsafe key ${JSON.stringify(key)}`);
    if (!allowedKeys.has(key)) fail(path, `contains unsupported key ${JSON.stringify(key)}`);
  }
}
function isSecretLikeKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}
function escapeJsonPointerSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function appendJsonPointer(pointer, segment) {
  return `${pointer}/${escapeJsonPointerSegment(segment)}`;
}
function decodeJsonPointer(path) {
  if (!path.startsWith("/")) fail("$.extensions.legacy", "field paths must be RFC 6901 JSON Pointers");
  return path.slice(1).split("/").map((segment) => {
    if (/~(?:[^01]|$)/.test(segment)) {
      fail(`$.extensions.legacy.${path}`, "contains an invalid JSON Pointer escape");
    }
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}
function cloneExtensionJsonValue(value, path, depth, budget) {
  if (depth > EXTENSION_MAX_DEPTH) fail(path, `must not exceed ${EXTENSION_MAX_DEPTH} levels`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite JSON numbers");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > EXTENSION_MAX_STRING_LENGTH) {
      fail(path, `strings must not exceed ${EXTENSION_MAX_STRING_LENGTH} characters`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > EXTENSION_MAX_ARRAY_ITEMS) {
      fail(path, `arrays must not exceed ${EXTENSION_MAX_ARRAY_ITEMS} items`);
    }
    budget.entries += value.length;
    if (budget.entries > EXTENSION_MAX_ENTRIES) {
      fail(path, `must not exceed ${EXTENSION_MAX_ENTRIES} total entries`);
    }
    const result2 = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        fail(`${path}[${index}]`, "arrays must contain only plain JSON data entries");
      }
      result2.push(cloneExtensionJsonValue(descriptor.value, `${path}[${index}]`, depth + 1, budget));
    }
    return result2;
  }
  if (typeof value !== "object") fail(path, "must contain only JSON values");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must contain only plain JSON objects");
  const source = value;
  const keys = Object.keys(source);
  budget.entries += keys.length;
  if (budget.entries > EXTENSION_MAX_ENTRIES) {
    fail(path, `must not exceed ${EXTENSION_MAX_ENTRIES} total entries`);
  }
  const result = {};
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) fail(path, `contains unsafe key ${JSON.stringify(key)}`);
    if (isSecretLikeKey(key)) fail(`${path}.${key}`, "secret-like extension keys are not preserved");
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) fail(`${path}.${key}`, "must be a plain JSON data property");
    result[key] = cloneExtensionJsonValue(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
  return result;
}
function validateConfigExtensions(value) {
  const envelope = asRecord(value, "$.extensions");
  assertKnownKeys(envelope, ["legacy"], "$.extensions");
  const legacy = asRecord(envelope.legacy, "$.extensions.legacy");
  const validated = {};
  const budget = { entries: Object.keys(legacy).length };
  if (budget.entries > EXTENSION_MAX_ENTRIES) {
    fail("$.extensions.legacy", `must not exceed ${EXTENSION_MAX_ENTRIES} total entries`);
  }
  for (const path of Object.keys(legacy).sort()) {
    if (path.length === 0 || path.length > 512) fail("$.extensions.legacy", "field paths must be 1-512 characters long");
    const segments = decodeJsonPointer(path);
    if (segments.some((segment) => UNSAFE_KEYS.has(segment))) {
      fail(`$.extensions.legacy.${path}`, "contains an unsafe path segment");
    }
    if (segments.some(isSecretLikeKey)) {
      fail(`$.extensions.legacy.${path}`, "secret-like extension paths are not preserved");
    }
    validated[path] = cloneExtensionJsonValue(legacy[path], `$.extensions.legacy.${path}`, 1, budget);
  }
  const normalized = { legacy: validated };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > EXTENSION_MAX_BYTES) {
    fail("$.extensions", `must not exceed ${EXTENSION_MAX_BYTES} serialized bytes`);
  }
  return normalized;
}
function asString(value, path, min = 0, max = 4096) {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length < min || value.length > max) fail(path, `must be ${min}-${max} characters long`);
  return value;
}
function asBoolean(value, path, allowLegacyScalars) {
  if (typeof value === "boolean") return value;
  if (allowLegacyScalars) {
    const parsed = parseBoolean(value);
    if (parsed !== void 0) return parsed;
  }
  fail(path, "must be a boolean");
}
function asNumber(value, path, allowLegacyScalars, min, max, integer = true) {
  let normalized = value;
  if (allowLegacyScalars && typeof normalized === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    normalized = Number(normalized);
  }
  if (typeof normalized !== "number" || !Number.isFinite(normalized)) {
    fail(path, "must be a finite number");
  }
  if (integer && !Number.isSafeInteger(normalized)) fail(path, "must be a safe integer");
  if (normalized < min || normalized > max) fail(path, `must be between ${min} and ${max}`);
  return normalized;
}
function asOneBotId(value, path, allowLegacyScalars, allowZero = false) {
  if (!allowLegacyScalars && typeof value !== "string") fail(path, "must be a canonical decimal string");
  const normalized = normalizeOneBotId(value, { allowZero });
  if (normalized === null) fail(path, "must be an unsigned 64-bit decimal identifier");
  if (!allowLegacyScalars && normalized !== value) fail(path, "must use canonical decimal form without leading zeros");
  return normalized;
}
function asStringArray(value, path, maxItems = 100, maxItemLength = 1024) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > maxItems) fail(path, `must contain at most ${maxItems} entries`);
  return value.map((entry, index) => asString(entry, `${path}[${index}]`, 0, maxItemLength));
}
function assertUrl(value, path, allowedProtocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(path, "must be an absolute URL");
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    fail(path, `must use one of: ${allowedProtocols.join(", ")}`);
  }
  if (parsed.username || parsed.password) fail(path, "must not contain credentials");
}
function assertSafeRegularExpression(pattern, path = "pattern") {
  if (pattern.length === 0 || pattern.length > 512) {
    fail(path, "must be 1-512 characters long");
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    fail(path, `is not a valid regular expression (${String(error)})`);
  }
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    fail(path, "contains a nested quantifier");
  }
  if (/(?:\.\*|\.\+).{0,16}(?:\.\*|\.\+)/.test(pattern)) {
    fail(path, "contains repeated broad quantifiers");
  }
  if (hasAmbiguousQuantifiedAlternation(pattern)) {
    fail(path, "contains an ambiguous quantified alternation");
  }
}
function assertTimezone(timezone, path) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    fail(path, "must be a valid IANA timezone");
  }
}
function assertDuration(value, path) {
  if (!/^\d+(?:s|m|h|d)$/.test(value)) fail(path, "must use a positive <number>s|m|h|d duration");
  const amount = Number(value.slice(0, -1));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 3650) {
    fail(path, "is outside the supported duration range");
  }
}
function assertClock(value, path) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(path, "must use HH:MM 24-hour time");
}
function assertApprovalAction(value, path) {
  if (!APPROVAL_ACTIONS.has(value)) {
    fail(path, `must be one of: ${[...APPROVAL_ACTIONS].join(", ")}`);
  }
}
function assertRiskAction(value, path) {
  if (!RISK_ACTIONS.has(value)) {
    fail(path, `must be one of: ${[...RISK_ACTIONS].join(", ")}`);
  }
}
function cloneJsonValue(value, path = "$", depth = 0, budget = { active: /* @__PURE__ */ new WeakSet(), entries: 0 }) {
  if (value === null || typeof value !== "object") return value;
  if (depth > CONFIG_CLONE_MAX_DEPTH) fail(path, `must not exceed ${CONFIG_CLONE_MAX_DEPTH} levels`);
  if (budget.active.has(value)) fail(path, "must not contain circular references");
  budget.active.add(value);
  if (Array.isArray(value)) {
    budget.entries += value.length;
    if (budget.entries > CONFIG_CLONE_MAX_ENTRIES) {
      fail(path, `must not exceed ${CONFIG_CLONE_MAX_ENTRIES} aggregate entries`);
    }
    const result2 = value.map((entry, index) => cloneJsonValue(entry, `${path}[${index}]`, depth + 1, budget));
    budget.active.delete(value);
    return result2;
  }
  const result = {};
  const source = value;
  const keys = Object.keys(source);
  budget.entries += keys.length;
  if (budget.entries > CONFIG_CLONE_MAX_ENTRIES) {
    fail(path, `must not exceed ${CONFIG_CLONE_MAX_ENTRIES} aggregate entries`);
  }
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) fail("$", `contains unsafe key ${JSON.stringify(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) fail(`${path}.${key}`, "must be a plain data property");
    result[key] = cloneJsonValue(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
  budget.active.delete(value);
  return result;
}
function mergeConfigValues(target, source) {
  if (source === void 0) return cloneJsonValue(target);
  if (source === null) return null;
  if (typeof source !== "object" || Array.isArray(source)) return cloneJsonValue(source);
  if (typeof target !== "object" || target === null || Array.isArray(target)) return cloneJsonValue(source);
  const result = cloneJsonValue(target);
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS.has(key)) fail("$", `contains unsafe key ${JSON.stringify(key)}`);
    result[key] = mergeConfigValues(result[key], value);
  }
  return result;
}
function captureUnknownFields(record2, allowed, displayPath, pointer, preserved) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record2)) {
    if (UNSAFE_KEYS.has(key)) fail(displayPath, `contains unsafe key ${JSON.stringify(key)}`);
    if (allowedKeys.has(key)) continue;
    const path = appendJsonPointer(pointer, key);
    preserved[path] = record2[key];
    delete record2[key];
  }
}
function captureLegacyConfigExtensions(candidate) {
  const preserved = /* @__PURE__ */ Object.create(null);
  const defaults = buildDefaults();
  captureUnknownFields(candidate, Object.keys(defaults), "config", "/config", preserved);
  const sections = [
    ["core", ["selfId", "superAdmins", "timezone"]],
    ["webui", ["jwtSecret", "jwtExpiresIn", "refreshExpiresIn"]],
    ["approval", [
      "defaultAction",
      "groups",
      "pendingTtlSeconds",
      "defaultGroupEnabled",
      "useBuiltinRejectKeywords",
      "useBuiltinApproveKeywords",
      "realtimeSyncEnabled",
      "syncIntervalSeconds"
    ]],
    ["captcha", ["ttlSeconds", "maxAttempts", "types", "questions"]],
    ["risk", [
      "enabled",
      "detectorActions",
      "muteDurationSeconds",
      "aiMinScore",
      "recallMessage",
      ...RETIRED_RISK_FIELDS
    ]],
    ["punishment", ["defaultMuteDurationSeconds", "escalateToKickAfter", "escalateToBlacklistAfter"]],
    ["blacklist", ["autoKickOnJoin"]],
    ["auth", ["maxLoginAttempts", "lockoutSeconds", "rateLimitRequests", "rateLimitWindowMs"]],
    ["monitor", ["intervalMs", "diskAlertMb", "memoryAlertPercent"]],
    ["update", ["githubRepo", "autoCheckOnStartup"]],
    ["ai", ["provider", "baseUrl", "apiKey", "model", "timeoutMs", "riskPrompt"]],
    ["commands", ["enabled", "prefix"]],
    ["intel", ["enabled", "enforcementMode", "feedUrls", "feedPins", "refreshIntervalSeconds"]]
  ];
  for (const [section, allowed] of sections) {
    if (candidate[section] === void 0) continue;
    const record2 = asRecord(candidate[section], `config.${section}`);
    captureUnknownFields(record2, allowed, `config.${section}`, `/config/${section}`, preserved);
  }
  const approval = candidate.approval;
  if (approval?.groups !== void 0) {
    const groups = asRecord(approval.groups, "config.approval.groups");
    const groupDefaults = [
      "enabled",
      "action",
      "approveKeywords",
      "rejectKeywords",
      "approvePatterns",
      "rejectPatterns",
      "rejectReason",
      "riskEnabled",
      "autoKickBlacklisted",
      "notifyOnRisk",
      "notifyOnJoin",
      "groupName",
      "welcomeEnabled",
      "welcomeTemplate",
      "curfewEnabled",
      "curfewStart",
      "curfewEnd"
    ];
    for (const [groupId, value] of Object.entries(groups)) {
      const group = asRecord(value, `config.approval.groups.${groupId}`);
      captureUnknownFields(
        group,
        groupDefaults,
        `config.approval.groups.${groupId}`,
        `/config/approval/groups/${escapeJsonPointerSegment(groupId)}`,
        preserved
      );
    }
  }
  const captcha = candidate.captcha;
  if (captcha?.questions !== void 0 && Array.isArray(captcha.questions)) {
    captcha.questions.forEach((value, index) => {
      const question = asRecord(value, `config.captcha.questions[${index}]`);
      captureUnknownFields(
        question,
        ["q", "a"],
        `config.captcha.questions[${index}]`,
        `/config/captcha/questions/${index}`,
        preserved
      );
    });
  }
  const risk = candidate.risk;
  if (risk?.detectorActions !== void 0) {
    const detectorActions = asRecord(risk.detectorActions, "config.risk.detectorActions");
    captureUnknownFields(
      detectorActions,
      Object.keys(defaults.risk.detectorActions),
      "config.risk.detectorActions",
      "/config/risk/detectorActions",
      preserved
    );
  }
  if (risk?.detectors !== void 0) {
    const detectors = asRecord(risk.detectors, "config.risk.detectors");
    captureUnknownFields(
      detectors,
      Object.keys(defaults.risk.detectorActions),
      "config.risk.detectors",
      "/config/risk/detectors",
      preserved
    );
  }
  if (Object.keys(preserved).length === 0) return void 0;
  return validateConfigExtensions({ legacy: preserved });
}
function normalizeGroupConfig(value, groupId, config, allowLegacyScalars) {
  if (normalizeOneBotId(groupId) !== groupId) {
    fail(`config.approval.groups.${JSON.stringify(groupId)}`, "must be keyed by a positive QQ group ID");
  }
  const group = asRecord(value, `config.approval.groups.${groupId}`);
  const defaultGroup = {
    enabled: config.approval.defaultGroupEnabled,
    action: config.approval.defaultAction,
    approveKeywords: [],
    rejectKeywords: [],
    approvePatterns: [],
    rejectPatterns: [],
    rejectReason: "\u4E0D\u7B26\u5408\u5165\u7FA4\u8981\u6C42",
    riskEnabled: config.risk.enabled,
    autoKickBlacklisted: config.blacklist.autoKickOnJoin,
    notifyOnRisk: false,
    notifyOnJoin: false,
    groupName: "",
    welcomeEnabled: false,
    welcomeTemplate: "",
    curfewEnabled: false,
    curfewStart: "23:00",
    curfewEnd: "07:00"
  };
  const candidate = mergeConfigValues(defaultGroup, group);
  assertKnownKeys(candidate, Object.keys(defaultGroup), `config.approval.groups.${groupId}`);
  const action = asString(candidate.action, `config.approval.groups.${groupId}.action`, 1, 32);
  assertApprovalAction(action, `config.approval.groups.${groupId}.action`);
  const approvePatterns = asStringArray(candidate.approvePatterns, `config.approval.groups.${groupId}.approvePatterns`, 100, 512);
  const rejectPatterns = asStringArray(candidate.rejectPatterns, `config.approval.groups.${groupId}.rejectPatterns`, 100, 512);
  approvePatterns.forEach((pattern, index) => assertSafeRegularExpression(pattern, `config.approval.groups.${groupId}.approvePatterns[${index}]`));
  rejectPatterns.forEach((pattern, index) => assertSafeRegularExpression(pattern, `config.approval.groups.${groupId}.rejectPatterns[${index}]`));
  const curfewStart = asString(candidate.curfewStart, `config.approval.groups.${groupId}.curfewStart`, 5, 5);
  const curfewEnd = asString(candidate.curfewEnd, `config.approval.groups.${groupId}.curfewEnd`, 5, 5);
  assertClock(curfewStart, `config.approval.groups.${groupId}.curfewStart`);
  assertClock(curfewEnd, `config.approval.groups.${groupId}.curfewEnd`);
  return {
    enabled: asBoolean(candidate.enabled, `config.approval.groups.${groupId}.enabled`, allowLegacyScalars),
    action,
    approveKeywords: asStringArray(candidate.approveKeywords, `config.approval.groups.${groupId}.approveKeywords`),
    rejectKeywords: asStringArray(candidate.rejectKeywords, `config.approval.groups.${groupId}.rejectKeywords`),
    approvePatterns,
    rejectPatterns,
    rejectReason: asString(candidate.rejectReason, `config.approval.groups.${groupId}.rejectReason`, 0, 512),
    riskEnabled: asBoolean(candidate.riskEnabled, `config.approval.groups.${groupId}.riskEnabled`, allowLegacyScalars),
    autoKickBlacklisted: asBoolean(candidate.autoKickBlacklisted, `config.approval.groups.${groupId}.autoKickBlacklisted`, allowLegacyScalars),
    notifyOnRisk: asBoolean(candidate.notifyOnRisk, `config.approval.groups.${groupId}.notifyOnRisk`, allowLegacyScalars),
    notifyOnJoin: asBoolean(candidate.notifyOnJoin, `config.approval.groups.${groupId}.notifyOnJoin`, allowLegacyScalars),
    groupName: asString(candidate.groupName, `config.approval.groups.${groupId}.groupName`, 0, 256),
    welcomeEnabled: asBoolean(candidate.welcomeEnabled, `config.approval.groups.${groupId}.welcomeEnabled`, allowLegacyScalars),
    welcomeTemplate: asString(candidate.welcomeTemplate, `config.approval.groups.${groupId}.welcomeTemplate`, 0, 4096),
    curfewEnabled: asBoolean(candidate.curfewEnabled, `config.approval.groups.${groupId}.curfewEnabled`, allowLegacyScalars),
    curfewStart,
    curfewEnd
  };
}
function normalizeConfig(value, allowLegacyScalars) {
  const config = asRecord(value, "config");
  const defaults = buildDefaults();
  assertKnownKeys(config, Object.keys(defaults), "config");
  for (const key of Object.keys(defaults)) {
    if (!(key in config)) fail("config", `is missing required section ${JSON.stringify(key)}`);
  }
  const core = asRecord(config.core, "config.core");
  assertKnownKeys(core, ["selfId", "superAdmins", "timezone"], "config.core");
  const selfId = asOneBotId(core.selfId, "config.core.selfId", allowLegacyScalars, true);
  if (!Array.isArray(core.superAdmins)) fail("config.core.superAdmins", "must be an array");
  if (core.superAdmins.length > 100) fail("config.core.superAdmins", "must contain at most 100 entries");
  const superAdmins = core.superAdmins.map(
    (id, index) => asOneBotId(id, `config.core.superAdmins[${index}]`, allowLegacyScalars)
  );
  if (new Set(superAdmins).size !== superAdmins.length) fail("config.core.superAdmins", "must not contain duplicates");
  const timezone = asString(core.timezone, "config.core.timezone", 1, 128);
  assertTimezone(timezone, "config.core.timezone");
  const webui = asRecord(config.webui, "config.webui");
  assertKnownKeys(webui, ["jwtSecret", "jwtExpiresIn", "refreshExpiresIn"], "config.webui");
  const jwtSecret = asString(webui.jwtSecret, "config.webui.jwtSecret", 16, 512);
  const jwtExpiresIn = asString(webui.jwtExpiresIn, "config.webui.jwtExpiresIn", 2, 16);
  const refreshExpiresIn = asString(webui.refreshExpiresIn, "config.webui.refreshExpiresIn", 2, 16);
  assertDuration(jwtExpiresIn, "config.webui.jwtExpiresIn");
  assertDuration(refreshExpiresIn, "config.webui.refreshExpiresIn");
  const approval = asRecord(config.approval, "config.approval");
  assertKnownKeys(approval, [
    "defaultAction",
    "groups",
    "pendingTtlSeconds",
    "defaultGroupEnabled",
    "useBuiltinRejectKeywords",
    "useBuiltinApproveKeywords",
    "realtimeSyncEnabled",
    "syncIntervalSeconds"
  ], "config.approval");
  const defaultAction = asString(approval.defaultAction, "config.approval.defaultAction", 1, 32);
  assertApprovalAction(defaultAction, "config.approval.defaultAction");
  const approvalBase = {
    defaultAction,
    groups: {},
    pendingTtlSeconds: asNumber(approval.pendingTtlSeconds, "config.approval.pendingTtlSeconds", allowLegacyScalars, 60, 7 * 24 * 60 * 60),
    defaultGroupEnabled: asBoolean(approval.defaultGroupEnabled, "config.approval.defaultGroupEnabled", allowLegacyScalars),
    useBuiltinRejectKeywords: asBoolean(approval.useBuiltinRejectKeywords, "config.approval.useBuiltinRejectKeywords", allowLegacyScalars),
    useBuiltinApproveKeywords: asBoolean(approval.useBuiltinApproveKeywords, "config.approval.useBuiltinApproveKeywords", allowLegacyScalars),
    realtimeSyncEnabled: asBoolean(approval.realtimeSyncEnabled, "config.approval.realtimeSyncEnabled", allowLegacyScalars),
    syncIntervalSeconds: asNumber(approval.syncIntervalSeconds, "config.approval.syncIntervalSeconds", allowLegacyScalars, 10, 24 * 60 * 60)
  };
  const captcha = asRecord(config.captcha, "config.captcha");
  assertKnownKeys(captcha, ["ttlSeconds", "maxAttempts", "types", "questions"], "config.captcha");
  if (!Array.isArray(captcha.types) || captcha.types.length === 0 || captcha.types.length > CAPTCHA_TYPES.size) {
    fail("config.captcha.types", "must contain one or more supported types");
  }
  const captchaTypes = captcha.types.map((type, index) => {
    const normalized2 = asString(type, `config.captcha.types[${index}]`, 1, 16);
    if (!CAPTCHA_TYPES.has(normalized2)) fail(`config.captcha.types[${index}]`, "is not supported");
    return normalized2;
  });
  if (new Set(captchaTypes).size !== captchaTypes.length) fail("config.captcha.types", "must not contain duplicates");
  if (!Array.isArray(captcha.questions) || captcha.questions.length > 100) fail("config.captcha.questions", "must contain at most 100 entries");
  const questions = captcha.questions.map((question, index) => {
    const entry = asRecord(question, `config.captcha.questions[${index}]`);
    assertKnownKeys(entry, ["q", "a"], `config.captcha.questions[${index}]`);
    return {
      q: asString(entry.q, `config.captcha.questions[${index}].q`, 1, 512),
      a: asString(entry.a, `config.captcha.questions[${index}].a`, 1, 512)
    };
  });
  const risk = asRecord(config.risk, "config.risk");
  const detectorKeys = Object.keys(defaults.risk.detectorActions);
  assertKnownKeys(risk, ["enabled", "detectorActions", "muteDurationSeconds", "aiMinScore", "recallMessage"], "config.risk");
  const detectorActionsRaw = asRecord(risk.detectorActions, "config.risk.detectorActions");
  assertKnownKeys(detectorActionsRaw, detectorKeys, "config.risk.detectorActions");
  for (const key of detectorKeys) {
    if (!(key in detectorActionsRaw)) fail("config.risk.detectorActions", `is missing ${JSON.stringify(key)}`);
  }
  const detectorActions = Object.fromEntries(detectorKeys.map((key) => {
    const action = asString(detectorActionsRaw[key], `config.risk.detectorActions.${key}`, 1, 32);
    assertRiskAction(action, `config.risk.detectorActions.${key}`);
    return [key, action];
  }));
  const punishment = asRecord(config.punishment, "config.punishment");
  assertKnownKeys(punishment, ["defaultMuteDurationSeconds", "escalateToKickAfter", "escalateToBlacklistAfter"], "config.punishment");
  const blacklist = asRecord(config.blacklist, "config.blacklist");
  assertKnownKeys(blacklist, ["autoKickOnJoin"], "config.blacklist");
  const auth = asRecord(config.auth, "config.auth");
  assertKnownKeys(auth, ["maxLoginAttempts", "lockoutSeconds", "rateLimitRequests", "rateLimitWindowMs"], "config.auth");
  const monitor = asRecord(config.monitor, "config.monitor");
  assertKnownKeys(monitor, ["intervalMs", "diskAlertMb", "memoryAlertPercent"], "config.monitor");
  const update = asRecord(config.update, "config.update");
  assertKnownKeys(update, ["githubRepo", "autoCheckOnStartup"], "config.update");
  const githubRepo = asString(update.githubRepo, "config.update.githubRepo", 3, 256);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) fail("config.update.githubRepo", "must use owner/repository format");
  const ai = asRecord(config.ai, "config.ai");
  assertKnownKeys(ai, ["provider", "baseUrl", "apiKey", "model", "timeoutMs", "riskPrompt"], "config.ai");
  const provider = asString(ai.provider, "config.ai.provider", 1, 32);
  if (!AI_PROVIDERS.has(provider)) fail("config.ai.provider", "is not supported");
  const baseUrl = asString(ai.baseUrl, "config.ai.baseUrl", 1, 2048);
  assertUrl(baseUrl, "config.ai.baseUrl", ["https:", "http:"]);
  const commands = asRecord(config.commands, "config.commands");
  assertKnownKeys(commands, ["enabled", "prefix"], "config.commands");
  const intel = asRecord(config.intel, "config.intel");
  assertKnownKeys(intel, ["enabled", "enforcementMode", "feedUrls", "feedPins", "refreshIntervalSeconds"], "config.intel");
  const rawFeedUrls = asStringArray(intel.feedUrls, "config.intel.feedUrls", 20, 2048);
  rawFeedUrls.forEach((url, index) => assertUrl(url, `config.intel.feedUrls[${index}]`, ["https:"]));
  const feedUrls = normalizeIntelFeedUrls(rawFeedUrls);
  const enforcementMode = asString(
    intel.enforcementMode,
    "config.intel.enforcementMode",
    1,
    16
  );
  if (!INTEL_ENFORCEMENT_MODES.has(enforcementMode)) {
    fail("config.intel.enforcementMode", "must be observe or enforce");
  }
  const rawFeedPins = asRecord(intel.feedPins, "config.intel.feedPins");
  if (Object.keys(rawFeedPins).length > 20) fail("config.intel.feedPins", "must contain at most 20 entries");
  const feedPins = {};
  const configuredFeeds = new Set(feedUrls);
  for (const [rawUrl, rawDigest] of Object.entries(rawFeedPins)) {
    if (UNSAFE_KEYS.has(rawUrl)) fail("config.intel.feedPins", `contains unsafe key ${JSON.stringify(rawUrl)}`);
    assertUrl(rawUrl, `config.intel.feedPins.${rawUrl}`, ["https:"]);
    const [url] = normalizeIntelFeedUrls([rawUrl]);
    if (!url || !configuredFeeds.has(url)) {
      fail(`config.intel.feedPins.${rawUrl}`, "must identify a configured feed URL");
    }
    if (feedPins[url] !== void 0) {
      fail(`config.intel.feedPins.${rawUrl}`, "duplicates a canonical feed URL");
    }
    const digest = asString(rawDigest, `config.intel.feedPins.${rawUrl}`, 64, 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      fail(`config.intel.feedPins.${rawUrl}`, "must be a SHA-256 hex digest");
    }
    feedPins[url] = digest;
  }
  if (enforcementMode === "enforce") {
    for (const url of feedUrls) {
      if (!feedPins[url]) fail("config.intel.feedPins", `must pin ${JSON.stringify(url)} before enforcement`);
    }
  }
  const normalized = {
    core: { selfId, superAdmins, timezone },
    webui: { jwtSecret, jwtExpiresIn, refreshExpiresIn },
    approval: approvalBase,
    captcha: {
      ttlSeconds: asNumber(captcha.ttlSeconds, "config.captcha.ttlSeconds", allowLegacyScalars, 30, 24 * 60 * 60),
      maxAttempts: asNumber(captcha.maxAttempts, "config.captcha.maxAttempts", allowLegacyScalars, 1, 20),
      types: captchaTypes,
      questions
    },
    risk: {
      enabled: asBoolean(risk.enabled, "config.risk.enabled", allowLegacyScalars),
      detectorActions,
      muteDurationSeconds: asNumber(risk.muteDurationSeconds, "config.risk.muteDurationSeconds", allowLegacyScalars, 1, 30 * 24 * 60 * 60),
      aiMinScore: asNumber(risk.aiMinScore, "config.risk.aiMinScore", allowLegacyScalars, 0, 100),
      recallMessage: asBoolean(risk.recallMessage, "config.risk.recallMessage", allowLegacyScalars)
    },
    punishment: {
      defaultMuteDurationSeconds: asNumber(punishment.defaultMuteDurationSeconds, "config.punishment.defaultMuteDurationSeconds", allowLegacyScalars, 1, 30 * 24 * 60 * 60),
      escalateToKickAfter: asNumber(punishment.escalateToKickAfter, "config.punishment.escalateToKickAfter", allowLegacyScalars, 0, 1e3),
      escalateToBlacklistAfter: asNumber(punishment.escalateToBlacklistAfter, "config.punishment.escalateToBlacklistAfter", allowLegacyScalars, 0, 1e3)
    },
    blacklist: { autoKickOnJoin: asBoolean(blacklist.autoKickOnJoin, "config.blacklist.autoKickOnJoin", allowLegacyScalars) },
    auth: {
      maxLoginAttempts: asNumber(auth.maxLoginAttempts, "config.auth.maxLoginAttempts", allowLegacyScalars, 1, 100),
      lockoutSeconds: asNumber(auth.lockoutSeconds, "config.auth.lockoutSeconds", allowLegacyScalars, 1, 30 * 24 * 60 * 60),
      rateLimitRequests: asNumber(auth.rateLimitRequests, "config.auth.rateLimitRequests", allowLegacyScalars, 1, 1e5),
      rateLimitWindowMs: asNumber(auth.rateLimitWindowMs, "config.auth.rateLimitWindowMs", allowLegacyScalars, 1e3, 24 * 60 * 60 * 1e3)
    },
    monitor: {
      intervalMs: asNumber(monitor.intervalMs, "config.monitor.intervalMs", allowLegacyScalars, 1e3, 24 * 60 * 60 * 1e3),
      diskAlertMb: asNumber(monitor.diskAlertMb, "config.monitor.diskAlertMb", allowLegacyScalars, 0, 1e7),
      memoryAlertPercent: asNumber(monitor.memoryAlertPercent, "config.monitor.memoryAlertPercent", allowLegacyScalars, 1, 100)
    },
    update: { githubRepo, autoCheckOnStartup: asBoolean(update.autoCheckOnStartup, "config.update.autoCheckOnStartup", allowLegacyScalars) },
    ai: {
      provider,
      baseUrl,
      apiKey: asString(ai.apiKey, "config.ai.apiKey", 0, 4096),
      model: asString(ai.model, "config.ai.model", 1, 256),
      timeoutMs: asNumber(ai.timeoutMs, "config.ai.timeoutMs", allowLegacyScalars, 1e3, 12e4),
      riskPrompt: asString(ai.riskPrompt, "config.ai.riskPrompt", 1, 16384)
    },
    commands: {
      enabled: asBoolean(commands.enabled, "config.commands.enabled", allowLegacyScalars),
      prefix: asString(commands.prefix, "config.commands.prefix", 1, 64)
    },
    intel: {
      enabled: asBoolean(intel.enabled, "config.intel.enabled", allowLegacyScalars),
      enforcementMode,
      feedUrls,
      feedPins,
      refreshIntervalSeconds: asNumber(intel.refreshIntervalSeconds, "config.intel.refreshIntervalSeconds", allowLegacyScalars, 60, 24 * 60 * 60)
    }
  };
  const rawGroups = asRecord(approval.groups, "config.approval.groups");
  const normalizedGroups = {};
  for (const [rawGroupId, group] of Object.entries(rawGroups)) {
    const groupId = asOneBotId(rawGroupId, `config.approval.groups.${JSON.stringify(rawGroupId)}`, allowLegacyScalars);
    if (normalizedGroups[groupId] !== void 0) {
      fail("config.approval.groups", `contains duplicate canonical group ID ${groupId}`);
    }
    normalizedGroups[groupId] = normalizeGroupConfig(group, groupId, normalized, allowLegacyScalars);
  }
  normalized.approval.groups = normalizedGroups;
  return normalized;
}
function validateCanonicalConfig(config) {
  return normalizeConfig(config, false);
}
function validateCanonicalConfigFile(value) {
  const file = asRecord(value, "$");
  assertKnownKeys(file, ["schemaVersion", "config", "extensions"], "$");
  if (file.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    fail("$.schemaVersion", `must equal ${CONFIG_SCHEMA_VERSION}; run the staged migration first`);
  }
  const config = validateCanonicalConfig(file.config);
  const extensions = file.extensions === void 0 ? void 0 : validateConfigExtensions(file.extensions);
  return extensions === void 0 ? { schemaVersion: CONFIG_SCHEMA_VERSION, config } : { schemaVersion: CONFIG_SCHEMA_VERSION, config, extensions };
}
async function validatePersistedApprovalPatterns(config) {
  const entries = Object.entries(config.approval.groups).flatMap(([groupId, group]) => [
    ...group.approvePatterns.map((pattern, index) => ({
      pattern,
      path: `config.approval.groups.${groupId}.approvePatterns[${index}]`
    })),
    ...group.rejectPatterns.map((pattern, index) => ({
      pattern,
      path: `config.approval.groups.${groupId}.rejectPatterns[${index}]`
    }))
  ]);
  for (const { pattern, path } of entries) assertSafeRegularExpression(pattern, path);
  const verdicts = await probePatternsInWorkers(entries.map(({ pattern }) => pattern));
  for (const { pattern, path } of entries) {
    if (!verdicts.get(pattern)) fail(path, "failed performance test (possible ReDoS)");
  }
}
function migrateLegacyConfig(value) {
  const source = asRecord(value, "$");
  const wrapped = "config" in source;
  const versionValue = wrapped ? source.schemaVersion : 0;
  const sourceVersion = versionValue === void 0 ? 0 : asNumber(versionValue, "$.schemaVersion", true, 0, CONFIG_SCHEMA_VERSION, true);
  if (sourceVersion > CONFIG_SCHEMA_VERSION) {
    fail("$.schemaVersion", `cannot migrate newer schema ${sourceVersion}`);
  }
  if (wrapped && sourceVersion === CONFIG_SCHEMA_VERSION) {
    const file2 = validateCanonicalConfigFile(value);
    return {
      file: file2,
      retiredFields: [],
      preservedFields: Object.keys(file2.extensions?.legacy ?? {}).sort()
    };
  }
  const sourceEnvelope = cloneJsonValue(source);
  const wrapperExtensions = /* @__PURE__ */ Object.create(null);
  if (wrapped) captureUnknownFields(sourceEnvelope, ["schemaVersion", "config"], "$", "", wrapperExtensions);
  const sourceConfig = asRecord(wrapped ? sourceEnvelope.config : sourceEnvelope, wrapped ? "$.config" : "$");
  const rawRisk = sourceConfig.risk === void 0 ? void 0 : asRecord(sourceConfig.risk, "config.risk");
  const retiredFields = [];
  let candidateSource = cloneJsonValue(sourceConfig);
  const configExtensions = captureLegacyConfigExtensions(candidateSource);
  const legacyExtensions = {
    ...wrapperExtensions,
    ...configExtensions?.legacy ?? {}
  };
  const extensions = Object.keys(legacyExtensions).length === 0 ? void 0 : validateConfigExtensions({ legacy: legacyExtensions });
  if (rawRisk) {
    const candidateRisk = asRecord(candidateSource.risk, "config.risk");
    const detectors = candidateRisk.detectors;
    if (candidateRisk.detectorActions === void 0 && detectors !== void 0) {
      const legacyDetectors = asRecord(detectors, "config.risk.detectors");
      const knownDetectors = Object.keys(buildDefaults().risk.detectorActions);
      assertKnownKeys(legacyDetectors, knownDetectors, "config.risk.detectors");
      const legacyAction = candidateRisk.action === void 0 ? "mute" : asString(candidateRisk.action, "config.risk.action", 1, 32);
      assertRiskAction(legacyAction, "config.risk.action");
      candidateRisk.detectorActions = Object.fromEntries(knownDetectors.map((detector) => [
        detector,
        asBoolean(legacyDetectors[detector] ?? false, `config.risk.detectors.${detector}`, true) ? legacyAction : "off"
      ]));
    }
    for (const field of RETIRED_RISK_FIELDS) {
      if (field in candidateRisk) {
        delete candidateRisk[field];
        retiredFields.push(`config.risk.${field}`);
      }
    }
  }
  const defaults = buildDefaults();
  const merged = mergeConfigValues(defaults, candidateSource);
  const rawGroups = asRecord(merged.approval.groups, "config.approval.groups");
  const sourceGroups = asRecord(candidateSource.approval?.groups ?? {}, "config.approval.groups");
  const globalCandidate = merged;
  const normalizedGroups = {};
  for (const [groupId, group] of Object.entries(sourceGroups)) {
    const groupRecord = asRecord(group, `config.approval.groups.${groupId}`);
    const base = {
      enabled: globalCandidate.approval.defaultGroupEnabled,
      action: globalCandidate.approval.defaultAction,
      approveKeywords: [],
      rejectKeywords: [],
      approvePatterns: [],
      rejectPatterns: [],
      rejectReason: "\u4E0D\u7B26\u5408\u5165\u7FA4\u8981\u6C42",
      riskEnabled: globalCandidate.risk.enabled,
      autoKickBlacklisted: globalCandidate.blacklist.autoKickOnJoin,
      notifyOnRisk: false,
      notifyOnJoin: false,
      groupName: "",
      welcomeEnabled: false,
      welcomeTemplate: "",
      curfewEnabled: false,
      curfewStart: "23:00",
      curfewEnd: "07:00"
    };
    normalizedGroups[groupId] = mergeConfigValues(base, groupRecord);
  }
  merged.approval.groups = Object.keys(sourceGroups).length === 0 ? rawGroups : normalizedGroups;
  const config = normalizeConfig(merged, true);
  const file = extensions === void 0 ? { schemaVersion: CONFIG_SCHEMA_VERSION, config } : { schemaVersion: CONFIG_SCHEMA_VERSION, config, extensions };
  return { file, retiredFields, preservedFields: Object.keys(extensions?.legacy ?? {}).sort() };
}
function createCanonicalConfigFile(config, extensions) {
  const validatedConfig = validateCanonicalConfig(config);
  const validatedExtensions = extensions === void 0 ? void 0 : validateConfigExtensions(extensions);
  return validatedExtensions === void 0 ? { schemaVersion: CONFIG_SCHEMA_VERSION, config: validatedConfig } : { schemaVersion: CONFIG_SCHEMA_VERSION, config: validatedConfig, extensions: validatedExtensions };
}

// src/core/events/index.ts
import { EventEmitter } from "events";
var TypedEventBus = class extends EventEmitter {
  constructor() {
    super();
    super.setMaxListeners(50);
  }
  emit(event, payload) {
    return super.emit(event, payload);
  }
  on(event, listener) {
    return super.on(event, listener);
  }
};
var bus = new TypedEventBus();

// src/core/config/index.ts
var BACKUP_DIR = "config-backups";
var BACKUP_MIN_INTERVAL_MS = 6e4;
var MAX_CONFIG_BACKUPS = 20;
function configValueEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!configValueEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left;
  const rightRecord = right;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!configValueEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}
function partialChangesConfig(base, next, partial) {
  for (const key of Object.keys(partial)) {
    if (!configValueEqual(base[key], next[key])) return true;
  }
  return false;
}
var ConfigManager = class {
  cfg;
  extensions;
  configPath;
  backupDir;
  lastBackupTs = 0;
  init(configDir) {
    this.configPath = join2(configDir, CONFIG_FILENAME);
    this.backupDir = join2(configDir, BACKUP_DIR);
    mkdirSync2(this.backupDir, { recursive: true, mode: 448 });
    try {
      chmodSync(this.backupDir, 448);
    } catch {
    }
    if (existsSync(this.configPath)) {
      this.cfg = this.load();
    } else {
      this.extensions = void 0;
      this.cfg = validateCanonicalConfig(buildDefaults());
      this.save();
    }
  }
  get() {
    return this.cfg;
  }
  update(partial) {
    const base = this.cfg;
    const next = this.buildUpdate(base, partial);
    if (!partialChangesConfig(base, next, partial)) return;
    this.commitUpdate(next);
  }
  /**
   * Validates the complete post-merge configuration asynchronously before an
   * atomic write. This is for request paths that accept untrusted values whose
   * safety checks cannot run on the event loop (notably regular expressions).
   * If another update wins while validation is in flight, recompute against
   * that new generation rather than persisting an unvalidated merge.
   */
  async updateValidated(partial, validate) {
    for (; ; ) {
      const base = this.cfg;
      const next = this.buildUpdate(base, partial);
      if (!partialChangesConfig(base, next, partial)) return;
      await validate(next);
      if (this.cfg !== base) continue;
      this.commitUpdate(next);
      return;
    }
  }
  buildUpdate(base, partial) {
    return validateCanonicalConfig(mergeConfigValues(base, partial));
  }
  commitUpdate(next) {
    this.backup();
    this.cfg = next;
    this.save();
    bus.emit("ConfigChanged", { section: "config", timestamp: Date.now() });
  }
  load() {
    const raw = readFileSync(this.configPath, "utf8");
    const file = validateCanonicalConfigFile(JSON.parse(raw));
    this.extensions = file.extensions;
    return file.config;
  }
  /** Writes a complete canonical file beside the old one before replacement. */
  save() {
    const tmp = `${this.configPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(createCanonicalConfigFile(this.cfg, this.extensions), null, 2), {
        encoding: "utf8",
        mode: 384
      });
      renameSync(tmp, this.configPath);
      try {
        chmodSync(this.configPath, 384);
      } catch {
      }
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
      }
      throw error;
    }
  }
  backup() {
    const now = Date.now();
    if (now - this.lastBackupTs < BACKUP_MIN_INTERVAL_MS || !existsSync(this.configPath)) return;
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    try {
      copyFileSync(this.configPath, join2(this.backupDir, `config-${timestamp}.json`));
      this.lastBackupTs = now;
      this.pruneBackups();
    } catch {
    }
  }
  pruneBackups() {
    const backups = readdirSync(this.backupDir).filter((name) => /^config-.*\.json$/.test(name)).sort();
    const excess = backups.length - MAX_CONFIG_BACKUPS;
    for (const name of excess > 0 ? backups.slice(0, excess) : []) {
      try {
        unlinkSync(join2(this.backupDir, name));
      } catch {
      }
    }
  }
};
var configManager = new ConfigManager();

// src/core/locks.ts
var _locks = /* @__PURE__ */ new Map();
async function withLock(name, fn) {
  let release;
  const current = new Promise((resolve4) => {
    release = resolve4;
  });
  const previous = _locks.get(name);
  _locks.set(name, current);
  if (previous) await previous;
  try {
    return await fn();
  } finally {
    release();
    if (_locks.get(name) === current) _locks.delete(name);
  }
}
async function tryWithLock(name, fn) {
  if (_locks.has(name)) return { acquired: false };
  return { acquired: true, value: await withLock(name, fn) };
}
var locks = {
  /** One approval action at a time per join-request flag */
  approval: (flag) => `approval:${flag}`,
  /** One punishment at a time per user-group pair */
  punishment: (groupId, userId) => `punishment:${groupId}:${userId}`,
  /** One captcha state transition at a time per approval record. */
  captcha: (approvalId) => `captcha:${approvalId}`,
  /** Serialize captcha issuance and active-session limits per user. */
  captchaUser: (userId) => `captcha-user:${userId}`,
  /** One ordered admission pipeline at a time per user-group pair. */
  memberJoin: (groupId, userId) => `member-join:${groupId}:${userId}`,
  /** One update at a time globally */
  update: () => "update:global"
};

// src/database/repositories/statistics.ts
var STAT_FIELDS = /* @__PURE__ */ new Set([
  "approvals_total",
  "approvals_passed",
  "approvals_rejected",
  "captchas_total",
  "captchas_passed",
  "punishments_total",
  "risk_detections"
]);
var StatisticsRepository = class {
  // In-memory set of "group:period" pairs already confirmed to have a DB row.
  // Avoids a SELECT + conditional INSERT on every increment() call.
  // Cleared when the date rolls over so the new day's rows are created fresh.
  _ensuredPeriod = "";
  _ensuredKeys = /* @__PURE__ */ new Set();
  _databaseGeneration = -1;
  todayPeriod() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  }
  ensureSnapshot(groupId, period) {
    const generation2 = getDatabaseGeneration();
    if (generation2 !== this._databaseGeneration) {
      this._ensuredKeys.clear();
      this._ensuredPeriod = "";
      this._databaseGeneration = generation2;
    }
    if (period !== this._ensuredPeriod) {
      this._ensuredKeys.clear();
      this._ensuredPeriod = period;
    }
    const key = groupId === null ? "\0" : String(groupId);
    if (this._ensuredKeys.has(key)) return;
    const db = getDatabase();
    const existing = groupId === null ? db.prepare("SELECT 1 FROM stat_snapshots WHERE group_id IS NULL AND period = ?").get(period) : db.prepare("SELECT 1 FROM stat_snapshots WHERE group_id = ? AND period = ?").get(groupId, period);
    if (!existing) {
      db.prepare(
        `INSERT INTO stat_snapshots (group_id, period, created_at) VALUES (?, ?, ?)`
      ).run(groupId, period, Date.now());
    }
    this._ensuredKeys.add(key);
  }
  /** Increments the per-group counter AND the global (group_id NULL) one —
   *  the pairing every call site wants. */
  bump(groupId, field) {
    this.increment(groupId, field);
    this.increment(null, field);
  }
  increment(groupId, field, amount = 1) {
    if (!STAT_FIELDS.has(field)) throw new Error(`Invalid stat field: ${field}`);
    const period = this.todayPeriod();
    this.ensureSnapshot(groupId, period);
    getDatabase().prepare(
      `UPDATE stat_snapshots SET ${field} = ${field} + ?
         WHERE group_id ${groupId === null ? "IS NULL" : "= ?"} AND period = ?`
    ).run(...[amount, ...groupId !== null ? [groupId] : [], period]);
  }
  findByPeriod(period, groupId) {
    if (groupId !== void 0) {
      return getDatabase().prepare("SELECT * FROM stat_snapshots WHERE period = ? AND group_id = ?").all(period, groupId);
    }
    return getDatabase().prepare("SELECT * FROM stat_snapshots WHERE period = ?").all(period);
  }
  findRecent(days = 30, groupId) {
    const periods = Array.from({ length: days }, (_, i) => {
      const d = /* @__PURE__ */ new Date();
      d.setDate(d.getDate() - i);
      return d.toISOString().slice(0, 10);
    });
    const placeholders = periods.map(() => "?").join(",");
    if (groupId !== void 0) {
      return getDatabase().prepare(
        `SELECT * FROM stat_snapshots
           WHERE period IN (${placeholders}) AND group_id = ?
           ORDER BY period DESC`
      ).all(...[...periods, groupId]);
    }
    return getDatabase().prepare(
      `SELECT * FROM stat_snapshots
         WHERE period IN (${placeholders}) AND group_id IS NULL
         ORDER BY period DESC`
    ).all(...periods);
  }
  totals(groupId) {
    const where = groupId !== void 0 ? "WHERE group_id = ?" : "WHERE group_id IS NULL";
    const params = groupId !== void 0 ? [groupId] : [];
    const row = getDatabase().prepare(
      `SELECT
           SUM(approvals_total)    as approvals_total,
           SUM(approvals_passed)   as approvals_passed,
           SUM(approvals_rejected) as approvals_rejected,
           SUM(captchas_total)     as captchas_total,
           SUM(captchas_passed)    as captchas_passed,
           SUM(punishments_total)  as punishments_total,
           SUM(risk_detections)    as risk_detections
         FROM stat_snapshots ${where}`
    ).get(...params);
    return {
      approvals_total: row.approvals_total ?? 0,
      approvals_passed: row.approvals_passed ?? 0,
      approvals_rejected: row.approvals_rejected ?? 0,
      captchas_total: row.captchas_total ?? 0,
      captchas_passed: row.captchas_passed ?? 0,
      punishments_total: row.punishments_total ?? 0,
      risk_detections: row.risk_detections ?? 0
    };
  }
};
var statisticsRepo = new StatisticsRepository();

// src/database/repositories/blacklist.ts
var BlacklistRepository = class {
  isBlacklisted(userId, groupId = null) {
    const now = Date.now();
    const global = getDatabase().prepare(
      `SELECT 1 FROM blacklist
         WHERE user_id = ? AND group_id IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`
    ).get(userId, now);
    if (global) return true;
    if (groupId !== null) {
      const group = getDatabase().prepare(
        `SELECT 1 FROM blacklist
           WHERE user_id = ? AND group_id = ?
             AND (expires_at IS NULL OR expires_at > ?)
           LIMIT 1`
      ).get(userId, groupId, now);
      if (group) return true;
    }
    return false;
  }
  findAll(limit = 50, offset = 0) {
    return getDatabase().prepare("SELECT * FROM blacklist ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  }
  add(data) {
    const now = Date.now();
    const db = getDatabase();
    const updated = data.groupId === null ? db.prepare(
      `UPDATE blacklist SET reason = ?, created_by = ?, created_at = ?, expires_at = ?
             WHERE user_id = ? AND group_id IS NULL`
    ).run(data.reason, data.createdBy, now, data.expiresAt ?? null, data.userId) : db.prepare(
      `UPDATE blacklist SET reason = ?, created_by = ?, created_at = ?, expires_at = ?
             WHERE user_id = ? AND group_id = ?`
    ).run(data.reason, data.createdBy, now, data.expiresAt ?? null, data.userId, data.groupId);
    if (Number(updated.changes) === 0) {
      db.prepare(
        `INSERT INTO blacklist (user_id, group_id, reason, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(data.userId, data.groupId, data.reason, data.createdBy, now, data.expiresAt ?? null);
    }
    return data.groupId === null ? db.prepare("SELECT * FROM blacklist WHERE user_id = ? AND group_id IS NULL").get(data.userId) : db.prepare("SELECT * FROM blacklist WHERE user_id = ? AND group_id = ?").get(data.userId, data.groupId);
  }
  remove(userId, groupId = null) {
    const result = getDatabase().prepare(
      groupId === null ? "DELETE FROM blacklist WHERE user_id = ? AND group_id IS NULL" : "DELETE FROM blacklist WHERE user_id = ? AND group_id = ?"
    ).run(...[userId, ...groupId !== null ? [groupId] : []]);
    return result.changes > 0;
  }
  purgeExpired(limit = 250) {
    const result = getDatabase().prepare(
      `DELETE FROM blacklist
         WHERE id IN (
           SELECT id FROM blacklist
           WHERE expires_at IS NOT NULL AND expires_at < ?
           ORDER BY id
           LIMIT ?
         )`
    ).run(Date.now(), limit);
    return Number(result.changes);
  }
};
var blacklistRepo = new BlacklistRepository();

// src/database/repositories/punishment.ts
var PunishmentRepository = class {
  findById(id) {
    return getDatabase().prepare("SELECT * FROM punishment_records WHERE id = ?").get(id) ?? null;
  }
  findByUser(userId, groupId) {
    if (groupId !== void 0) {
      return getDatabase().prepare(
        "SELECT * FROM punishment_records WHERE user_id = ? AND group_id = ? ORDER BY created_at DESC"
      ).all(userId, groupId);
    }
    return getDatabase().prepare("SELECT * FROM punishment_records WHERE user_id = ? ORDER BY created_at DESC").all(userId);
  }
  findAll(limit = 50, offset = 0) {
    return getDatabase().prepare("SELECT * FROM punishment_records ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  }
  countActivePunishmentsByUser(userId, groupId, now = Date.now()) {
    const row = getDatabase().prepare(
      `SELECT COUNT(*) AS cnt
         FROM punishment_records
         WHERE user_id = ? AND group_id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`
    ).get(userId, groupId, now);
    return Number(row.cnt);
  }
  countActiveKicksByUser(userId, groupId, now = Date.now()) {
    const row = getDatabase().prepare(
      `SELECT COUNT(*) AS cnt
         FROM punishment_records
         WHERE user_id = ? AND group_id = ?
           AND type = 'kick'
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`
    ).get(userId, groupId, now);
    return Number(row.cnt);
  }
  create(data) {
    const now = Date.now();
    const expiresAt = data.durationSeconds !== null ? now + data.durationSeconds * 1e3 : null;
    const result = getDatabase().prepare(
      `INSERT INTO punishment_records
         (group_id, user_id, type, duration_seconds, reason, operator_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.groupId,
      data.userId,
      data.type,
      data.durationSeconds,
      data.reason,
      data.operatorId,
      now,
      expiresAt
    );
    return this.findById(Number(result.lastInsertRowid));
  }
  revoke(id, revokedBy) {
    getDatabase().prepare(
      "UPDATE punishment_records SET revoked_at = ?, revoked_by = ? WHERE id = ?"
    ).run(Date.now(), revokedBy, id);
  }
};
var punishmentRepo = new PunishmentRepository();

// src/core/config/group.ts
var GROUP_FALLBACKS = {
  rejectReason: "\u4E0D\u7B26\u5408\u5165\u7FA4\u8981\u6C42",
  curfewStart: "23:00",
  curfewEnd: "07:00"
};
function resolveGroupConfig(cfg, groupId) {
  const g = cfg.approval.groups[groupId];
  return {
    enabled: g?.enabled ?? cfg.approval.defaultGroupEnabled,
    action: g?.action ?? cfg.approval.defaultAction,
    approveKeywords: g?.approveKeywords ?? [],
    rejectKeywords: g?.rejectKeywords ?? [],
    approvePatterns: g?.approvePatterns ?? [],
    rejectPatterns: g?.rejectPatterns ?? [],
    rejectReason: g?.rejectReason ?? GROUP_FALLBACKS.rejectReason,
    riskEnabled: g?.riskEnabled ?? cfg.risk.enabled,
    autoKickBlacklisted: g?.autoKickBlacklisted ?? cfg.blacklist.autoKickOnJoin,
    notifyOnRisk: g?.notifyOnRisk ?? false,
    notifyOnJoin: g?.notifyOnJoin ?? false,
    groupName: g?.groupName ?? "",
    welcomeEnabled: g?.welcomeEnabled ?? false,
    welcomeTemplate: g?.welcomeTemplate ?? "",
    curfewEnabled: g?.curfewEnabled ?? false,
    curfewStart: g?.curfewStart ?? GROUP_FALLBACKS.curfewStart,
    curfewEnd: g?.curfewEnd ?? GROUP_FALLBACKS.curfewEnd
  };
}
function buildNewGroupConfig(cfg, groupName) {
  return {
    enabled: Boolean(cfg.approval.defaultGroupEnabled),
    action: cfg.approval.defaultAction,
    approveKeywords: [],
    rejectKeywords: [],
    approvePatterns: [],
    rejectPatterns: [],
    rejectReason: GROUP_FALLBACKS.rejectReason,
    riskEnabled: Boolean(cfg.risk.enabled),
    autoKickBlacklisted: Boolean(cfg.blacklist.autoKickOnJoin),
    notifyOnRisk: false,
    notifyOnJoin: false,
    groupName,
    welcomeEnabled: false,
    welcomeTemplate: "",
    curfewEnabled: false,
    curfewStart: GROUP_FALLBACKS.curfewStart,
    curfewEnd: GROUP_FALLBACKS.curfewEnd
  };
}

// src/modules/intel/index.ts
import { createHash } from "node:crypto";

// src/modules/punishment/index.ts
function canonicalActorId(value) {
  if (value === null || value === "0") return null;
  const actorId = normalizeOneBotId(value);
  if (!actorId) throw new Error("Punishment actor must be a canonical OneBot identifier or the unset system actor");
  return actorId;
}
var PunishmentService = class {
  async checkAndReapplyOnJoin(groupId, userId) {
    const cfg = configManager.get();
    if (!resolveGroupConfig(cfg, groupId).enabled) return false;
    const log = getLogger().child({ module: "punishment" });
    let reKicked = false;
    await withLock(locks.punishment(groupId, userId), async () => {
      const now = Date.now();
      const active = punishmentRepo.findByUser(userId, groupId).filter((record2) => record2.revoked_at === null && (record2.expires_at === null || record2.expires_at > now));
      if (active.length === 0) return;
      const activeKick = active.find((record2) => record2.type === "kick");
      if (activeKick) {
        const actorId = canonicalActorId(cfg.core.selfId);
        await this._kickLocked(
          groupId,
          userId,
          "Evasion attempt: rejoined after an unrevoked kick",
          actorId,
          false
        );
        log.warn(
          { user_id: userId, group_id: groupId, originalPunishmentId: activeKick.id },
          "Anti-evasion: re-kicked after an unrevoked removal"
        );
        bus.emit("AuditCreated", {
          action: "punishment.anti_evasion_rekick",
          actorId: null,
          targetType: "user",
          targetId: String(userId),
          details: { groupId, originalPunishmentId: activeKick.id },
          timestamp: now
        });
        reKicked = true;
        await this._checkEscalationLocked(groupId, userId, actorId);
        return;
      }
      const activeMute = active.find((record2) => record2.type === "mute");
      if (activeMute && activeMute.expires_at !== null) {
        const remainingSeconds = Math.max(1, Math.ceil((activeMute.expires_at - now) / 1e3));
        await callOneBot("set_group_ban", {
          group_id: String(groupId),
          user_id: String(userId),
          duration: remainingSeconds
        });
        log.warn(
          { user_id: userId, group_id: groupId, remainingSeconds, originalPunishmentId: activeMute.id },
          "Anti-evasion: re-applied mute for remaining duration"
        );
        bus.emit("AuditCreated", {
          action: "punishment.anti_evasion_remute",
          actorId: null,
          targetType: "user",
          targetId: String(userId),
          details: { groupId, remainingSeconds, originalPunishmentId: activeMute.id },
          timestamp: now
        });
      }
    });
    return reKicked;
  }
  async mute(groupId, userId, durationSeconds, reason, operatorId2) {
    const actorId = canonicalActorId(operatorId2);
    return withLock(locks.punishment(groupId, userId), async () => {
      const record2 = await this._muteLocked(groupId, userId, durationSeconds, reason, actorId);
      await this._checkEscalationLocked(groupId, userId, actorId);
      return record2;
    });
  }
  async kick(groupId, userId, reason, operatorId2, rejectFuture = false) {
    const actorId = canonicalActorId(operatorId2);
    return withLock(locks.punishment(groupId, userId), async () => {
      const record2 = await this._kickLocked(groupId, userId, reason, actorId, rejectFuture);
      await this._checkEscalationLocked(groupId, userId, actorId);
      return record2;
    });
  }
  async unban(groupId, userId, operatorId2) {
    const actorId = canonicalActorId(operatorId2);
    await withLock(
      locks.punishment(groupId, userId),
      () => this._unbanLocked(groupId, userId, actorId)
    );
  }
  async revoke(punishmentId, operatorId2) {
    const actorId = canonicalActorId(operatorId2);
    const candidate = punishmentRepo.findById(punishmentId);
    if (!candidate) throw new Error(`Punishment ${punishmentId} not found`);
    await withLock(locks.punishment(candidate.group_id, candidate.user_id), async () => {
      const record2 = punishmentRepo.findById(punishmentId);
      if (!record2) throw new Error(`Punishment ${punishmentId} not found`);
      if (record2.revoked_at !== null) return;
      const now = Date.now();
      const shouldUnban = this._isActiveMute(record2, now) && !punishmentRepo.findByUser(record2.user_id, record2.group_id).some((other) => other.id !== record2.id && this._isActiveMute(other, now));
      if (shouldUnban) {
        await callOneBot("set_group_ban", {
          group_id: String(record2.group_id),
          user_id: String(record2.user_id),
          duration: 0
        });
      }
      punishmentRepo.revoke(record2.id, actorId);
      if (shouldUnban) {
        bus.emit("AuditCreated", {
          action: "punishment.unban",
          actorId,
          targetType: "user",
          targetId: String(record2.user_id),
          details: { groupId: record2.group_id, via: "revoke" },
          timestamp: now
        });
      }
      bus.emit("AuditCreated", {
        action: "punishment.revoke",
        actorId,
        targetType: "punishment",
        targetId: String(record2.id),
        details: { groupId: record2.group_id, unbanned: shouldUnban },
        timestamp: now
      });
    });
  }
  async _muteLocked(groupId, userId, durationSeconds, reason, actorId) {
    await callOneBot("set_group_ban", {
      group_id: String(groupId),
      user_id: String(userId),
      duration: durationSeconds
    });
    const record2 = punishmentRepo.create({ groupId, userId, type: "mute", durationSeconds, reason, operatorId: actorId });
    statisticsRepo.bump(groupId, "punishments_total");
    bus.emit("AuditCreated", {
      action: "punishment.mute",
      actorId,
      targetType: "user",
      targetId: String(userId),
      details: { groupId, durationSeconds, reason },
      timestamp: Date.now()
    });
    return record2;
  }
  async _kickLocked(groupId, userId, reason, actorId, rejectFuture) {
    await callOneBot("set_group_kick", {
      group_id: String(groupId),
      user_id: String(userId),
      reject_add_request: rejectFuture
    });
    const record2 = punishmentRepo.create({ groupId, userId, type: "kick", durationSeconds: null, reason, operatorId: actorId });
    statisticsRepo.bump(groupId, "punishments_total");
    bus.emit("AuditCreated", {
      action: "punishment.kick",
      actorId,
      targetType: "user",
      targetId: String(userId),
      details: { groupId, reason },
      timestamp: Date.now()
    });
    return record2;
  }
  async _unbanLocked(groupId, userId, actorId) {
    await callOneBot("set_group_ban", {
      group_id: String(groupId),
      user_id: String(userId),
      duration: 0
    });
    bus.emit("AuditCreated", {
      action: "punishment.unban",
      actorId,
      targetType: "user",
      targetId: String(userId),
      details: { groupId },
      timestamp: Date.now()
    });
  }
  _isActiveMute(record2, now) {
    return record2.type === "mute" && record2.revoked_at === null && (record2.expires_at === null || record2.expires_at > now);
  }
  /** Blacklist-threshold check alone (never kicks, never recurses, never
   *  throws). Returns true when the user was just auto-blacklisted. */
  _maybeBlacklistLocked(groupId, userId, actorId) {
    const log = getLogger().child({ module: "punishment" });
    try {
      const cfg = configManager.get().punishment;
      const threshold = cfg.escalateToBlacklistAfter;
      if (threshold === 0) return false;
      const qualifyingKickCount = punishmentRepo.countActiveKicksByUser(userId, groupId);
      if (qualifyingKickCount >= threshold && !blacklistRepo.isBlacklisted(userId, groupId)) {
        blacklistRepo.add({
          userId,
          groupId,
          reason: `Auto-blacklisted after ${qualifyingKickCount} qualifying kicks`,
          createdBy: actorId
        });
        log.warn(
          { user_id: userId, group_id: groupId, qualifying_kick_count: qualifyingKickCount, threshold },
          "Escalated to blacklist"
        );
        bus.emit("AuditCreated", {
          action: "blacklist.auto_add",
          actorId,
          targetType: "user",
          targetId: String(userId),
          details: { groupId, qualifyingKickCount, threshold },
          timestamp: Date.now()
        });
        return true;
      }
    } catch (error) {
      log.error({ user_id: userId, group_id: groupId, error: String(error) }, "Blacklist escalation check failed");
    }
    return false;
  }
  /** Escalation is best-effort: a failure here must never reject the mute or
   *  kick that already succeeded and is already recorded. */
  async _checkEscalationLocked(groupId, userId, actorId) {
    const log = getLogger().child({ module: "punishment" });
    if (this._maybeBlacklistLocked(groupId, userId, actorId)) return;
    try {
      const cfg = configManager.get().punishment;
      const threshold = cfg.escalateToKickAfter;
      if (threshold === 0) return;
      const qualifyingPunishmentCount = punishmentRepo.countActivePunishmentsByUser(userId, groupId);
      if (qualifyingPunishmentCount < threshold) return;
      if (punishmentRepo.countActiveKicksByUser(userId, groupId) > 0) return;
      log.warn(
        { user_id: userId, group_id: groupId, qualifying_punishment_count: qualifyingPunishmentCount, threshold },
        "Escalated to kick"
      );
      await this._kickLocked(
        groupId,
        userId,
        `Auto-kicked after ${qualifyingPunishmentCount} qualifying punishments`,
        actorId,
        false
      );
      bus.emit("AuditCreated", {
        action: "punishment.auto_kick",
        actorId,
        targetType: "user",
        targetId: String(userId),
        details: { groupId, qualifyingPunishmentCount, threshold },
        timestamp: Date.now()
      });
      this._maybeBlacklistLocked(groupId, userId, actorId);
    } catch (error) {
      log.error({ user_id: userId, group_id: groupId, error: String(error) }, "Escalation check failed");
    }
  }
};
var punishmentService = new PunishmentService();

// src/runtime/safe-fetch.ts
import { lookup as dnsLookup } from "node:dns/promises";
import { closeSync, existsSync as existsSync2, openSync, renameSync as renameSync2, unlinkSync as unlinkSync2, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
var DEFAULT_MAX_REDIRECTS = 5;
var DEFAULT_USER_AGENT = "qq-guardian";
var responseDeadlines = /* @__PURE__ */ new WeakMap();
function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a >= 224;
}
function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const embeddedIpv4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (embeddedIpv4) return isPrivateIpv4(embeddedIpv4);
  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
  return normalized === "::" || normalized === "::1" || Number.isNaN(firstHextet) || firstHextet >= 65152 && firstHextet <= 65215 || firstHextet >= 64512 && firstHextet <= 65023 || firstHextet >= 65280;
}
function isPrivateNetworkAddress(address) {
  const family = isIP(address.replace(/^\[|\]$/g, ""));
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}
async function resolveAll(hostname) {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record2) => record2.address);
}
function normalizedHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}
function assertResolvedAddresses(addresses, allowPrivateNetwork) {
  if (addresses.length === 0 || !allowPrivateNetwork && addresses.some(isPrivateNetworkAddress)) {
    throw new Error("Remote URL resolves to a private network address");
  }
}
async function validateRemoteTarget(rawUrl, policy, resolveHostname) {
  let url;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch {
    throw new Error("Invalid remote URL");
  }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw new Error("Remote URLs must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Remote URLs must not contain credentials");
  const hostname = normalizedHostname(url.hostname);
  if (policy.allowedHosts && !policy.allowedHosts.has(hostname)) {
    throw new Error("Remote URL host is not allowed");
  }
  if (isIP(hostname)) {
    assertResolvedAddresses([hostname], Boolean(policy.allowPrivateNetwork));
    return { url, hostname };
  }
  try {
    assertResolvedAddresses(await resolveHostname(hostname), Boolean(policy.allowPrivateNetwork));
  } catch (error) {
    if (error instanceof Error && error.message === "Remote URL resolves to a private network address") throw error;
    throw new Error("Remote URL could not be resolved");
  }
  return { url, hostname };
}
async function validateRemoteUrl(rawUrl, policy = {}, resolveHostname = resolveAll) {
  return (await validateRemoteTarget(rawUrl, policy, resolveHostname)).url;
}
function pinnedLookup(policy, resolveHostname) {
  return (rawHostname, options, callback) => {
    void (async () => {
      try {
        const hostname = normalizedHostname(rawHostname);
        const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname);
        assertResolvedAddresses(addresses, Boolean(policy.allowPrivateNetwork));
        const requestedFamily = typeof options === "number" ? options : options.family ?? 0;
        const candidates = addresses.filter((candidate) => requestedFamily === 0 || isIP(candidate) === requestedFamily).map((address) => ({ address, family: isIP(address) }));
        if (candidates.length === 0) throw new Error("Remote URL could not be resolved");
        if (typeof options !== "number" && options.all) {
          callback(null, candidates);
          return;
        }
        callback(null, candidates[0].address, candidates[0].family);
      } catch (error) {
        callback(
          error instanceof Error && error.message === "Remote URL resolves to a private network address" ? error : new Error("Remote URL could not be resolved")
        );
      }
    })();
  };
}
function requestHeaders(headers) {
  const normalized = {};
  new Headers(headers).forEach((value, name) => {
    normalized[name] = value;
  });
  if (!normalized["user-agent"]) normalized["user-agent"] = DEFAULT_USER_AGENT;
  return normalized;
}
function responseHeaders(response) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === void 0) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}
function endRequest(request, body) {
  if (body === void 0 || body === null) {
    request.end();
    return;
  }
  if (typeof body === "string" || body instanceof URLSearchParams || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
    request.end(body instanceof URLSearchParams ? body.toString() : body);
    return;
  }
  if (body instanceof ArrayBuffer) {
    request.end(Buffer.from(body));
    return;
  }
  throw new Error("Unsupported remote request body type");
}
function requestRemote(target, init, policy, resolveHostname, signal) {
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const onResponse = (incoming) => {
      const status = incoming.statusCode ?? 500;
      const body = status === 204 || status === 304 ? null : Readable.toWeb(incoming);
      finish(() => resolveResponse(new Response(body, {
        status,
        statusText: incoming.statusMessage ?? "",
        headers: responseHeaders(incoming)
      })));
    };
    const options = {
      hostname: target.hostname,
      port: target.url.port ? Number(target.url.port) : void 0,
      path: `${target.url.pathname}${target.url.search}`,
      method: init.method ?? "GET",
      headers: requestHeaders(init.headers),
      lookup: pinnedLookup(policy, resolveHostname),
      signal
    };
    const request = target.url.protocol === "https:" ? httpsRequest({ ...options, servername: isIP(target.hostname) ? void 0 : target.hostname }, onResponse) : httpRequest(options, onResponse);
    request.once("error", (error) => finish(() => rejectResponse(error)));
    try {
      endRequest(request, init.body);
    } catch (error) {
      request.destroy(error instanceof Error ? error : void 0);
      finish(() => rejectResponse(error));
    }
  });
}
function clearResponseDeadline(response) {
  const deadline = responseDeadlines.get(response);
  if (!deadline) return;
  responseDeadlines.delete(response);
  deadline.release();
}
function withoutCrossOriginCredentials(headers) {
  const sanitized = new Headers(headers);
  for (const name of [
    "authorization",
    "proxy-authorization",
    "cookie",
    "cookie2",
    "x-api-key",
    "x-auth-token",
    "x-amz-security-token"
  ]) sanitized.delete(name);
  return sanitized;
}
async function fetchRemote(rawUrl, init = {}, policy = {}, resolveHostname = resolveAll) {
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = await validateRemoteTarget(rawUrl, policy, resolveHostname);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs ?? 1e4);
  const upstreamSignal = init.signal;
  const forwardAbort = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  const releaseDeadline = () => {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  };
  let { signal: _upstreamSignal, ...requestInit } = init;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await requestRemote(current, requestInit, policy, resolveHostname, controller.signal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
          await response.body?.cancel();
          if (redirects >= maxRedirects) throw new Error("Remote request exceeded redirect limit");
          const next = await validateRemoteTarget(new URL(location, current.url), policy, resolveHostname);
          if (next.url.origin !== current.url.origin) {
            requestInit = { ...requestInit, headers: withoutCrossOriginCredentials(requestInit.headers) };
          }
          current = next;
          continue;
        }
      }
      responseDeadlines.set(response, { release: releaseDeadline });
      return response;
    }
  } catch (error) {
    releaseDeadline();
    throw error;
  }
}
async function releaseRemoteResponse(response) {
  clearResponseDeadline(response);
  await response.body?.cancel().catch(() => void 0);
}
async function readResponseBytes(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await releaseRemoteResponse(response);
    throw new Error(`Remote response exceeds the ${maxBytes} byte limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    await releaseRemoteResponse(response);
    return Buffer.alloc(0);
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Remote response exceeds the ${maxBytes} byte limit`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => void 0);
    throw error;
  } finally {
    clearResponseDeadline(response);
  }
  return Buffer.concat(chunks, total);
}
async function readResponseJson(response, maxBytes) {
  const bytes = await readResponseBytes(response, maxBytes);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Remote response is not valid JSON");
  }
}
async function writeResponseToFile(response, destination, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await releaseRemoteResponse(response);
    throw new Error(`Remote response exceeds the ${maxBytes} byte limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    await releaseRemoteResponse(response);
    throw new Error("Remote response has no body");
  }
  const temporary = `${destination}.part-${process.pid}-${Date.now()}`;
  let descriptor = null;
  let total = 0;
  try {
    descriptor = openSync(temporary, "wx", 384);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Remote response exceeds the ${maxBytes} byte limit`);
      writeSync(descriptor, value);
    }
    closeSync(descriptor);
    descriptor = null;
    if (declaredLength > 0 && total !== declaredLength) {
      throw new Error(`Remote response is incomplete: expected ${declaredLength} bytes, received ${total}`);
    }
    if (existsSync2(destination)) throw new Error("Update artifact already exists; choose another version or remove it explicitly");
    renameSync2(temporary, destination);
    return total;
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
      }
    }
    try {
      unlinkSync2(temporary);
    } catch {
    }
    await reader.cancel().catch(() => void 0);
    throw error;
  } finally {
    clearResponseDeadline(response);
  }
}

// src/modules/intel/index.ts
var IntelFeedPinMismatchError = class extends Error {
  expectedSha256;
  observedSha256;
  constructor(expectedSha256, observedSha256) {
    super("Intel feed SHA-256 pin mismatch");
    this.name = "IntelFeedPinMismatchError";
    this.expectedSha256 = expectedSha256;
    this.observedSha256 = observedSha256;
  }
};
function isIntelEnforcementActive(config) {
  return config.enabled && config.enforcementMode === "enforce";
}
function parsePinnedIntelFeed(bytes, expectedSha256) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new IntelFeedPinMismatchError(expectedSha256, sha256);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Intel feed is not valid JSON");
  }
  return { feed: parseFeed(document), sha256, verified: expectedSha256 !== void 0 };
}
var FETCH_TIMEOUT_MS = 8e3;
var MAX_INTEL_FEED_BYTES = 2 * 1024 * 1024;
function rawToJsdelivr(url) {
  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return `https://cdn.jsdelivr.net/gh/${m[1]}@${m[2]}/${m[3]}`;
}
var MAX_ENTRIES_PER_LIST = 5e3;
var FAIL_LOG_INTERVAL_MS = 30 * 6e4;
var VALID_KEYWORD_ACTIONS = /* @__PURE__ */ new Set(["mute", "kick", "notify_admin", "log_only"]);
function compileFeedPattern(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > MAX_PATTERN_LENGTH) return null;
  if (hasNestedQuantifier(pattern) || hasAmbiguousQuantifiedAlternation(pattern)) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
function parseFeed(doc) {
  const out = { redFlags: [], riskKeywords: [], rejectPatterns: [] };
  if (!doc || typeof doc !== "object") return out;
  const d = doc;
  const users = [d["red_flag_users"], d["redFlagUsers"]].find(Array.isArray);
  for (const entry of (users ?? []).slice(0, MAX_ENTRIES_PER_LIST)) {
    let rawUserId;
    let action = "reject", reason = "cloud red-flag list";
    if (typeof entry === "number" || typeof entry === "string") {
      rawUserId = entry;
    } else if (entry && typeof entry === "object") {
      const e = entry;
      rawUserId = e["id"] ?? e["user_id"] ?? e["userId"];
      if (e["action"] === "kick") action = "kick";
      if (typeof e["reason"] === "string" && e["reason"]) reason = e["reason"];
    } else continue;
    const userId = normalizeOneBotId(rawUserId);
    if (userId === null) continue;
    out.redFlags.push({ userId, action, reason });
  }
  const keywords = [d["risk_keywords"], d["riskKeywords"]].find(Array.isArray);
  for (const entry of (keywords ?? []).slice(0, MAX_ENTRIES_PER_LIST)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry;
    const regex = compileFeedPattern(e["pattern"]);
    if (!regex) continue;
    const action = VALID_KEYWORD_ACTIONS.has(String(e["action"])) ? String(e["action"]) : "mute";
    const name = typeof e["name"] === "string" && e["name"] ? e["name"] : "unnamed";
    out.riskKeywords.push({ name, regex, action });
  }
  const rejects = [d["reject_patterns"], d["rejectPatterns"]].find(Array.isArray);
  for (const entry of (rejects ?? []).slice(0, MAX_ENTRIES_PER_LIST)) {
    const regex = compileFeedPattern(entry);
    if (regex) out.rejectPatterns.push(regex);
  }
  return out;
}
function readIntelPolicy() {
  const config = configManager.get().intel;
  const urls = config.enabled ? normalizeIntelFeedUrls(config.feedUrls) : [];
  const pins = Object.fromEntries(urls.flatMap((url) => config.feedPins[url] ? [[url, config.feedPins[url]]] : []));
  return {
    enabled: config.enabled,
    enforcementMode: config.enforcementMode,
    urls,
    pins,
    key: JSON.stringify([config.enabled, config.enforcementMode, urls.map((url) => [url, pins[url] ?? null])])
  };
}
function reconcileIntelSourceFeeds(configuredUrls, sourceFeeds) {
  const configured = new Set(configuredUrls);
  for (const url of sourceFeeds.keys()) {
    if (!configured.has(url)) sourceFeeds.delete(url);
  }
  const merged = { redFlags: [], riskKeywords: [], rejectPatterns: [] };
  for (const url of configuredUrls) {
    const feed = sourceFeeds.get(url);
    if (!feed) continue;
    merged.redFlags.push(...feed.redFlags);
    merged.riskKeywords.push(...feed.riskKeywords);
    merged.rejectPatterns.push(...feed.rejectPatterns);
  }
  return merged;
}
var IntelService = class {
  _redFlags = /* @__PURE__ */ new Map();
  _riskKeywords = [];
  _rejectPatterns = [];
  _lastFetchAt = 0;
  _inFlight = null;
  _inFlightKey = null;
  _timer = null;
  _sources = [];
  /** Last verified data for each configured feed. A partial outage must not
   * erase the good data previously received from another source. */
  _sourceFeeds = /* @__PURE__ */ new Map();
  _sourceDigests = /* @__PURE__ */ new Map();
  _lastFailLog = /* @__PURE__ */ new Map();
  /** pattern source → worker-probe verdict, memoized per process so each
   *  distinct pattern pays the probe cost once, not on every refresh. */
  _probeVerdicts = /* @__PURE__ */ new Map();
  init() {
    this._armTimer();
    bus.on("ConfigChanged", () => this._armTimer());
  }
  /**
   * Applies cloud red-flag policy after local blacklist and anti-evasion
   * stages have completed. Kick-level flags terminate the admission flow even
   * when the OneBot removal call fails, preventing an unsafe welcome.
   */
  async handleMemberJoin(event) {
    const config = configManager.get();
    if (!resolveGroupConfig(config, event.groupId).enabled) return "continue";
    await this.ensureFresh();
    const flag = this.getRedFlag(event.userId);
    if (!flag) return "continue";
    const log = getLogger().child({ module: "intel" });
    if (!flag.enforced) {
      log.warn(
        { user_id: event.userId, group_id: event.groupId, reason: flag.reason, enforcement: "observe" },
        "Cloud red-flag observed; no member action permitted"
      );
      return "continue";
    }
    if (flag.action === "kick") {
      log.warn(
        { user_id: event.userId, group_id: event.groupId, reason: flag.reason },
        "Cloud red-flag (kick level) joined \u2014 removing"
      );
      try {
        await punishmentService.kick(
          event.groupId,
          event.userId,
          `Cloud red-flag: ${flag.reason}`,
          config.core.selfId
        );
      } catch (error) {
        log.error(error, "Cloud red-flag removal failed");
      }
      return "stop";
    }
    log.warn(
      { user_id: event.userId, group_id: event.groupId, reason: flag.reason },
      "Cloud red-flag (reject level) joined via invite"
    );
    for (const id of config.core.superAdmins) {
      await callOneBot("send_private_msg", {
        user_id: String(id),
        message: `\u26A0\uFE0F \u4E91\u7AEF\u98CE\u63A7\u540D\u5355\u7528\u6237 ${event.userId} \u901A\u8FC7\u9080\u8BF7\u52A0\u5165\u4E86\u7FA4 ${event.groupId}\uFF08${flag.reason}\uFF09`
      }).catch(() => {
      });
    }
    return "continue";
  }
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
  _armTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    const policy = readIntelPolicy();
    this._reconcileConfiguredSources(policy);
    if (!policy.enabled || policy.urls.length === 0) {
      this._lastFetchAt = 0;
      return;
    }
    const intervalMs = Math.max(60, configManager.get().intel.refreshIntervalSeconds || 300) * 1e3;
    this._timer = setInterval(() => void this.refresh(true), intervalMs);
    void this.refresh(true);
  }
  /** Refreshes the cache when it is older than the configured interval.
   *  Concurrent callers share one in-flight fetch. Never throws. */
  async ensureFresh() {
    const cfg = configManager.get().intel;
    if (!cfg.enabled) return;
    const ttlMs = Math.max(60, cfg.refreshIntervalSeconds || 300) * 1e3;
    if (Date.now() - this._lastFetchAt < ttlMs) return;
    await this.refresh(false);
  }
  /** Fetches and merges every configured feed. force=false is a no-op while
   *  a fetch is already in flight (callers share it). Never throws. */
  async refresh(force) {
    const policy = readIntelPolicy();
    this._reconcileConfiguredSources(policy);
    if (!policy.enabled || policy.urls.length === 0) {
      this._lastFetchAt = 0;
      return;
    }
    const requestedKey = policy.key;
    if (this._inFlight) {
      const activeKey = this._inFlightKey;
      await this._inFlight;
      const latestKey = readIntelPolicy().key;
      if (activeKey === requestedKey && latestKey === requestedKey) return;
      await this.refresh(true);
      return;
    }
    if (!force && Date.now() - this._lastFetchAt < 1e3) return;
    const task = this._doRefresh(policy);
    this._inFlight = task;
    this._inFlightKey = requestedKey;
    try {
      await task;
    } finally {
      if (this._inFlight === task) {
        this._inFlight = null;
        this._inFlightKey = null;
      }
    }
    if (readIntelPolicy().key !== requestedKey) await this.refresh(true);
  }
  async _doRefresh(policy) {
    const log = getLogger().child({ module: "intel" });
    const sources = [];
    for (const url of policy.urls) {
      const candidates = [url];
      const mirror = rawToJsdelivr(url);
      if (mirror) candidates.push(mirror);
      let parsed = null;
      let lastError = "";
      let lastObservedSha256 = this._sources.find((source) => source.url === url)?.lastObservedSha256 ?? null;
      for (const candidate of candidates) {
        try {
          const res = await fetchRemote(candidate, {
            headers: { Accept: "application/json", "Cache-Control": "no-cache" }
          }, {
            timeoutMs: FETCH_TIMEOUT_MS
          });
          if (!res.ok) {
            await releaseRemoteResponse(res);
            throw new Error(`HTTP ${res.status}`);
          }
          parsed = parsePinnedIntelFeed(
            await readResponseBytes(res, MAX_INTEL_FEED_BYTES),
            policy.pins[url]
          );
          if (candidate !== url)
            log.info({ url, mirror: candidate }, "Intel feed fetched via CDN mirror");
          break;
        } catch (e) {
          if (e instanceof IntelFeedPinMismatchError) lastObservedSha256 = e.observedSha256;
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      if (parsed) {
        const feed = parsed.feed;
        feed.riskKeywords = await this._filterProbed(feed.riskKeywords, (keyword) => keyword.regex, log);
        feed.rejectPatterns = await this._filterProbed(feed.rejectPatterns, (pattern) => pattern, log);
        this._sourceFeeds.set(url, feed);
        this._sourceDigests.set(url, parsed.sha256);
        sources.push({
          url,
          ok: true,
          lastError: null,
          lastSuccessAt: Date.now(),
          expectedSha256: policy.pins[url] ?? null,
          activeSha256: parsed.sha256,
          lastObservedSha256: parsed.sha256,
          verified: parsed.verified
        });
      } else {
        const prior = this._sources.find((source) => source.url === url);
        const activeSha256 = this._sourceDigests.get(url) ?? null;
        sources.push({
          url,
          ok: false,
          lastError,
          lastSuccessAt: prior?.lastSuccessAt ?? null,
          expectedSha256: policy.pins[url] ?? null,
          activeSha256,
          lastObservedSha256,
          verified: policy.pins[url] !== void 0 && activeSha256 === policy.pins[url]
        });
        const last = this._lastFailLog.get(url) ?? 0;
        if (Date.now() - last > FAIL_LOG_INTERVAL_MS) {
          this._lastFailLog.set(url, Date.now());
          log.warn(
            { url, error: lastError, activeCached: this._sourceFeeds.has(url) },
            "Intel feed fetch failed"
          );
        }
      }
    }
    const latest = readIntelPolicy();
    this._reconcileConfiguredSources(latest);
    if (latest.key !== policy.key) {
      this._lastFetchAt = 0;
      return;
    }
    this._sources = sources;
    this._activateConfiguredFeeds(policy.urls);
    this._lastFetchAt = Date.now();
    log.info({
      redFlags: this._redFlags.size,
      riskKeywords: this._riskKeywords.length,
      rejectPatterns: this._rejectPatterns.length
    }, "Intel feed refreshed");
  }
  _reconcileConfiguredSources(policy) {
    const configured = new Set(policy.urls);
    for (const url of this._lastFailLog.keys()) {
      if (!configured.has(url)) this._lastFailLog.delete(url);
    }
    for (const url of this._sourceFeeds.keys()) {
      const digest = this._sourceDigests.get(url);
      const pin = policy.pins[url];
      const missingRequiredPin = policy.enforcementMode === "enforce" && pin === void 0;
      if (!configured.has(url) || missingRequiredPin || pin !== void 0 && digest !== pin) {
        this._sourceFeeds.delete(url);
        this._sourceDigests.delete(url);
      }
    }
    const priorStatuses = new Map(this._sources.map((source) => [source.url, source]));
    this._activateConfiguredFeeds(policy.urls);
    this._sources = policy.urls.map((url) => {
      const prior = priorStatuses.get(url);
      const activeSha256 = this._sourceDigests.get(url) ?? null;
      const expectedSha256 = policy.pins[url] ?? null;
      const verified = expectedSha256 !== null && activeSha256 === expectedSha256;
      const active = this._sourceFeeds.has(url);
      return {
        url,
        ok: Boolean(prior?.ok && active && (expectedSha256 === null || verified)),
        lastError: active ? prior?.lastError ?? null : prior?.lastError ?? "Not fetched yet",
        lastSuccessAt: active ? prior?.lastSuccessAt ?? null : null,
        expectedSha256,
        activeSha256,
        lastObservedSha256: prior?.lastObservedSha256 ?? null,
        verified
      };
    });
  }
  _activateConfiguredFeeds(urls) {
    const merged = reconcileIntelSourceFeeds(urls, this._sourceFeeds);
    for (const url of this._sourceDigests.keys()) {
      if (!this._sourceFeeds.has(url)) this._sourceDigests.delete(url);
    }
    const redFlags = /* @__PURE__ */ new Map();
    for (const rf of merged.redFlags) {
      const prior = redFlags.get(rf.userId);
      if (!prior || prior.action === "reject" && rf.action === "kick") {
        redFlags.set(rf.userId, { action: rf.action, reason: rf.reason });
      }
    }
    this._redFlags = redFlags;
    this._riskKeywords = merged.riskKeywords;
    this._rejectPatterns = merged.rejectPatterns;
  }
  /** Keeps only entries whose pattern passes the worker probe. Verdicts are
   *  memoized by pattern source, and probes run in bounded batches — a huge
   *  feed must not fan out thousands of worker threads at once. Nothing here
   *  blocks the event loop. */
  async _filterProbed(entries, regexOf, log) {
    const CONCURRENT_PROBES = 8;
    if (this._probeVerdicts.size > 2e4) this._probeVerdicts.clear();
    const verdicts = new Array(entries.length);
    for (let i = 0; i < entries.length; i += CONCURRENT_PROBES) {
      const batch = entries.slice(i, i + CONCURRENT_PROBES);
      const results = await Promise.all(batch.map(async (e) => {
        const source = regexOf(e).source;
        let ok2 = this._probeVerdicts.get(source);
        if (ok2 === void 0) {
          ok2 = await probePatternInWorker(source);
          this._probeVerdicts.set(source, ok2);
          if (!ok2) log.warn({ pattern: source.slice(0, 80) }, "Dropping feed pattern that failed the ReDoS probe");
        }
        return ok2;
      }));
      results.forEach((ok2, j) => {
        verdicts[i + j] = ok2;
      });
    }
    return entries.filter((_, i) => verdicts[i]);
  }
  getRedFlag(userId) {
    const config = configManager.get().intel;
    if (!config.enabled) return null;
    const match = this._redFlags.get(userId);
    return match ? { ...match, enforced: isIntelEnforcementActive(config) } : null;
  }
  getEnforcedRiskKeywords() {
    return isIntelEnforcementActive(configManager.get().intel) ? this._riskKeywords : [];
  }
  getObservedRiskKeywords() {
    const config = configManager.get().intel;
    return config.enabled && !isIntelEnforcementActive(config) ? this._riskKeywords : [];
  }
  getEnforcedRejectPatterns() {
    return isIntelEnforcementActive(configManager.get().intel) ? this._rejectPatterns : [];
  }
  getObservedRejectPatterns() {
    const config = configManager.get().intel;
    return config.enabled && !isIntelEnforcementActive(config) ? this._rejectPatterns : [];
  }
  getStatus() {
    const now = Date.now();
    const config = configManager.get().intel;
    const configuredUrls = normalizeIntelFeedUrls(config.feedUrls);
    const enforcementReady = isIntelEnforcementActive(config) && configuredUrls.length > 0 && this._sources.length === configuredUrls.length && this._sources.every((source) => source.verified && this._sourceFeeds.has(source.url));
    return {
      enabled: config.enabled,
      enforcementMode: config.enforcementMode,
      enforcementReady,
      lastFetchAt: this._lastFetchAt || null,
      redFlagCount: this._redFlags.size,
      riskKeywordCount: this._riskKeywords.length,
      rejectPatternCount: this._rejectPatterns.length,
      sources: this._sources.map((source) => {
        const active = this._sourceFeeds.has(source.url);
        const stale = active && !source.ok;
        return {
          ...source,
          active,
          stale,
          staleAgeSeconds: stale && source.lastSuccessAt !== null ? Math.max(0, Math.floor((now - source.lastSuccessAt) / 1e3)) : null
        };
      })
    };
  }
};
var intelService = new IntelService();

// src/modules/approval/index.ts
var BUILTIN_REJECT_PATTERNS = [
  /(?:广告|推广|引流|加粉|涨粉|代理|招商)/,
  /(?:兼职|刷单|日结|返利|点赞赚钱|躺赚)/,
  /(?:低价|代充|代刷|外挂|辅助|科技)/,
  /加(?:我|微信|VX|V信|QQ|群)[：:，, ]*[\w@]*/i,
  /(?:约炮|裸聊|色情|博彩|赌博|下注)/
];
var BUILTIN_APPROVE_PATTERNS = [
  /(?:朋友|好友|同学|同事|群友|大佬)(?:推荐|介绍|邀请|拉我|让我)/,
  /(?:管理员?|群主)(?:同意|邀请|让我|叫我)/,
  /(?:B站|哔哩|贴吧|论坛|官网|视频|直播|公告)(?:看到|过来|找到|了解|推荐)/i
];
function matchApproveComment(comment, cfg, useBuiltinApproveKeywords) {
  for (const keyword of cfg.approveKeywords) {
    if (comment.includes(keyword)) return "custom_keyword_matched";
  }
  for (const pattern of cfg.approvePatterns) {
    try {
      if (new RegExp(pattern).test(comment)) return "custom_pattern_matched";
    } catch {
    }
  }
  if (cfg.action === "manual" && useBuiltinApproveKeywords) {
    for (const pattern of BUILTIN_APPROVE_PATTERNS) {
      if (pattern.test(comment)) return "builtin_referral_heuristic";
    }
  }
  return null;
}
var ApprovalService = class {
  async handleJoinRequest(event) {
    if (event.request_type !== "group" || event.sub_type !== "add") return;
    const { group_id, user_id, flag, comment } = event;
    const cfg = configManager.get();
    const groupCfg = resolveGroupConfig(cfg, group_id);
    if (!groupCfg.enabled) return;
    await intelService.ensureFresh();
    await withLock(locks.approval(flag), async () => {
      if (approvalRepo.findByFlag(flag)) return;
      const ttl = cfg.approval.pendingTtlSeconds;
      statisticsRepo.bump(group_id, "approvals_total");
      if (blacklistRepo.isBlacklisted(user_id, group_id)) {
        await this._rejectRecorded(group_id, user_id, flag, comment ?? "", "You are on the group blacklist.", ttl);
        return;
      }
      const hasActiveKick = punishmentRepo.findByUser(user_id, group_id).some((r) => r.type === "kick" && r.revoked_at === null);
      if (hasActiveKick) {
        getLogger().child({ module: "approval" }).warn({ group_id, user_id }, "Rejecting join request: unrevoked kick penalty on record");
        await this._rejectRecorded(group_id, user_id, flag, comment ?? "", "\u60A8\u6B64\u524D\u88AB\u79FB\u51FA\u672C\u7FA4\u4E14\u5904\u7F5A\u672A\u64A4\u9500 / A prior removal penalty is still active.", ttl);
        return;
      }
      const redFlag = intelService.getRedFlag(user_id);
      if (redFlag) {
        const log = getLogger().child({ module: "approval" });
        if (redFlag.enforced) {
          log.warn({ group_id, user_id, reason: redFlag.reason }, "Rejecting join request: pinned cloud red-flag list");
          await this._rejectRecorded(group_id, user_id, flag, comment ?? "", "\u4E91\u7AEF\u98CE\u63A7\u540D\u5355\u547D\u4E2D / Flagged by the live risk list.", ttl);
          return;
        }
        log.warn(
          { group_id, user_id, reason: redFlag.reason, enforcement: "observe" },
          "Cloud red-flag observed; no approval action permitted"
        );
      }
      const rejectReason = this._matchReject(comment ?? "", groupCfg);
      if (rejectReason) {
        await this._rejectRecorded(group_id, user_id, flag, comment ?? "", rejectReason, ttl);
        return;
      }
      const approveReason = matchApproveComment(
        comment ?? "",
        groupCfg,
        cfg.approval.useBuiltinApproveKeywords
      );
      if (approveReason) {
        await this._approveRecorded(group_id, user_id, flag, comment ?? "", ttl, approveReason);
        return;
      }
      switch (groupCfg.action) {
        case "auto_approve":
          await this._approveRecorded(group_id, user_id, flag, comment ?? "", ttl, "policy_auto_approve");
          break;
        case "auto_reject":
          await this._rejectRecorded(group_id, user_id, flag, comment ?? "", groupCfg.rejectReason, ttl);
          break;
        case "captcha":
          await this._routeToCaptcha(group_id, user_id, flag, comment ?? "", ttl);
          break;
        default:
          approvalRepo.create({ groupId: group_id, userId: user_id, flag, comment: comment ?? "", status: "pending", ttlSeconds: ttl });
          getLogger().child({ module: "approval" }).info({ group_id, user_id }, "Queued for manual review");
      }
    });
  }
  async approveManually(id, operatorId2) {
    const initial = approvalRepo.findById(id);
    if (!initial) throw new Error("Invalid approval record");
    await withLock(locks.approval(initial.flag), async () => {
      const rec = approvalRepo.findById(id);
      if (!rec || rec.status !== "pending") throw new Error("Invalid approval record");
      try {
        await this._approve(rec.flag, operatorId2, "manual_operator");
      } catch (error) {
        this._markActionFailure(rec.id, "manual_approval_failed");
        throw error;
      }
      approvalRepo.updateStatus(rec.id, "approved", operatorId2, null);
      statisticsRepo.bump(rec.group_id, "approvals_passed");
    });
  }
  async rejectManually(id, operatorId2, reason) {
    const initial = approvalRepo.findById(id);
    if (!initial) throw new Error("Invalid approval record");
    await withLock(locks.approval(initial.flag), async () => {
      const rec = approvalRepo.findById(id);
      if (!rec || rec.status !== "pending") throw new Error("Invalid approval record");
      try {
        await this._reject(rec.flag, reason, operatorId2);
      } catch (error) {
        this._markActionFailure(rec.id, "manual_rejection_failed");
        throw error;
      }
      approvalRepo.updateStatus(rec.id, "rejected", operatorId2, reason);
      statisticsRepo.bump(rec.group_id, "approvals_rejected");
    });
  }
  async approveAfterCaptcha(candidate) {
    return withLock(locks.approval(candidate.flag), async () => {
      const rec = approvalRepo.findById(candidate.id);
      if (!rec || rec.status !== "captcha") return false;
      try {
        await this._approve(rec.flag, null, "captcha_passed");
      } catch (error) {
        this._markActionFailure(rec.id, "captcha_approval_failed");
        throw error;
      }
      approvalRepo.updateStatus(rec.id, "approved", null, "captcha_passed");
      statisticsRepo.bump(rec.group_id, "approvals_passed");
      return true;
    });
  }
  async rejectAfterCaptchaFail(candidate, reason) {
    return withLock(locks.approval(candidate.flag), async () => {
      const rec = approvalRepo.findById(candidate.id);
      if (!rec || rec.status !== "captcha") return false;
      try {
        await this._reject(rec.flag, reason, null);
      } catch (error) {
        this._markActionFailure(rec.id, "captcha_rejection_failed");
        throw error;
      }
      approvalRepo.updateStatus(rec.id, "rejected", null, reason);
      statisticsRepo.bump(rec.group_id, "approvals_rejected");
      return true;
    });
  }
  async _approve(flag, operatorId2, decisionReason) {
    await callOneBot("set_group_add_request", { flag, sub_type: "add", approve: true });
    bus.emit("AuditCreated", {
      action: "approval.approve",
      actorId: operatorId2,
      targetType: "approval",
      targetId: flag,
      details: { operatorId: operatorId2, decisionReason },
      timestamp: Date.now()
    });
  }
  async _reject(flag, reason, operatorId2) {
    await callOneBot("set_group_add_request", { flag, sub_type: "add", approve: false, reason });
    bus.emit("AuditCreated", { action: "approval.reject", actorId: operatorId2, targetType: "approval", targetId: flag, details: { reason }, timestamp: Date.now() });
  }
  /** Record FIRST, OneBot call second: the persisted record is what makes
   *  routing idempotent (the admission-sync sweep and the live event both
   *  dedupe on it), so a failed approve call must not leave the request
   *  eligible for automatic re-routing — the request then simply stays in
   *  QQ's system messages for a human admin. */
  async _approveRecorded(groupId, userId, flag, comment, ttl, reason) {
    const r = approvalRepo.create({ groupId, userId, flag, comment, status: "pending", ttlSeconds: ttl });
    try {
      await this._approve(flag, null, reason);
    } catch (error) {
      this._markActionFailure(r.id, "automatic_approval_failed");
      throw error;
    }
    approvalRepo.updateStatus(r.id, "approved", null, reason);
    statisticsRepo.bump(groupId, "approvals_passed");
  }
  /** Reject twin of _approveRecorded — same record-first idempotency contract. */
  async _rejectRecorded(groupId, userId, flag, comment, reason, ttl) {
    const r = approvalRepo.create({ groupId, userId, flag, comment, status: "pending", ttlSeconds: ttl });
    try {
      await this._reject(flag, reason, null);
    } catch (error) {
      this._markActionFailure(r.id, "automatic_rejection_failed");
      throw error;
    }
    approvalRepo.updateStatus(r.id, "rejected", null, reason);
    statisticsRepo.bump(groupId, "approvals_rejected");
  }
  async _routeToCaptcha(groupId, userId, flag, comment, ttl) {
    const r = approvalRepo.create({ groupId, userId, flag, comment, status: "captcha", ttlSeconds: ttl });
    bus.emit("CaptchaRequired", { approvalId: r.id, groupId, userId, timestamp: Date.now() });
    getLogger().child({ module: "approval" }).info({ group_id: groupId, user_id: userId, approval_id: r.id }, "Routed to captcha");
  }
  /**
   * Remote failures leave a request in the operator-actionable pending queue.
   * Store a fixed failure code, never an arbitrary transport error that may
   * contain endpoint details or credentials.
   */
  _markActionFailure(id, code) {
    getDatabase().prepare(
      `UPDATE approval_records
         SET status = 'pending', reason = ?, operator_id = NULL, processed_at = NULL
         WHERE id = ? AND status IN ('pending', 'captcha')`
    ).run(code, id);
  }
  _matchReject(comment, cfg) {
    for (const kw of cfg.rejectKeywords) if (comment.includes(kw)) return cfg.rejectReason;
    for (const p of cfg.rejectPatterns) {
      try {
        if (new RegExp(p).test(comment)) return cfg.rejectReason;
      } catch {
      }
    }
    if (configManager.get().approval.useBuiltinRejectKeywords) {
      for (const re of BUILTIN_REJECT_PATTERNS) if (re.test(comment)) return cfg.rejectReason;
    }
    for (const re of intelService.getEnforcedRejectPatterns()) if (re.test(comment)) return cfg.rejectReason;
    if (intelService.getObservedRejectPatterns().some((re) => re.test(comment))) {
      getLogger().child({ module: "approval" }).warn(
        { enforcement: "observe" },
        "Cloud join-request pattern observed; no approval action permitted"
      );
    }
    return null;
  }
};
var approvalService = new ApprovalService();

// src/modules/captcha/index.ts
var EXPIRY_SWEEP_MS = 6e4;
var CHALLENGE_CODE_LENGTH = 10;
var CHALLENGE_CODE_PATTERN = /^#[a-f0-9]{10}$/i;
var MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER = 5;
var CAPTCHA_EXPIRY_SWEEP_CONCURRENCY = 4;
var CAPTCHA_EXPIRY_ACTION_TIMEOUT_MS = 15e3;
function captchaChallengeCode(sessionId) {
  return createHash2("sha256").update(`qq-guardian-captcha:${sessionId}`).digest("hex").slice(0, CHALLENGE_CODE_LENGTH).toUpperCase();
}
var CaptchaService = class {
  _sweepTimer = null;
  _sweepPromise = null;
  _expiringSessions = /* @__PURE__ */ new Map();
  _activeExpiryActions = 0;
  init() {
    if (this._sweepTimer) return;
    bus.on("CaptchaRequired", async (payload) => {
      await this.issueChallenge(payload.approvalId).catch(
        (error) => getLogger().child({ module: "captcha" }).error(error, "Failed to issue challenge")
      );
    });
    this._sweepTimer = setInterval(() => {
      void this.expireAllStale();
    }, EXPIRY_SWEEP_MS);
  }
  stop() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }
  async issueChallenge(approvalId) {
    await withLock(locks.captcha(approvalId), async () => {
      const rec = approvalRepo.findById(approvalId);
      if (!rec || rec.status !== "captcha") return;
      const issuance = await withLock(locks.captchaUser(rec.user_id), async () => {
        const db = getDatabase();
        const current = approvalRepo.findById(approvalId);
        if (!current || current.status !== "captcha" || current.expires_at < Date.now()) {
          return { kind: "none", retired: [], userId: rec.user_id };
        }
        const existing = db.prepare("SELECT id FROM captcha_sessions WHERE approval_id = ? AND solved = 0 LIMIT 1").get(approvalId);
        if (existing) return { kind: "none", retired: [], userId: current.user_id };
        const now = Date.now();
        const { active, retired } = this._reconcileActiveSessions(current.user_id, now);
        if (active.length >= MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER) {
          this._markApprovalPending(approvalId, "captcha_active_session_limit");
          return { kind: "capped", activeCount: active.length, retired, userId: current.user_id };
        }
        const activeCodes = new Set(active.map((session) => captchaChallengeCode(session.id)));
        let id = randomUUID2();
        for (let attempt = 0; activeCodes.has(captchaChallengeCode(id)) && attempt < 8; attempt += 1) {
          id = randomUUID2();
        }
        const code = captchaChallengeCode(id);
        if (activeCodes.has(code)) throw new Error("Could not allocate a unique captcha challenge code");
        const cfg = configManager.get().captcha;
        const type = cfg.types[Math.floor(Math.random() * cfg.types.length)] ?? "math";
        const { challenge, answer } = this._generate(type);
        db.prepare(
          `INSERT INTO captcha_sessions (id, group_id, user_id, approval_id, type, challenge, answer, attempts, max_attempts, created_at, expires_at, solved)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, current.group_id, current.user_id, approvalId, type, challenge, answer, 0, cfg.maxAttempts, now, now + cfg.ttlSeconds * 1e3, 0);
        const claimed = db.prepare(
          `UPDATE approval_records
           SET captcha_id = ?, processed_at = ?
           WHERE id = ? AND status = 'captcha' AND expires_at >= ?`
        ).run(id, now, approvalId, now);
        if (Number(claimed.changes) !== 1) {
          this._closeSession(id);
          return { kind: "none", retired, userId: current.user_id };
        }
        statisticsRepo.bump(current.group_id, "captchas_total");
        return {
          kind: "issued",
          challenge,
          code,
          groupId: current.group_id,
          id,
          retired,
          ttlSeconds: cfg.ttlSeconds,
          userId: current.user_id
        };
      });
      if (issuance.retired.length > 0) {
        await this._sendReconciliationNotice(issuance.userId, issuance.retired);
      }
      if (issuance.kind === "none") return;
      if (issuance.kind === "capped") {
        await this._sendNotice(
          issuance.userId,
          `You already have ${MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER} active verification sessions. Complete or wait for one to expire before requesting another; this request is pending manual review.`
        );
        getLogger().child({ module: "captcha" }).warn(
          { user_id: issuance.userId, active_sessions: issuance.activeCount },
          "Captcha active-session limit reached"
        );
        return;
      }
      try {
        await callOneBot("send_private_msg", {
          user_id: String(issuance.userId),
          message: this._buildMsg(
            issuance.challenge,
            issuance.ttlSeconds,
            issuance.code,
            issuance.groupId
          )
        });
      } catch (error) {
        this._closeSession(issuance.id);
        this._markApprovalPending(approvalId, "captcha_delivery_failed");
        throw error;
      }
      getLogger().child({ module: "captcha" }).info(
        { session_id: issuance.id, user_id: issuance.userId },
        "Captcha issued"
      );
    });
  }
  async handlePrivateMessage(event) {
    if (event.message_type !== "private") return false;
    const now = Date.now();
    const { active, retired } = await withLock(
      locks.captchaUser(event.user_id),
      async () => this._reconcileActiveSessions(event.user_id, now)
    );
    try {
      if (active.length === 0) {
        const stale = getDatabase().prepare(
          `SELECT captcha_sessions.* FROM captcha_sessions
             INNER JOIN approval_records ON approval_records.id = captcha_sessions.approval_id
             WHERE captcha_sessions.user_id = ?
               AND captcha_sessions.solved = 0
               AND captcha_sessions.expires_at < ?
               AND approval_records.status = 'captcha'
             ORDER BY captcha_sessions.expires_at ASC,
               captcha_sessions.created_at ASC,
               captcha_sessions.id ASC
             LIMIT 1`
        ).get(event.user_id, now);
        return stale ? await this._processAnswer(stale, event.raw_message) : false;
      }
      const selection = this._selectAnswer(active, event.raw_message);
      if (!selection) {
        await this._sendSelectionHint(event.user_id, active);
        return true;
      }
      return await this._processAnswer(selection.session, selection.answer);
    } finally {
      if (retired.length > 0) void this._sendReconciliationNotice(event.user_id, retired);
    }
  }
  expireAllStale(actionTimeoutMs = CAPTCHA_EXPIRY_ACTION_TIMEOUT_MS) {
    if (this._sweepPromise) return this._sweepPromise;
    const sweep = this._expireAllStale(actionTimeoutMs);
    this._sweepPromise = sweep;
    void sweep.finally(() => {
      if (this._sweepPromise === sweep) this._sweepPromise = null;
    }).catch(() => void 0);
    return sweep;
  }
  async _expireAllStale(actionTimeoutMs) {
    if (!Number.isSafeInteger(actionTimeoutMs) || actionTimeoutMs < 1) {
      throw new Error("Captcha expiry action timeout must be a positive integer");
    }
    const stale = getDatabase().prepare(
      `SELECT * FROM captcha_sessions
         WHERE solved = 0 AND expires_at < ?
         ORDER BY expires_at ASC, created_at ASC, id ASC`
    ).all(Date.now());
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < stale.length) {
        const session = stale[nextIndex++];
        if (this._expiringSessions.has(session.id)) continue;
        const action = this._tryStartExpiryAction(session);
        if (!action) return;
        try {
          await this._awaitExpiryAction(action, actionTimeoutMs);
        } catch (error) {
          getLogger().child({ module: "captcha" }).error(error, "Failed to expire captcha session");
        }
      }
    };
    const workerCount = Math.min(CAPTCHA_EXPIRY_SWEEP_CONCURRENCY, stale.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return stale.length;
  }
  async _processAnswer(candidate, answer) {
    return withLock(locks.captcha(candidate.approval_id), async () => {
      const session = this._findSession(candidate.id);
      if (!session || session.solved !== 0) return true;
      if (Date.now() > session.expires_at) {
        await this._rejectSessionLocked(
          session,
          "Captcha expired",
          "\u23F0 Verification timed out. Your join request has been rejected."
        );
        return true;
      }
      const result = getDatabase().prepare(
        `UPDATE captcha_sessions
           SET attempts = attempts + 1
           WHERE id = ? AND solved = 0 AND expires_at >= ?`
      ).run(session.id, Date.now());
      if (Number(result.changes) !== 1) return true;
      const attempts = session.attempts + 1;
      const actual = this._digest(answer);
      const expected = this._digest(session.answer);
      if (timingSafeEqual(actual, expected)) {
        await this._approveSessionLocked(session);
        return true;
      }
      const remaining = session.max_attempts - attempts;
      if (remaining <= 0) {
        await this._rejectSessionLocked(
          session,
          "Too many wrong attempts",
          "\u274C Verification failed: Too many wrong attempts. Your join request has been rejected."
        );
        return true;
      }
      await this._sendNotice(
        session.user_id,
        `\u274C Wrong answer. ${remaining} attempt(s) left.

${session.challenge}`
      );
      return true;
    });
  }
  /**
   * Reconciles unlimited pre-upgrade rows into the bounded runtime contract.
   * The newest uniquely-addressable sessions remain active; older or
   * code-colliding requests return to manual review instead of being rejected.
   */
  _reconcileActiveSessions(userId, now) {
    const db = getDatabase();
    const active = [];
    const retired = [];
    const codes = /* @__PURE__ */ new Set();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE approval_records
         SET status = 'expired', processed_at = ?
         WHERE user_id = ? AND status = 'captcha' AND expires_at < ?`
      ).run(now, userId, now);
      db.prepare(
        `UPDATE captcha_sessions
         SET solved = 1
         WHERE user_id = ? AND solved = 0
           AND NOT EXISTS (
             SELECT 1 FROM approval_records
             WHERE approval_records.id = captcha_sessions.approval_id
               AND approval_records.status = 'captcha'
           )`
      ).run(userId);
      const candidates = db.prepare(
        `SELECT captcha_sessions.* FROM captcha_sessions
           INNER JOIN approval_records ON approval_records.id = captcha_sessions.approval_id
           WHERE captcha_sessions.user_id = ?
              AND captcha_sessions.solved = 0
              AND captcha_sessions.expires_at >= ?
              AND approval_records.status = 'captcha'
              AND approval_records.expires_at >= ?
            ORDER BY captcha_sessions.created_at DESC, captcha_sessions.id DESC`
      ).all(userId, now, now);
      for (const session of candidates) {
        const code = captchaChallengeCode(session.id);
        if (active.length < MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER && !codes.has(code)) {
          codes.add(code);
          active.push(session);
        } else {
          retired.push(session);
        }
      }
      const closeSession = db.prepare(
        "UPDATE captcha_sessions SET solved = 1 WHERE id = ? AND solved = 0"
      );
      const returnToManualReview = db.prepare(
        `UPDATE approval_records
         SET status = 'pending', reason = ?, operator_id = NULL, processed_at = NULL
         WHERE id = ? AND status = 'captcha'`
      );
      for (const session of retired) {
        closeSession.run(session.id);
        returnToManualReview.run("captcha_active_session_limit_migration", session.approval_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { active, retired };
  }
  async _sendReconciliationNotice(userId, retired) {
    const groups = retired.slice(0, 10).map((session) => session.group_id).join(", ");
    const suffix = retired.length > 10 ? ` and ${retired.length - 10} more` : "";
    await this._sendNotice(
      userId,
      `For safety, ${retired.length} older verification request(s) were returned to manual review (group ${groups}${suffix}). Your newest ${MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER} sessions remain selectable.`
    );
  }
  _selectAnswer(sessions, rawMessage) {
    const trimmed = rawMessage.trim();
    if (sessions.length === 1 && timingSafeEqual(this._digest(trimmed), this._digest(sessions[0].answer))) {
      return { session: sessions[0], answer: trimmed };
    }
    const firstWhitespace = trimmed.search(/\s/);
    const firstToken = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
    const explicitAnswer = firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace).trim();
    const looksExplicit = CHALLENGE_CODE_PATTERN.test(firstToken);
    if (firstToken.startsWith("#") && !looksExplicit) return null;
    if (looksExplicit) {
      if (!explicitAnswer) return null;
      const suppliedCode = firstToken.slice(1);
      const selected = sessions.find(
        (session) => timingSafeEqual(
          Buffer.from(captchaChallengeCode(session.id).toLowerCase()),
          Buffer.from(suppliedCode.toLowerCase())
        )
      );
      return selected ? { session: selected, answer: explicitAnswer } : null;
    }
    return sessions.length === 1 ? { session: sessions[0], answer: trimmed } : null;
  }
  async _sendSelectionHint(userId, sessions) {
    const choices = sessions.slice(0, MAX_ACTIVE_CAPTCHA_SESSIONS_PER_USER).map((session) => `#${captchaChallengeCode(session.id)} \u2014 group ${session.group_id}`).join("\n");
    const instruction = sessions.length === 1 ? `Reply with your answer, or use "#${captchaChallengeCode(sessions[0].id)} <answer>".` : 'Multiple verification sessions are pending. Reply with "#<code> <answer>" for the intended group.';
    await this._sendNotice(userId, `${instruction}

${choices}`);
  }
  async _approveSessionLocked(session) {
    const rec = approvalRepo.findById(session.approval_id);
    if (!rec || rec.status !== "captcha") {
      this._closeSession(session.id);
      return;
    }
    let approved;
    try {
      approved = await approvalService.approveAfterCaptcha(rec);
    } catch (error) {
      this._closeSession(session.id);
      getLogger().child({ module: "captcha" }).warn(
        { approval_id: session.approval_id, session_id: session.id },
        "Captcha answer accepted, but OneBot approval failed; queued for manual review"
      );
      await this._sendNotice(session.user_id, "Verification was received, but your join request is pending administrator review.");
      return;
    }
    this._closeSession(session.id);
    if (!approved) return;
    statisticsRepo.bump(session.group_id, "captchas_passed");
    await this._sendNotice(session.user_id, "\u2705 Verification passed! Your join request has been approved.");
  }
  async _rejectSessionLocked(session, reason, notice) {
    const rec = approvalRepo.findById(session.approval_id);
    if (!rec || rec.status !== "captcha") {
      this._closeSession(session.id);
      return;
    }
    let rejected;
    try {
      rejected = await approvalService.rejectAfterCaptchaFail(rec, reason);
    } catch (error) {
      this._closeSession(session.id);
      getLogger().child({ module: "captcha" }).warn(
        { approval_id: session.approval_id, session_id: session.id },
        "Captcha rejection failed; queued for manual review"
      );
      await this._sendNotice(session.user_id, "Verification could not be completed. Your join request is pending administrator review.");
      return;
    }
    this._closeSession(session.id);
    if (rejected) await this._sendNotice(session.user_id, notice);
  }
  _findSession(id) {
    return getDatabase().prepare("SELECT * FROM captcha_sessions WHERE id = ?").get(id) ?? null;
  }
  _closeSession(id) {
    getDatabase().prepare("UPDATE captcha_sessions SET solved = 1 WHERE id = ? AND solved = 0").run(id);
  }
  _markApprovalPending(approvalId, code) {
    getDatabase().prepare(
      `UPDATE approval_records
         SET status = 'pending', reason = ?, operator_id = NULL, processed_at = NULL
         WHERE id = ? AND status = 'captcha'`
    ).run(code, approvalId);
  }
  _digest(value) {
    return createHash2("sha256").update(value.trim().toLowerCase()).digest();
  }
  async _sendNotice(userId, message) {
    try {
      await callOneBot("send_private_msg", { user_id: String(userId), message });
    } catch (error) {
      getLogger().child({ module: "captcha" }).warn(
        { user_id: userId },
        "Could not send captcha private message"
      );
    }
  }
  _generate(type) {
    if (type === "question") {
      const qs = configManager.get().captcha.questions;
      if (qs.length > 0) {
        const q = qs[Math.floor(Math.random() * qs.length)];
        return { challenge: q.q, answer: q.a.trim().toLowerCase() };
      }
    }
    if (type === "text") {
      const n = Math.floor(Math.random() * 9e3) + 1e3;
      return { challenge: `Please reply with the number: ${n}`, answer: String(n) };
    }
    const ops = ["+", "-", "*"];
    const op = ops[Math.floor(Math.random() * ops.length)];
    const a = Math.floor(Math.random() * 20) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    const result = op === "+" ? a + b : op === "-" ? a - b : a * b;
    return { challenge: `\u{1F522} Math verification: What is ${a} ${op} ${b}? Reply with the number only.`, answer: String(result) };
  }
  _buildMsg(challenge, ttlSeconds, code, groupId) {
    return `\u{1F44B} Welcome! Please complete verification for group ${groupId}.

Session code: #${code}
${challenge}

\u23F1 You have ${Math.round(ttlSeconds / 60)} minute(s) to answer. Reply "#${code} <answer>" when you have multiple pending sessions; with only one, the answer alone still works.`;
  }
  _tryStartExpiryAction(session) {
    if (this._expiringSessions.has(session.id) || this._activeExpiryActions >= CAPTCHA_EXPIRY_SWEEP_CONCURRENCY) return null;
    const action = this._rejectExpiredSessionIfAvailable(session);
    this._expiringSessions.set(session.id, action);
    void action.finally(() => {
      if (this._expiringSessions.get(session.id) === action) {
        this._expiringSessions.delete(session.id);
      }
    }).catch(() => void 0);
    return action;
  }
  async _rejectExpiredSessionIfAvailable(candidate) {
    await tryWithLock(locks.captcha(candidate.approval_id), async () => {
      const session = this._findSession(candidate.id);
      if (!session || session.solved !== 0) return;
      if (this._activeExpiryActions >= CAPTCHA_EXPIRY_SWEEP_CONCURRENCY) return;
      this._activeExpiryActions += 1;
      try {
        await this._rejectSessionLocked(
          session,
          "Captcha expired",
          "\u23F0 Verification timed out. Your join request has been rejected."
        );
      } finally {
        this._activeExpiryActions -= 1;
      }
    });
  }
  async _awaitExpiryAction(action, timeoutMs) {
    let timer = null;
    try {
      await Promise.race([
        action,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Captcha expiry provider action exceeded ${timeoutMs}ms`)),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
};
var captchaService = new CaptchaService();

// src/modules/risk/ai.ts
var MAX_AI_RESPONSE_BYTES = 1024 * 1024;
var PRIVATE_AI_ENDPOINTS_ENV = "QQ_GUARDIAN_ALLOW_PRIVATE_AI_ENDPOINTS";
function privateAIEndpointOverrideEnabled(value = process.env[PRIVATE_AI_ENDPOINTS_ENV]) {
  return value === "true";
}
function privateAIEndpointStartupWarning(value = process.env[PRIVATE_AI_ENDPOINTS_ENV]) {
  if (!privateAIEndpointOverrideEnabled(value)) return null;
  return `${PRIVATE_AI_ENDPOINTS_ENV} is active. AI requests may reach private network addresses over HTTP. Only use with a trusted local AI endpoint.`;
}
function localProviderPolicy() {
  return privateAIEndpointOverrideEnabled() ? { allowPrivateNetwork: true, allowHttp: true } : {};
}
function completionUrl(baseUrl) {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", normalized);
}
var DisabledAI = class {
  async analyzeRisk() {
    return { ok: false, error: "AI provider is disabled" };
  }
};
var OpenAICompatibleAI = class {
  async analyzeRisk(text) {
    const cfg = configManager.get().ai;
    const policy = cfg.provider === "custom" ? localProviderPolicy() : {};
    let endpoint;
    try {
      endpoint = completionUrl(cfg.baseUrl);
      await validateRemoteUrl(endpoint, policy);
    } catch {
      return { ok: false, error: "AI provider endpoint is not permitted" };
    }
    try {
      const response = await fetchRemote(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: cfg.riskPrompt },
            { role: "user", content: text }
          ],
          response_format: { type: "json_object" },
          max_tokens: 200
        })
      }, {
        ...policy,
        timeoutMs: Math.max(1e3, Math.min(cfg.timeoutMs, 12e4))
      });
      if (!response.ok) {
        await releaseRemoteResponse(response);
        return { ok: false, error: `AI HTTP ${response.status}` };
      }
      const json = await readResponseJson(response, MAX_AI_RESPONSE_BYTES);
      const content = json.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content);
      return {
        ok: true,
        data: {
          score: Math.min(100, Math.max(0, Number(parsed.score) || 0)),
          reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 2e3) : "",
          tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => typeof tag === "string").slice(0, 20) : []
        }
      };
    } catch {
      return { ok: false, error: "AI request failed" };
    }
  }
};
function createAIProvider() {
  switch (configManager.get().ai.provider) {
    case "openai":
    case "anthropic":
    case "custom":
      return new OpenAICompatibleAI();
    default:
      return new DisabledAI();
  }
}

// src/modules/risk/index.ts
import { createHash as createHash3 } from "crypto";
var BUILTIN = {
  advertising: [/加(?:我|微信|QQ|群)[：:，, ]*[\w@]+/i, /(?:推广|代理|招商|佣金|返利)/, /(?:私信|私聊)我/],
  fraud: [/(?:兼职|日结|月薪|年薪)\s*[\d万]+/, /(?:刷单|刷流水|点赞赚钱)/, /(?:免费领取|限时领取)/],
  grayMarket: [/(?:发票|洗钱|代开|空壳)/, /(?:非法|违禁品|走私)/],
  pornography: [/(?:约炮|约P|开房|一夜情)/i, /(?:裸聊|色情|黄片)/i],
  political: [/(?:推翻|颠覆|政权|敏感政治)/],
  gambling: [/(?:赌博|博彩|百家乐|老虎机|彩票代购)/, /(?:下注|押注|赌场)/],
  shortLinks: [/(?:t\.cn|suo\.im|dwz\.cn|bit\.ly|tinyurl)\//],
  spam: [/(.{5,})\1{3,}/]
};
var ACTION_SEVERITY = {
  log_only: 0,
  notify_admin: 1,
  mute: 2,
  kick: 3
};
var VALID_ACTIONS = /* @__PURE__ */ new Set(["mute", "kick", "notify_admin", "log_only", "off"]);
function normalizeRuleAction(action) {
  return VALID_ACTIONS.has(String(action)) ? String(action) : "mute";
}
function pickMostSevere(actions) {
  let winner = "log_only";
  for (const a of actions) {
    if (ACTION_SEVERITY[a] > ACTION_SEVERITY[winner]) winner = a;
  }
  return winner;
}
function hasCardSegment(segments) {
  return segments.some((s) => s.type === "json" || s.type === "miniapp");
}
var AI_MEMO_TTL_MS = 6e5;
var AI_MEMO_MAX = 500;
var RECALL_WINDOW_MS = 12e4;
var RECALL_MAX_MESSAGES = 30;
var DUP_WINDOW_MS = 1e4;
var RiskService = class {
  recentMsgs = /* @__PURE__ */ new Map();
  _lastRecentMsgSweep = 0;
  /** Enabled custom rules with their regexes compiled ONCE at load time —
   *  recompiling per message per rule was pure waste. */
  _rules = [];
  /** text-hash → AI risk score memo (bounded, insertion-order eviction). */
  _aiMemo = /* @__PURE__ */ new Map();
  async handleGroupMessage(event) {
    const cfg = configManager.get();
    const groupCfg = resolveGroupConfig(cfg, event.group_id);
    if (!groupCfg.enabled || !groupCfg.riskEnabled) return;
    this._trackMessage(event.group_id, event.user_id, event.message_id);
    const riskCfg = cfg.risk;
    const hits = await this._detect(event.raw_message, event.group_id, event.user_id);
    const cardAction = riskCfg.detectorActions.cardMessage ?? "log_only";
    if (hasCardSegment(event.message) && cardAction !== "off") {
      hits.push({ name: "cardMessage", action: cardAction });
    }
    if (hits.length === 0) return;
    const action = pickMostSevere(hits.map((h) => h.action));
    const detectorNames = hits.map((h) => h.name);
    const log = getLogger().child({ module: "risk" });
    log.warn({ group_id: event.group_id, user_id: event.user_id, detectors: detectorNames, action }, "Risk detected");
    statisticsRepo.bump(event.group_id, "risk_detections");
    const selfId = cfg.core.selfId;
    const reason = `Risk: ${detectorNames.join(", ")}`;
    try {
      switch (action) {
        case "mute":
          await punishmentService.mute(event.group_id, event.user_id, riskCfg.muteDurationSeconds, reason, selfId);
          break;
        case "kick":
          await punishmentService.kick(event.group_id, event.user_id, reason, selfId);
          break;
        case "notify_admin":
          await this._notifyAdmins(event.group_id, event.user_id, detectorNames, event.raw_message);
          break;
      }
    } catch (e) {
      log.error(e, "Punishment action failed \u2014 continuing with recall/notify");
    }
    if (riskCfg.recallMessage) {
      await this._recallRecentMessages(event.group_id, event.user_id, event.message_id);
    }
    if (groupCfg.notifyOnRisk && action !== "notify_admin") {
      await this._notifyAdmins(event.group_id, event.user_id, detectorNames, event.raw_message);
    }
  }
  _trackMessage(groupId, userId, messageId) {
    const key = `${userId}:${groupId}`;
    const now = Date.now();
    const entries = (this.recentMsgs.get(key) ?? []).filter((m) => now - m.ts < RECALL_WINDOW_MS);
    entries.push({ ts: now, id: messageId });
    if (entries.length > RECALL_MAX_MESSAGES) entries.splice(0, entries.length - RECALL_MAX_MESSAGES);
    this.recentMsgs.set(key, entries);
    if (now - this._lastRecentMsgSweep > 6e4) {
      for (const [k, v] of this.recentMsgs) {
        if (v.every((m) => now - m.ts >= RECALL_WINDOW_MS)) this.recentMsgs.delete(k);
      }
      this._lastRecentMsgSweep = now;
    }
  }
  /** Concurrent best-effort recall of the user's recent messages (including
   *  the triggering one). Never throws; logs a single summary on failures. */
  async _recallRecentMessages(groupId, userId, triggerMessageId) {
    const now = Date.now();
    const ids = /* @__PURE__ */ new Set([triggerMessageId]);
    for (const m of this.recentMsgs.get(`${userId}:${groupId}`) ?? []) {
      if (now - m.ts < RECALL_WINDOW_MS) ids.add(m.id);
    }
    const results = await Promise.allSettled(
      [...ids].map((id) => callOneBot("delete_msg", { message_id: id }))
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    const log = getLogger().child({ module: "risk" });
    log.info({ group_id: groupId, user_id: userId, recalled: results.length - failed, failed }, "Recalled recent risky messages");
  }
  async _notifyAdmins(groupId, userId, detectors, rawMessage) {
    for (const id of configManager.get().core.superAdmins) {
      await callOneBot("send_private_msg", { user_id: String(id), message: `\u26A0\uFE0F Risk in group ${groupId}: user ${userId}, detectors [${detectors.join(", ")}]
${rawMessage.slice(0, 100)}` }).catch(() => {
      });
    }
  }
  reloadRules() {
    const rows = getDatabase().prepare("SELECT * FROM risk_rules WHERE enabled = 1").all();
    this._rules = [];
    for (const rule of rows) {
      try {
        this._rules.push({ rule, regex: new RegExp(rule.pattern) });
      } catch {
        getLogger().child({ module: "risk" }).warn({ rule_id: rule.id, name: rule.name }, "Skipping rule with invalid pattern");
      }
    }
  }
  async addRule(data) {
    await validateRegexPattern(data.pattern);
    const now = Date.now();
    const r = getDatabase().prepare(`INSERT INTO risk_rules (name, pattern, action, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`).run(data.name, data.pattern, normalizeRuleAction(data.action), now, now);
    this.reloadRules();
    return getDatabase().prepare("SELECT * FROM risk_rules WHERE id = ?").get(Number(r.lastInsertRowid));
  }
  toggleRule(id, enabled) {
    getDatabase().prepare("UPDATE risk_rules SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, Date.now(), id);
    this.reloadRules();
  }
  /** Collects every detector and custom rule that matches this message. */
  async _detect(text, groupId, userId) {
    const cfg = configManager.get().risk;
    const hits = [];
    for (const [name, patterns] of Object.entries(BUILTIN)) {
      const act = cfg.detectorActions[name] ?? "off";
      if (act === "off") continue;
      if (patterns.some((re) => re.test(text))) hits.push({ name, action: act });
    }
    const dupAction = cfg.detectorActions.duplicateMessages ?? "off";
    if (dupAction !== "off") {
      const now = Date.now();
      const recent = (this.recentMsgs.get(`${userId}:${groupId}`) ?? []).filter((m) => now - m.ts < DUP_WINDOW_MS);
      if (recent.length >= 5) hits.push({ name: "duplicateMessages", action: dupAction });
    }
    for (const { rule, regex } of this._rules) {
      const act = normalizeRuleAction(rule.action);
      if (act === "off") continue;
      if (regex.test(text)) hits.push({ name: `rule:${rule.name}`, action: act });
    }
    void intelService.ensureFresh();
    for (const kw of intelService.getEnforcedRiskKeywords()) {
      if (kw.regex.test(text)) hits.push({ name: `cloud:${kw.name}`, action: kw.action });
    }
    const observedCloudHits = intelService.getObservedRiskKeywords().filter((keyword) => keyword.regex.test(text)).map((keyword) => keyword.name);
    if (observedCloudHits.length > 0) {
      getLogger().child({ module: "risk" }).warn({
        group_id: groupId,
        user_id: userId,
        detectors: observedCloudHits.map((name) => `cloud:${name}`),
        enforcement: "observe"
      }, "Cloud risk match observed; no message action permitted");
    }
    const aiAction = cfg.detectorActions.aiViolation ?? "off";
    if (aiAction !== "off" && hits.length === 0) {
      const hash = createHash3("md5").update(text).digest("hex");
      const memo = this._aiMemo.get(hash);
      let score = memo && Date.now() - memo.ts < AI_MEMO_TTL_MS ? memo.score : void 0;
      if (score === void 0) {
        const r = await createAIProvider().analyzeRisk(text);
        if (r.ok && r.data) {
          if (this._aiMemo.size >= AI_MEMO_MAX) {
            const oldest = this._aiMemo.keys().next().value;
            if (oldest !== void 0) this._aiMemo.delete(oldest);
          }
          this._aiMemo.set(hash, { score: r.data.score, ts: Date.now() });
          score = r.data.score;
        }
      }
      if (score !== void 0 && score >= cfg.aiMinScore) hits.push({ name: "aiViolation", action: aiAction });
    }
    return hits;
  }
};
var riskService = new RiskService();

// src/modules/commands/index.ts
var MAX_MUTE_MINUTES = 43200;
var DEFAULT_MUTE_MINUTES = 10;
var COOLDOWN_MS = 2e3;
function matchesOneBotId(value, expected) {
  return normalizeOneBotId(value) === expected;
}
function classifyTargetRoleResponse(value, groupId, userId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "unavailable", failure: "malformed_response" };
  }
  const info = value;
  const role = info["role"];
  if (role !== "member" && role !== "admin" && role !== "owner" || !matchesOneBotId(info["group_id"], groupId) || !matchesOneBotId(info["user_id"], userId)) {
    return { kind: "unavailable", failure: "malformed_response" };
  }
  return { kind: "member", role };
}
function authorizeDestructiveTarget(lookup, invokerIsOwner, isSuperAdmin) {
  if (lookup.kind === "unavailable") {
    return { allowed: false, reason: "target_role_unavailable" };
  }
  if (lookup.kind === "absent") return { allowed: false, reason: "target_absent" };
  if ((lookup.role === "admin" || lookup.role === "owner") && !invokerIsOwner && !isSuperAdmin) {
    return { allowed: false, reason: "target_privileged" };
  }
  return { allowed: true };
}
async function lookupTargetRoleViaOneBot(groupId, userId) {
  try {
    const info = await callOneBot("get_group_member_info", {
      group_id: String(groupId),
      user_id: String(userId),
      no_cache: true
    });
    return classifyTargetRoleResponse(info, groupId, userId);
  } catch {
    return { kind: "unavailable", failure: "action_failed" };
  }
}
function authorizationDenialText(reason) {
  switch (reason) {
    case "target_privileged":
      return "\u274C \u76EE\u6807\u662F\u7FA4\u4E3B/\u7BA1\u7406\u5458\uFF0C\u4EC5\u7FA4\u4E3B\u6216\u8D85\u7EA7\u7BA1\u7406\u5458\u53EF\u5BF9\u5176\u6267\u884C\u8BE5\u6307\u4EE4\u3002";
    case "target_absent":
      return "\u274C \u76EE\u6807\u5F53\u524D\u4E0D\u5728\u7FA4\u5185\uFF0C\u5DF2\u62D2\u7EDD\u8BE5\u6307\u4EE4\uFF1B\u9884\u5148\u62C9\u9ED1\u5C1A\u672A\u542F\u7528\u3002";
    case "target_role_unavailable":
      return "\u274C \u65E0\u6CD5\u786E\u8BA4\u76EE\u6807\u7684\u7FA4\u6210\u5458\u8EAB\u4EFD\uFF0C\u5DF2\u5B89\u5168\u62D2\u7EDD\u8BE5\u6307\u4EE4\u3002\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
  }
}
function extractCommandInput(message, rawMessage) {
  if (!Array.isArray(message) || message.length === 0) {
    return { text: rawMessage, atTargets: [], hasReply: false };
  }
  let text = "";
  let hasReply = false;
  const atTargets = [];
  for (const seg of message) {
    if (seg.type === "text") text += String(seg.data["text"] ?? "");
    else if (seg.type === "reply") hasReply = true;
    else if (seg.type === "at") {
      const qq = normalizeOneBotId(seg.data["qq"]);
      if (qq !== null) atTargets.push(qq);
    }
  }
  return { text, atTargets, hasReply };
}
function parseCommand(text, prefix) {
  const trimmed = text.trim();
  if (!prefix || !trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  return { name: (parts[0] ?? "help").toLowerCase(), args: parts.slice(1) };
}
function resolveTarget(input, args) {
  if (input.atTargets.length > 0) return input.atTargets[0];
  const numeric = args.find((a) => /^\d{5,20}$/.test(a));
  return numeric ? normalizeOneBotId(numeric) : null;
}
function resolveMinutes(args) {
  const numeric = args.find((a) => /^\d{1,5}$/.test(a));
  const n = numeric ? Number(numeric) : DEFAULT_MUTE_MINUTES;
  return Math.min(Math.max(n, 1), MAX_MUTE_MINUTES);
}
async function reply(groupId, text) {
  await callOneBot("send_group_msg", {
    group_id: String(groupId),
    message: [{ type: "text", data: { text } }]
  }).catch(() => {
  });
}
function helpText(prefix) {
  return [
    "\u{1F6E1}\uFE0F QQ Guardian \u6307\u4EE4\uFF1A",
    `${prefix} status \u2014 \u67E5\u770B\u672C\u7FA4\u9632\u62A4\u72B6\u6001`,
    `${prefix} mute <@\u67D0\u4EBA|QQ\u53F7> [\u5206\u949F] \u2014 \u7981\u8A00\uFF08\u9ED8\u8BA4 10 \u5206\u949F\uFF09`,
    `${prefix} unmute <@\u67D0\u4EBA|QQ\u53F7> \u2014 \u89E3\u9664\u7981\u8A00`,
    `${prefix} kick <@\u67D0\u4EBA|QQ\u53F7> \u2014 \u8E22\u51FA`,
    `${prefix} ban <@\u67D0\u4EBA|QQ\u53F7> [\u539F\u56E0] \u2014 \u62C9\u9ED1\u5E76\u8E22\u51FA\uFF08\u4EC5\u672C\u7FA4\uFF09`,
    `${prefix} unban <@\u67D0\u4EBA|QQ\u53F7> \u2014 \u79FB\u51FA\u672C\u7FA4\u9ED1\u540D\u5355`
  ].join("\n");
}
var ACTION_COMMANDS = /* @__PURE__ */ new Set(["mute", "unmute", "kick", "ban", "unban"]);
var CommandService = class {
  _lastCommandAt = /* @__PURE__ */ new Map();
  _lookupTargetRole;
  constructor(options = {}) {
    this._lookupTargetRole = options.lookupTargetRole ?? lookupTargetRoleViaOneBot;
  }
  /**
   * Returns true when the message was consumed as a command (skip risk
   * scoring), false when normal message processing should continue.
   */
  async handleGroupCommand(event) {
    const cfg = configManager.get();
    if (!cfg.commands.enabled) return false;
    const prefix = cfg.commands.prefix?.trim() || "/guard";
    const input = extractCommandInput(event.message, event.raw_message);
    const cmd = parseCommand(input.text, prefix);
    if (!cmd) return false;
    const isSuperAdmin = cfg.core.superAdmins.includes(event.user_id);
    const isAdmin = event.sender?.role === "owner" || event.sender?.role === "admin" || isSuperAdmin;
    if (!isAdmin) return false;
    const groupId = event.group_id;
    const cooldownKey = `${groupId}:${event.user_id}`;
    const now = Date.now();
    const last = this._lastCommandAt.get(cooldownKey) ?? 0;
    if (now - last < COOLDOWN_MS) return true;
    this._lastCommandAt.set(cooldownKey, now);
    if (this._lastCommandAt.size > 5e3) {
      for (const [k, v] of this._lastCommandAt) {
        if (now - v > COOLDOWN_MS) this._lastCommandAt.delete(k);
      }
    }
    const groupCfg = resolveGroupConfig(cfg, groupId);
    const log = getLogger().child({ module: "commands" });
    log.info({ group_id: groupId, user_id: event.user_id, command: cmd.name }, "Admin command received");
    try {
      switch (cmd.name) {
        case "help":
          await reply(groupId, helpText(prefix));
          break;
        case "status": {
          const lines = [
            `\u{1F6E1}\uFE0F \u672C\u7FA4\u9632\u62A4\uFF1A${groupCfg.enabled ? "\u2705 \u5DF2\u5F00\u542F" : "\u274C \u672A\u5F00\u542F"}`,
            `\u98CE\u9669\u68C0\u6D4B\uFF1A${groupCfg.riskEnabled ? "\u5F00" : "\u5173"} \xB7 \u5165\u7FA4\u5904\u7406\uFF1A${groupCfg.action}`,
            `\u9ED1\u540D\u5355\u81EA\u52A8\u8E22\u51FA\uFF1A${groupCfg.autoKickBlacklisted ? "\u5F00" : "\u5173"} \xB7 \u5165\u7FA4\u6B22\u8FCE\uFF1A${groupCfg.welcomeEnabled ? "\u5F00" : "\u5173"}`,
            `\u5BB5\u7981\uFF1A${groupCfg.curfewEnabled ? `${groupCfg.curfewStart} \u2192 ${groupCfg.curfewEnd}` : "\u5173"}`
          ];
          await reply(groupId, lines.join("\n"));
          break;
        }
        default: {
          if (!ACTION_COMMANDS.has(cmd.name)) {
            await reply(groupId, `\u2753 \u672A\u77E5\u6307\u4EE4 "${cmd.name.slice(0, 20)}"\u3002\u53D1\u9001 ${prefix} help \u67E5\u770B\u7528\u6CD5\u3002`);
            break;
          }
          if (!groupCfg.enabled) {
            await reply(groupId, "\u274C \u672C\u7FA4\u9632\u62A4\u672A\u5F00\u542F\uFF0C\u65E0\u6CD5\u6267\u884C\u7BA1\u7406\u6307\u4EE4\u3002\u8BF7\u5148\u5728 WebUI \u4E2D\u5F00\u542F\u9632\u62A4\u3002");
            break;
          }
          if (input.hasReply) {
            await reply(groupId, `\u274C \u8BF7\u4E0D\u8981\u5F15\u7528\u56DE\u590D\u4F7F\u7528\u6307\u4EE4\uFF0C\u76F4\u63A5\u53D1\u9001\uFF0C\u5982\uFF1A${prefix} mute @\u67D0\u4EBA 10`);
            break;
          }
          if (input.atTargets.length > 1) {
            await reply(groupId, "\u274C \u4E00\u6B21\u53EA\u80FD\u6307\u5B9A\u4E00\u4E2A\u76EE\u6807\u7528\u6237\u3002");
            break;
          }
          const target = resolveTarget(input, cmd.args);
          if (!target) {
            await reply(groupId, `\u274C \u7F3A\u5C11\u76EE\u6807\u7528\u6237\u3002\u7528\u6CD5\u89C1 ${prefix} help`);
            break;
          }
          if (target === event.self_id || target === cfg.core.selfId) {
            await reply(groupId, "\u274C \u4E0D\u80FD\u5BF9\u673A\u5668\u4EBA\u81EA\u8EAB\u6267\u884C\u8BE5\u6307\u4EE4\u3002");
            break;
          }
          if (cfg.core.superAdmins.includes(target) && !isSuperAdmin) {
            await reply(groupId, "\u274C \u8BE5\u7528\u6237\u662F\u8D85\u7EA7\u7BA1\u7406\u5458\uFF0C\u65E0\u6CD5\u88AB\u666E\u901A\u7BA1\u7406\u5458\u5904\u7406\u3002");
            break;
          }
          if (cmd.name === "mute" || cmd.name === "kick" || cmd.name === "ban") {
            const targetLookup = await this._lookupTargetRole(groupId, target);
            const authorization = authorizeDestructiveTarget(
              targetLookup,
              event.sender?.role === "owner",
              isSuperAdmin
            );
            if (!authorization.allowed) {
              const denialDetails = {
                groupId,
                command: cmd.name,
                reason: authorization.reason,
                lookupStatus: targetLookup.kind
              };
              if (targetLookup.kind === "unavailable") {
                denialDetails["lookupFailure"] = targetLookup.failure;
              }
              log.warn(
                {
                  group_id: groupId,
                  user_id: event.user_id,
                  target_id: target,
                  command: cmd.name,
                  reason: authorization.reason,
                  lookup_status: targetLookup.kind,
                  ...targetLookup.kind === "unavailable" ? { lookup_failure: targetLookup.failure } : {}
                },
                "Destructive command denied by target authorization"
              );
              bus.emit("AuditCreated", {
                action: "command.authorization_denied",
                actorId: event.user_id,
                targetType: "user",
                targetId: String(target),
                details: denialDetails,
                timestamp: Date.now()
              });
              await reply(groupId, authorizationDenialText(authorization.reason));
              break;
            }
          }
          await this._runAction(cmd.name, groupId, target, cmd.args, event.user_id);
        }
      }
    } catch (e) {
      log.error({ group_id: groupId, command: cmd.name, error: String(e) }, "Command failed");
      await reply(groupId, "\u274C \u6267\u884C\u5931\u8D25\uFF08\u673A\u5668\u4EBA\u53EF\u80FD\u4E0D\u662F\u7BA1\u7406\u5458\uFF0C\u6216\u76EE\u6807\u65E0\u6CD5\u88AB\u5904\u7406\uFF09\u3002\u8BE6\u60C5\u89C1\u65E5\u5FD7\u3002");
    }
    bus.emit("AuditCreated", {
      action: `command.${cmd.name}`,
      actorId: event.user_id,
      targetType: "group",
      targetId: String(groupId),
      details: { args: cmd.args, atTargets: input.atTargets },
      timestamp: Date.now()
    });
    return true;
  }
  async _runAction(name, groupId, target, args, operatorId2) {
    switch (name) {
      case "mute": {
        const minutes = resolveMinutes(args.filter((a) => normalizeOneBotId(a) !== target));
        await punishmentService.mute(groupId, target, minutes * 60, `\u7FA4\u5185\u6307\u4EE4\uFF08\u64CD\u4F5C\u4EBA ${operatorId2}\uFF09`, operatorId2);
        await reply(groupId, `\u{1F507} \u5DF2\u7981\u8A00 ${target} ${minutes} \u5206\u949F\u3002`);
        break;
      }
      case "unmute": {
        const now = Date.now();
        const activeMutes = punishmentRepo.findByUser(target, groupId).filter((r) => r.type === "mute" && r.revoked_at === null && (r.expires_at === null || r.expires_at > now));
        for (const r of activeMutes) punishmentRepo.revoke(r.id, operatorId2);
        await punishmentService.unban(groupId, target, operatorId2);
        await reply(groupId, `\u{1F50A} \u5DF2\u89E3\u9664 ${target} \u7684\u7981\u8A00\u3002`);
        break;
      }
      case "kick":
        await punishmentService.kick(groupId, target, `\u7FA4\u5185\u6307\u4EE4\uFF08\u64CD\u4F5C\u4EBA ${operatorId2}\uFF09`, operatorId2);
        await reply(groupId, `\u{1F462} \u5DF2\u8E22\u51FA ${target}\u3002`);
        break;
      case "ban": {
        const reason = args.filter((a) => !/^\d+$/.test(a)).join(" ").slice(0, 100) || "\u7FA4\u5185\u6307\u4EE4\u62C9\u9ED1";
        await punishmentService.kick(groupId, target, reason, operatorId2);
        blacklistRepo.add({ userId: target, groupId, reason, createdBy: operatorId2 });
        await reply(groupId, `\u26D4 \u5DF2\u5C06 ${target} \u52A0\u5165\u672C\u7FA4\u9ED1\u540D\u5355\u5E76\u8E22\u51FA\u3002`);
        break;
      }
      case "unban": {
        blacklistRepo.remove(target, groupId);
        const activeKicks = punishmentRepo.findByUser(target, groupId).filter((r) => r.type === "kick" && r.revoked_at === null);
        for (const r of activeKicks) punishmentRepo.revoke(r.id, operatorId2);
        await reply(groupId, `\u2705 \u5DF2\u5C06 ${target} \u79FB\u51FA\u672C\u7FA4\u9ED1\u540D\u5355\u3002`);
        break;
      }
    }
  }
};
var commandService = new CommandService();

// src/handlers/message.ts
async function plugin_onmessage(_runtime, providerEvent) {
  let correlationId = null;
  try {
    const event = normalizeOB11Message(providerEvent);
    if (!event) {
      correlationId = recordProviderEventDrop();
      getLogger().child({ module: "message" }).warn(
        { correlation_id: correlationId },
        "Ignoring malformed message event"
      );
      return;
    }
    correlationId = recordProviderEvent();
    if (event.post_type === "message_sent" || event.user_id === event.self_id) return;
    if (event.message_type === "private") {
      await captchaService.handlePrivateMessage(event);
      return;
    }
    if (event.message_type === "group") {
      if (await commandService.handleGroupCommand(event)) return;
      await riskService.handleGroupMessage(event);
      return;
    }
  } catch (e) {
    getLogger().child({ module: "message" }).error(
      { correlation_id: correlationId, error: e },
      "Error handling message"
    );
  }
}

// src/modules/blacklist/index.ts
async function handleBlacklistMemberJoin(event) {
  const config = configManager.get();
  const groupConfig = resolveGroupConfig(config, event.groupId);
  if (!groupConfig.enabled) return "continue";
  if (!groupConfig.autoKickBlacklisted || !blacklistRepo.isBlacklisted(event.userId, event.groupId)) {
    if (groupConfig.notifyOnJoin) await notifyJoin(config.core.superAdmins, event);
    return "continue";
  }
  const log = getLogger().child({ module: "blacklist" });
  log.info(
    { user_id: event.userId, group_id: event.groupId },
    "Auto-kicking blacklisted user"
  );
  try {
    await punishmentService.kick(
      event.groupId,
      event.userId,
      "Blacklisted user",
      config.core.selfId
    );
  } catch (error) {
    log.error(error, "Blacklist auto-kick failed");
  }
  if (groupConfig.notifyOnJoin) await notifyJoin(config.core.superAdmins, event);
  return "stop";
}
async function notifyJoin(superAdmins, event) {
  for (const id of superAdmins) {
    await callOneBot("send_private_msg", {
      user_id: String(id),
      message: `\u{1F464} \u7528\u6237 ${event.userId} \u52A0\u5165\u4E86\u7FA4 ${event.groupId}`
    }).catch(() => {
    });
  }
}

// src/modules/welcome/index.ts
var DEFAULT_TEMPLATE = "\u{1F44B} \u6B22\u8FCE {user} \u52A0\u5165 {group}\uFF01\u8BF7\u5148\u9605\u8BFB\u7FA4\u516C\u544A\u3002";
function buildWelcomeSegments(template, userId, groupName, groupId) {
  const text = (template.trim() || DEFAULT_TEMPLATE).replaceAll("{group}", groupName || String(groupId));
  const at = { type: "at", data: { qq: String(userId) } };
  const parts = text.split("{user}");
  const segments = [];
  parts.forEach((part, i) => {
    if (i > 0) segments.push(at);
    if (part) segments.push({ type: "text", data: { text: part } });
  });
  if (parts.length === 1) segments.unshift(at, { type: "text", data: { text: " " } });
  return segments;
}
var USER_COOLDOWN_MS = 10 * 6e4;
var GROUP_MIN_INTERVAL_MS = 3e3;
var _lastUserWelcome = /* @__PURE__ */ new Map();
var _lastGroupWelcome = /* @__PURE__ */ new Map();
async function sendWelcomeForMemberJoin(event) {
  const config = configManager.get();
  const groupConfig = resolveGroupConfig(config, event.groupId);
  if (!groupConfig.enabled || !groupConfig.welcomeEnabled) return;
  const now = Date.now();
  const userKey = `${event.groupId}:${event.userId}`;
  if (now - (_lastUserWelcome.get(userKey) ?? 0) < USER_COOLDOWN_MS) return;
  if (now - (_lastGroupWelcome.get(event.groupId) ?? 0) < GROUP_MIN_INTERVAL_MS) return;
  _lastUserWelcome.set(userKey, now);
  _lastGroupWelcome.set(event.groupId, now);
  if (_lastUserWelcome.size > 5e3) {
    for (const [key, timestamp] of _lastUserWelcome) {
      if (now - timestamp > USER_COOLDOWN_MS) _lastUserWelcome.delete(key);
    }
  }
  await callOneBot("send_group_msg", {
    group_id: String(event.groupId),
    message: buildWelcomeSegments(
      groupConfig.welcomeTemplate,
      event.userId,
      groupConfig.groupName,
      event.groupId
    )
  });
}

// src/application/member-join.ts
async function runMemberJoinPipeline(event, stages2, onStageError = () => {
}) {
  for (const stage of stages2) {
    try {
      if (await stage.run(event) === "stop") {
        return { status: "stopped", stage: stage.name };
      }
    } catch (error) {
      onStageError(stage.name, error);
      return { status: "failed", stage: stage.name };
    }
  }
  return { status: "completed" };
}
var stages = [
  { name: "blacklist", run: handleBlacklistMemberJoin },
  {
    name: "punishment",
    async run(event) {
      return await punishmentService.checkAndReapplyOnJoin(event.groupId, event.userId) ? "stop" : "continue";
    }
  },
  { name: "intel", run: (event) => intelService.handleMemberJoin(event) },
  {
    name: "welcome",
    async run(event) {
      await sendWelcomeForMemberJoin(event);
      return "continue";
    }
  }
];
async function handleMemberJoin(event) {
  return withLock(locks.memberJoin(event.groupId, event.userId), async () => {
    const config = configManager.get();
    if (event.userId === config.core.selfId || !resolveGroupConfig(config, event.groupId).enabled) {
      return { status: "ignored" };
    }
    return runMemberJoinPipeline(event, stages, (stage, error) => {
      getLogger().child({ module: "member-join" }).error(
        { stage, group_id: event.groupId, user_id: event.userId, error },
        "Member-join stage failed; skipping remaining stages"
      );
    });
  });
}

// src/handlers/event.ts
async function plugin_onevent(_runtime, providerEvent) {
  let correlationId = null;
  try {
    const event = normalizeOB11Event(providerEvent);
    if (!event) {
      correlationId = recordProviderEventDrop();
      getLogger().child({ module: "event" }).warn(
        { correlation_id: correlationId },
        "Ignoring malformed non-message event"
      );
      return;
    }
    const rawEvent = providerEvent !== null && typeof providerEvent === "object" ? providerEvent : {};
    correlationId = recordProviderEvent(
      rawEvent["post_type"] === "meta_event" && rawEvent["meta_event_type"] === "heartbeat"
    );
    if (event.post_type === "request") {
      const req = event;
      if (req.request_type === "group" && req.sub_type === "add") {
        await approvalService.handleJoinRequest(req);
      }
      return;
    }
    if (event.post_type === "notice") {
      const notice = event;
      if (notice.notice_type === "group_increase") {
        if (!notice.group_id || !notice.user_id) {
          getLogger().child({ module: "event" }).warn(
            "Ignoring group-increase notice without valid identifiers"
          );
          return;
        }
        await handleMemberJoin({
          groupId: notice.group_id,
          userId: notice.user_id,
          subType: notice.sub_type === "invite" ? "invite" : "approve",
          timestamp: notice.time * 1e3
        });
      }
      return;
    }
  } catch (e) {
    getLogger().child({ module: "event" }).error(
      { correlation_id: correlationId, error: e },
      "Error handling event"
    );
  }
}

// src/lifecycle.ts
import { join as join7, dirname as dirname3 } from "node:path";
import { chmodSync as chmodSync4, readFileSync as readFileSync4, existsSync as existsSync7, mkdirSync as mkdirSync6 } from "node:fs";

// src/database/repositories/audit.ts
var AuditRepository = class {
  log(data) {
    getDatabase().prepare(
      `INSERT INTO audit_logs (action, actor_id, target_type, target_id, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      data.action,
      data.actorId ?? null,
      data.targetType ?? null,
      data.targetId ?? null,
      JSON.stringify(data.details ?? {}),
      Date.now()
    );
  }
  findAll(opts = {}) {
    const { action, actorId, limit = 50, offset = 0 } = opts;
    const where = [];
    const vals = [];
    if (action) {
      where.push("action = ?");
      vals.push(action);
    }
    if (actorId !== void 0) {
      where.push("actor_id = ?");
      vals.push(actorId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    vals.push(limit, offset);
    return getDatabase().prepare(`SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...vals);
  }
  logLogin(data) {
    getDatabase().prepare(
      `INSERT INTO login_logs (user_id, ip, user_agent, success, created_at)
         VALUES (?, ?, ?, ?, ?)`
    ).run(data.userId, data.ip, data.userAgent ?? null, data.success ? 1 : 0, Date.now());
  }
  /**
   * Prune only historical rows that can no longer affect live moderation or
   * admission state. Permanent/active punishments and pending admissions are
   * deliberately retained. The caller supplies an absolute cutoff so policy
   * remains explicit and testable.
   */
  pruneHistory(cutoffMs) {
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new RangeError("retention cutoff must be a non-negative integer");
    const db = getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const auditLogs = Number(db.prepare("DELETE FROM audit_logs WHERE created_at < ?").run(cutoffMs).changes);
      const loginLogs = Number(db.prepare("DELETE FROM login_logs WHERE created_at < ?").run(cutoffMs).changes);
      const captchaSessions = Number(db.prepare("DELETE FROM captcha_sessions WHERE expires_at < ?").run(cutoffMs).changes);
      const approvals = Number(db.prepare(
        `DELETE FROM approval_records
         WHERE status NOT IN ('pending', 'captcha')
           AND created_at < ?
           AND expires_at < ?`
      ).run(cutoffMs, cutoffMs).changes);
      const punishments = Number(db.prepare(
        `DELETE FROM punishment_records
         WHERE created_at < ?
           AND (
             (revoked_at IS NOT NULL AND revoked_at < ?)
             OR (expires_at IS NOT NULL AND expires_at < ?)
           )`
      ).run(cutoffMs, cutoffMs, cutoffMs).changes);
      db.exec("COMMIT");
      return { auditLogs, loginLogs, approvals, punishments, captchaSessions };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
};
var auditRepo = new AuditRepository();

// src/modules/audit/index.ts
var AUDIT_RETENTION_DAYS = 90;
var AUDIT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var retentionTimer = null;
function pruneRetainedHistory() {
  const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
  try {
    const pruned = auditRepo.pruneHistory(cutoff);
    const total = Object.values(pruned).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      getLogger().child({ module: "audit" }).info({ retentionDays: AUDIT_RETENTION_DAYS, ...pruned }, "Historical records pruned");
    }
  } catch (error) {
    getLogger().child({ module: "audit" }).warn(error, "Historical retention prune failed");
  }
}
function initAuditModule() {
  bus.on("AuditCreated", (payload) => {
    auditRepo.log({
      action: payload.action,
      actorId: payload.actorId ?? void 0,
      targetType: payload.targetType ?? void 0,
      targetId: payload.targetId ?? void 0,
      details: payload.details
    });
  });
  pruneRetainedHistory();
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = setInterval(pruneRetainedHistory, AUDIT_RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}
function stopAuditModule() {
  if (!retentionTimer) return;
  clearInterval(retentionTimer);
  retentionTimer = null;
}

// src/modules/curfew/index.ts
var TICK_MS = 3e4;
var SHUTDOWN_UNMUTE_TIMEOUT_MS = 1e4;
var _timer = null;
var _tickPromise = null;
var _configChangedListener = null;
var _running = false;
var _generation2 = 0;
var _startEpoch = 0;
var _stopPromise = null;
var _lastApplied = /* @__PURE__ */ new Map();
var _warnedInvalid = /* @__PURE__ */ new Set();
function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function isInCurfewWindow(nowMinutes, startMinutes, endMinutes) {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}
function minutesOfDayIn(timeZone, date) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h % 24 * 60 + m;
  } catch {
    return null;
  }
}
function isCurrent(generation2) {
  return _running && generation2 === _generation2;
}
async function applyState(generation2, groupId, enable, curfewEnd) {
  if (!isCurrent(generation2)) return;
  const log = getLogger().child({ module: "curfew" });
  const prev = _lastApplied.get(groupId);
  await callOneBot("set_group_whole_ban", { group_id: String(groupId), enable });
  _lastApplied.set(groupId, enable);
  if (!isCurrent(generation2)) return;
  log.info({ group_id: groupId, enable }, enable ? "Curfew started \u2014 whole-group mute on" : "Curfew ended \u2014 whole-group mute lifted");
  bus.emit("AuditCreated", {
    action: enable ? "curfew.start" : "curfew.end",
    actorId: null,
    targetType: "group",
    targetId: String(groupId),
    details: { enable },
    timestamp: Date.now()
  });
  if (enable && prev !== void 0) {
    await callOneBot("send_group_msg", {
      group_id: String(groupId),
      message: [{ type: "text", data: { text: `\u{1F319} \u5BB5\u7981\u5F00\u59CB\uFF0C\u5168\u7FA4\u7981\u8A00\u81F3 ${curfewEnd}\u3002` } }]
    }).catch(() => {
    });
  } else if (prev === true) {
    await callOneBot("send_group_msg", {
      group_id: String(groupId),
      message: [{ type: "text", data: { text: "\u2600\uFE0F \u5BB5\u7981\u7ED3\u675F\uFF0C\u5DF2\u89E3\u9664\u5168\u7FA4\u7981\u8A00\u3002" } }]
    }).catch(() => {
    });
  }
}
async function tick(generation2) {
  if (!isCurrent(generation2)) return;
  const cfg = configManager.get();
  const log = getLogger().child({ module: "curfew" });
  const nowMinutes = minutesOfDayIn(cfg.core.timezone, /* @__PURE__ */ new Date()) ?? (/* @__PURE__ */ new Date()).getHours() * 60 + (/* @__PURE__ */ new Date()).getMinutes();
  for (const gidStr of Object.keys(cfg.approval.groups)) {
    if (!isCurrent(generation2)) return;
    const groupId = gidStr;
    const groupCfg = resolveGroupConfig(cfg, groupId);
    let desired = false;
    if (groupCfg.enabled && groupCfg.curfewEnabled) {
      const start = parseHHMM(groupCfg.curfewStart);
      const end = parseHHMM(groupCfg.curfewEnd);
      if (start === null || end === null) {
        if (!_warnedInvalid.has(groupId)) {
          _warnedInvalid.add(groupId);
          log.warn({ group_id: groupId, start: groupCfg.curfewStart, end: groupCfg.curfewEnd }, "Invalid curfew time \u2014 treating curfew as disabled");
        }
      } else {
        _warnedInvalid.delete(groupId);
        desired = isInCurfewWindow(nowMinutes, start, end);
      }
    } else if (!_lastApplied.get(groupId)) {
      _lastApplied.set(groupId, false);
      continue;
    }
    if (_lastApplied.get(groupId) === desired) continue;
    try {
      await applyState(generation2, groupId, desired, groupCfg.curfewEnd);
    } catch (e) {
      log.error({ group_id: groupId, desired, error: String(e) }, "Failed to apply curfew state");
    }
  }
}
function scheduleTick(generation2) {
  if (!isCurrent(generation2)) return Promise.resolve();
  if (_tickPromise) return _tickPromise;
  const task = tick(generation2).catch((error) => {
    getLogger().child({ module: "curfew" }).error(error, "Curfew scheduler tick failed");
  });
  _tickPromise = task;
  void task.then(
    () => {
      if (_tickPromise === task) _tickPromise = null;
    },
    () => {
      if (_tickPromise === task) _tickPromise = null;
    }
  );
  return task;
}
async function callBeforeDeadline(action, params, deadline) {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error("OneBot action skipped because the shutdown deadline elapsed");
  let timeout = null;
  try {
    await Promise.race([
      callOneBot(action, params),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`OneBot action timed out before the ${SHUTDOWN_UNMUTE_TIMEOUT_MS}ms shutdown deadline`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
async function unmuteManagedGroups() {
  const log = getLogger().child({ module: "curfew" });
  const managedMutedGroups = [..._lastApplied].filter(([, enabled]) => enabled).map(([groupId]) => groupId);
  const deadline = Date.now() + SHUTDOWN_UNMUTE_TIMEOUT_MS;
  await Promise.all(managedMutedGroups.map(async (groupId) => {
    try {
      await callBeforeDeadline("set_group_whole_ban", { group_id: String(groupId), enable: false }, deadline);
      _lastApplied.set(groupId, false);
      bus.emit("AuditCreated", {
        action: "curfew.end",
        actorId: null,
        targetType: "group",
        targetId: String(groupId),
        details: { enable: false, reason: "plugin_shutdown" },
        timestamp: Date.now()
      });
      log.info({ group_id: groupId }, "Lifted Guardian-managed curfew during shutdown");
    } catch (error) {
      log.warn({ group_id: groupId, error: String(error) }, "Could not lift Guardian-managed curfew during shutdown");
    }
  }));
}
async function initCurfewModule() {
  const startEpoch = ++_startEpoch;
  await stopCurfewModuleInternal(false);
  if (startEpoch !== _startEpoch) return;
  _running = true;
  const generation2 = ++_generation2;
  _timer = setInterval(() => {
    void scheduleTick(generation2);
  }, TICK_MS);
  _configChangedListener = () => {
    void scheduleTick(generation2);
  };
  bus.on("ConfigChanged", _configChangedListener);
  await scheduleTick(generation2);
}
async function stopCurfewModuleInternal(invalidateStart) {
  if (invalidateStart) _startEpoch += 1;
  if (_stopPromise) return _stopPromise;
  _running = false;
  _generation2 += 1;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_configChangedListener) {
    bus.off("ConfigChanged", _configChangedListener);
    _configChangedListener = null;
  }
  const inFlightTick = _tickPromise;
  const task = (async () => {
    if (inFlightTick) await inFlightTick;
    await unmuteManagedGroups();
    _lastApplied.clear();
    _warnedInvalid.clear();
  })();
  _stopPromise = task;
  try {
    await task;
  } finally {
    if (_stopPromise === task) _stopPromise = null;
  }
}
async function stopCurfewModule() {
  await stopCurfewModuleInternal(true);
}

// src/modules/statistics/index.ts
var _timer2 = null;
var EXPIRED_BLACKLIST_BATCH_SIZE = 250;
function initStatisticsModule() {
  runHourlyMaintenance();
  _timer2 = setInterval(runHourlyMaintenance, 36e5);
}
function stopStatisticsModule() {
  if (_timer2) {
    clearInterval(_timer2);
    _timer2 = null;
  }
}
function runHourlyMaintenance() {
  const log = getLogger().child({ module: "statistics" });
  try {
    const expiredApprovals = approvalRepo.expireOldPending();
    const expiredBlacklist = blacklistRepo.purgeExpired(EXPIRED_BLACKLIST_BATCH_SIZE);
    if (expiredApprovals > 0 || expiredBlacklist > 0) {
      log.debug({ expiredApprovals, expiredBlacklist }, "Expired Guardian operational state");
    }
  } catch (error) {
    log.error(error, "Maintenance error");
  }
}
function getOverviewStats() {
  return {
    totals: statisticsRepo.totals(),
    approvalCounts: approvalRepo.countByStatus(),
    recent30Days: statisticsRepo.findRecent(30)
  };
}

// src/modules/monitor/index.ts
import { freemem, totalmem } from "os";
import { statfsSync } from "fs";
var _timer3 = null;
var _lastStatus = buildEmpty();
var PROVIDER_RECONNECT_GRACE_MS = 3e4;
function buildEmpty() {
  return { healthy: true, status: "healthy", timestamp: 0, components: {} };
}
function initMonitorModule() {
  const cfg = configManager.get().monitor;
  runHealthChecks();
  _timer3 = setInterval(runHealthChecks, cfg.intervalMs);
}
function stopMonitorModule() {
  if (_timer3) {
    clearInterval(_timer3);
    _timer3 = null;
  }
}
function getLastHealthStatus() {
  try {
    const components = {
      ..._lastStatus.components,
      provider: providerHealthComponent(getProviderTelemetry())
    };
    _lastStatus = summarize(components, Date.now());
  } catch {
  }
  return _lastStatus;
}
function providerHealthComponent(snapshot) {
  const detail = { ...snapshot };
  if (snapshot.state === "connected") {
    const lastActivityAt = Math.max(snapshot.lastSuccessAt ?? 0, snapshot.lastEventAt ?? 0);
    const unresolvedFailure = snapshot.lastErrorAt !== null && snapshot.lastErrorAt > lastActivityAt;
    return unresolvedFailure ? {
      status: "warn",
      message: `Provider last operation failed (${snapshot.lastErrorCategory ?? "unknown"})`,
      detail
    } : { status: "ok", detail };
  }
  if (snapshot.state === "connecting" || snapshot.state === "reconnecting") {
    const withinGrace = snapshot.stateAgeMs < PROVIDER_RECONNECT_GRACE_MS;
    return {
      status: withinGrace ? "warn" : "error",
      message: withinGrace ? `Provider ${snapshot.state}; reconnect grace active` : `Provider ${snapshot.state} beyond ${PROVIDER_RECONNECT_GRACE_MS}ms grace`,
      detail
    };
  }
  if (snapshot.state === "unknown") {
    return { status: "warn", message: "Provider connection state is unknown", detail };
  }
  return {
    status: "error",
    message: snapshot.state === "auth_failed" ? "Provider authentication failed" : "Provider is disconnected",
    detail
  };
}
function summarize(components, timestamp) {
  const anyError = Object.values(components).some((component) => component.status === "error");
  const anyWarning = Object.values(components).some((component) => component.status === "warn");
  const status = anyError ? "unhealthy" : anyWarning ? "degraded" : "healthy";
  return {
    healthy: status !== "unhealthy",
    status,
    timestamp,
    components
  };
}
function runHealthChecks() {
  const cfg = configManager.get().monitor;
  const components = {};
  try {
    components["provider"] = providerHealthComponent(getProviderTelemetry());
  } catch {
    components["provider"] = { status: "error", message: "Provider telemetry unavailable" };
  }
  try {
    getDatabase().prepare("SELECT 1").get();
    components["database"] = { status: "ok" };
  } catch (err) {
    components["database"] = { status: "error", message: String(err) };
  }
  try {
    const free = freemem();
    const total = totalmem();
    const usedPercent = Math.round((total - free) / total * 100);
    components["memory"] = {
      status: usedPercent > cfg.memoryAlertPercent ? "warn" : "ok",
      detail: { usedPercent, freeMb: Math.round(free / 1024 / 1024) }
    };
  } catch {
    components["memory"] = { status: "error", message: "Could not read memory stats" };
  }
  try {
    const stats = statfsSync(getRuntimeHost().paths.dataPath);
    const freeMb = Math.round(stats.bfree * stats.bsize / 1024 / 1024);
    components["disk"] = {
      status: freeMb < cfg.diskAlertMb ? "warn" : "ok",
      detail: { freeMb }
    };
  } catch {
    components["disk"] = { status: "error", message: "Could not read disk stats" };
  }
  const allOk = Object.values(components).every((component) => component.status === "ok");
  _lastStatus = summarize(components, Date.now());
  if (!allOk) {
    getLogger().child({ module: "monitor" }).warn({ components }, "Health check warning");
  }
  return _lastStatus;
}

// src/modules/approval/sync.ts
function extractPendingJoinRequests(payload) {
  if (!payload || typeof payload !== "object") return [];
  const p = payload;
  const raw = [p["join_requests"], p["JoinRequest"], p["joinRequests"]].find(Array.isArray);
  const out = [];
  for (const entry of raw ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry;
    if (e["checked"]) continue;
    const flagSrc = e["request_id"] ?? e["flag"];
    if (flagSrc === void 0 || flagSrc === null || flagSrc === "") continue;
    const groupId = normalizeOneBotId(e["group_id"]);
    const userId = normalizeOneBotId(e["requester_uin"] ?? e["user_id"] ?? e["invitor_uin"]);
    if (groupId === null || userId === null) continue;
    out.push({
      flag: String(flagSrc),
      groupId,
      userId,
      comment: typeof e["message"] === "string" ? e["message"] : typeof e["comment"] === "string" ? e["comment"] : ""
    });
  }
  return out;
}
var _timer4 = null;
var _running2 = false;
async function syncPendingJoinRequests() {
  if (_running2) return 0;
  _running2 = true;
  const log = getLogger().child({ module: "approval" });
  try {
    const payload = await callOneBot("get_group_system_msg", {});
    const pending = extractPendingJoinRequests(payload);
    let processed = 0;
    const cfg = configManager.get();
    for (const req of pending) {
      if (!resolveGroupConfig(cfg, req.groupId).enabled) continue;
      if (approvalRepo.findByFlag(req.flag)) continue;
      processed++;
      log.info({ group_id: req.groupId, user_id: req.userId, flag: req.flag }, "Admission sync: picking up join request missed by the event stream");
      await approvalService.handleJoinRequest({
        time: Math.floor(Date.now() / 1e3),
        self_id: cfg.core.selfId,
        post_type: "request",
        request_type: "group",
        sub_type: "add",
        group_id: req.groupId,
        user_id: req.userId,
        comment: req.comment,
        flag: req.flag
      }).catch((e) => log.error(e, "Admission sync: failed to process join request"));
    }
    return processed;
  } catch (e) {
    log.warn({ error: e instanceof Error ? e.message : String(e) }, "Admission sync: could not fetch group system messages");
    return 0;
  } finally {
    _running2 = false;
  }
}
function armTimer() {
  if (_timer4) {
    clearInterval(_timer4);
    _timer4 = null;
  }
  const cfg = configManager.get().approval;
  if (!cfg.realtimeSyncEnabled) return;
  const intervalMs = Math.max(10, cfg.syncIntervalSeconds || 30) * 1e3;
  _timer4 = setInterval(() => void syncPendingJoinRequests(), intervalMs);
}
function initApprovalSync() {
  armTimer();
  bus.on("ConfigChanged", () => armTimer());
  void syncPendingJoinRequests();
}
function stopApprovalSync() {
  if (_timer4) {
    clearInterval(_timer4);
    _timer4 = null;
  }
}

// src/modules/auth/index.ts
import { chmodSync as chmodSync2, closeSync as closeSync2, existsSync as existsSync3, openSync as openSync2, readFileSync as readFileSync2, renameSync as renameSync3, unlinkSync as unlinkSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { randomBytes as randomBytes3, randomUUID as randomUUID3 } from "node:crypto";
import { join as join3 } from "node:path";

// src/core/crypto/index.ts
import { createHmac, randomBytes as randomBytes2, scrypt, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { promisify } from "node:util";
var SCRYPT_N = 16384;
var SCRYPT_R = 8;
var SCRYPT_P = 1;
var SCRYPT_DKLEN = 32;
var SCRYPT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
var SCRYPT_MAX_COST_MEMORY_BYTES = 32 * 1024 * 1024;
var SCRYPT_MAX_WORK = 524288;
var JWT_KEY_DERIVATION_CONTEXT = "qq-guardian:jwt-signing:v1";
var scryptAsync = promisify(scrypt);
async function hashPassword(plain) {
  const salt = randomBytes2(16).toString("hex");
  const derived = await deriveScrypt(plain, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt:v2:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt}:${derived.toString("hex")}`;
}
function parseCanonicalInteger(value) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function hasSafeScryptCost(N, r, p) {
  if (N < 1024 || N > 65536 || (N & N - 1) !== 0) return false;
  if (r < 1 || r > 16 || p < 1 || p > 4) return false;
  return 128 * N * r <= SCRYPT_MAX_COST_MEMORY_BYTES && N * r * p <= SCRYPT_MAX_WORK;
}
function parseScryptHash(hash) {
  const parts = hash.split(":");
  if (parts.length === 4 && parts[0] === "scrypt" && parts[1] === "v1") {
    const [, , salt2, storedHex2] = parts;
    if (!/^[0-9a-f]{32}$/.test(salt2) || !/^[0-9a-f]{64}$/.test(storedHex2)) return null;
    return { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt2, storedHex: storedHex2 };
  }
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v1" && parts[1] !== "v2") return null;
  const [, , nText, rText, pText, salt, storedHex] = parts;
  const N = parseCanonicalInteger(nText);
  const r = parseCanonicalInteger(rText);
  const p = parseCanonicalInteger(pText);
  if (N === null || r === null || p === null || !hasSafeScryptCost(N, r, p)) return null;
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(storedHex)) return null;
  return { N, r, p, salt, storedHex };
}
function deriveScrypt(plain, salt, N, r, p) {
  return scryptAsync(plain, salt, SCRYPT_DKLEN, { N, r, p, maxmem: SCRYPT_MAX_MEMORY_BYTES });
}
async function verifyPassword(hash, plain) {
  const parsed = parseScryptHash(hash);
  if (!parsed) return false;
  try {
    const derived = await deriveScrypt(plain, parsed.salt, parsed.N, parsed.r, parsed.p);
    const stored = Buffer.from(parsed.storedHex, "hex");
    return derived.length === stored.length && timingSafeEqual2(derived, stored);
  } catch {
    return false;
  }
}
function parseExpirySeconds(value) {
  const match = String(value).match(/^(\d+)(s|m|h|d)?$/);
  if (!match) return 7200;
  return Number.parseInt(match[1], 10) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? "s"] ?? 1);
}
function jwtSigningKey(type) {
  return createHmac("sha256", configManager.get().webui.jwtSecret).update(`${JWT_KEY_DERIVATION_CONTEXT}:${type}`).digest();
}
function jwtSign(payload, secret, expiresIn) {
  const issuedAt = Math.floor(Date.now() / 1e3);
  const expiresAt = issuedAt + parseExpirySeconds(expiresIn);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, iat: issuedAt, exp: expiresAt })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}
function jwtVerify(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [header, body, signature] = parts;
  const headerPayload = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  if (headerPayload.alg !== "HS256" || headerPayload.typ !== "JWT") throw new Error("Unsupported token header");
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  const actualBuffer = Buffer.from(signature, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual2(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid signature");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!Number.isInteger(payload.sub) || typeof payload.jti !== "string" || payload.jti.length < 16) {
    throw new Error("Malformed payload");
  }
  if (payload.type !== "access" && payload.type !== "refresh") throw new Error("Malformed token type");
  const expiration = payload.exp;
  if (typeof expiration !== "number" || !Number.isInteger(expiration) || Math.floor(Date.now() / 1e3) >= expiration) {
    throw new Error("Token expired");
  }
  return payload;
}
function untrustedTokenType(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.type === "access" || payload.type === "refresh" ? payload.type : null;
  } catch {
    return null;
  }
}
function signAccessToken(payload) {
  return jwtSign({ ...payload, type: "access" }, jwtSigningKey("access"), configManager.get().webui.jwtExpiresIn);
}
function signRefreshToken(payload) {
  return jwtSign({ ...payload, type: "refresh" }, jwtSigningKey("refresh"), configManager.get().webui.refreshExpiresIn);
}
function verifyToken(token) {
  const type = untrustedTokenType(token);
  if (!type) return null;
  try {
    const payload = jwtVerify(token, jwtSigningKey(type));
    return payload.type === type ? payload : null;
  } catch {
    return null;
  }
}
function verifyAccessToken(token) {
  const payload = verifyToken(token);
  if (!payload || payload.type !== "access" || typeof payload.role !== "string") return null;
  return payload;
}

// src/database/repositories/session.ts
var AuthSessionRepository = class {
  create(data) {
    getDatabase().prepare(
      `INSERT INTO auth_sessions (token_id, user_id, kind, issued_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).run(data.tokenId, data.userId, data.kind, data.issuedAt, data.expiresAt);
  }
  findActive(tokenId, userId, kind, now = Date.now()) {
    return getDatabase().prepare(
      `SELECT * FROM auth_sessions
       WHERE token_id = ? AND user_id = ? AND kind = ? AND revoked_at IS NULL AND expires_at > ?`
    ).get(tokenId, userId, kind, now) ?? null;
  }
  revoke(tokenId, now = Date.now()) {
    const result = getDatabase().prepare(
      "UPDATE auth_sessions SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL"
    ).run(now, tokenId);
    return Number(result.changes) > 0;
  }
  revokeAllForUser(userId, now = Date.now()) {
    const result = getDatabase().prepare(
      "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
    ).run(now, userId);
    return Number(result.changes);
  }
  purgeExpired(now = Date.now()) {
    const result = getDatabase().prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
    return Number(result.changes);
  }
};
var authSessionRepo = new AuthSessionRepository();

// src/database/repositories/user.ts
var LAST_USABLE_SUPER_ADMIN_MESSAGE = "At least one unlocked, password-enabled super administrator must remain";
var UserAdminMutationError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "UserAdminMutationError";
    this.code = code;
  }
};
function isUsableSuperAdmin(user, now = Date.now()) {
  return user.role === "super_admin" && Boolean(user.username?.trim()) && Boolean(user.password_hash) && (user.locked_until === null || user.locked_until <= now);
}
var UserRepository = class {
  findById(id) {
    return getDatabase().prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null;
  }
  findByUsername(username) {
    return getDatabase().prepare("SELECT * FROM users WHERE username = ?").get(username) ?? null;
  }
  findAll() {
    return getDatabase().prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  }
  countUsableSuperAdmins(now = Date.now()) {
    return this.countOtherUsableSuperAdmins(null, now);
  }
  createByAdministrator(data, actorId) {
    return this.immediateTransaction(() => {
      const user = this.insert(data);
      this.writeAudit({
        action: "auth.user_created",
        actorId,
        targetId: user.id,
        details: {
          username: user.username,
          qqId: user.qq_id,
          role: user.role
        }
      });
      return user;
    });
  }
  /**
   * First-install bootstrap. The users-table emptiness check is repeated under
   * the write lock so bootstrap cannot add privilege to a nonempty installation
   * and two startup paths cannot both create an initial administrator.
   */
  createBootstrapAdmin(data) {
    return this.immediateTransaction(() => {
      const existing = getDatabase().prepare("SELECT id FROM users LIMIT 1").get();
      if (existing) return null;
      const user = this.insert(data);
      this.writeAudit({
        action: "auth.bootstrap_admin_created",
        targetId: user.id,
        details: { username: user.username }
      });
      return user;
    });
  }
  /**
   * Explicit, startup-only break-glass recovery. A newly usable administrator
   * wins the race: recovery becomes a no-op after BEGIN IMMEDIATE rechecks the
   * invariant.
   */
  recoverSuperAdmin(data) {
    return this.immediateTransaction(() => {
      const now = Date.now();
      if (this.countOtherUsableSuperAdmins(null, now) > 0) return null;
      const existing = this.findByUsername(data.username);
      let user;
      let mode;
      let sessionsRevoked = 0;
      if (existing) {
        getDatabase().prepare(
          `UPDATE users
           SET password_hash = ?, role = 'super_admin', login_attempts = 0,
               locked_until = NULL, updated_at = ?
           WHERE id = ?`
        ).run(data.passwordHash, now, existing.id);
        sessionsRevoked = this.revokeSessions(existing.id, now);
        user = this.findById(existing.id);
        mode = "reset";
      } else {
        user = this.insert({
          username: data.username,
          passwordHash: data.passwordHash,
          role: "super_admin"
        }, now);
        mode = "created";
      }
      this.writeAudit({
        action: "auth.super_admin_recovered",
        targetId: user.id,
        details: {
          username: user.username,
          mode,
          previousRole: existing?.role ?? null,
          sessionsRevoked,
          source: "startup_break_glass"
        },
        now
      });
      return { user, mode, sessionsRevoked };
    });
  }
  updateByAdministrator(id, data, actorId) {
    const outcome = this.immediateTransaction(() => {
      const now = Date.now();
      const current = this.findById(id);
      if (!current) {
        const error = new UserAdminMutationError("user_not_found", "User not found");
        this.writeRejectedAudit(actorId, id, "update", error, Object.keys(data), now);
        return { error };
      }
      const projected = {
        ...current,
        password_hash: data.passwordHash ?? current.password_hash,
        role: data.role ?? current.role,
        login_attempts: data.loginAttempts ?? current.login_attempts,
        locked_until: data.lockedUntil === void 0 ? current.locked_until : data.lockedUntil
      };
      const changedFields = this.changedAdministrativeFields(current, projected);
      if (changedFields.length === 0) return { value: current };
      if (isUsableSuperAdmin(current, now) && !isUsableSuperAdmin(projected, now) && this.countOtherUsableSuperAdmins(id, now) === 0) {
        const error = new UserAdminMutationError(
          "last_usable_super_admin",
          LAST_USABLE_SUPER_ADMIN_MESSAGE
        );
        this.writeRejectedAudit(actorId, id, "update", error, changedFields, now, {
          currentRole: current.role,
          requestedRole: projected.role
        });
        return { error };
      }
      this.applyAdministrativeUpdate(id, data, now);
      const sessionsRevoked = this.revokeSessions(id, now);
      const updated = this.findById(id);
      this.writeAudit({
        action: "auth.user_updated",
        actorId,
        targetId: id,
        details: {
          changedFields,
          previousRole: current.role,
          role: updated.role,
          sessionsRevoked
        },
        now
      });
      return { value: updated };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }
  deleteByAdministrator(id, actorId) {
    const outcome = this.immediateTransaction(() => {
      const now = Date.now();
      const current = this.findById(id);
      if (!current) {
        const error = new UserAdminMutationError("user_not_found", "User not found");
        this.writeRejectedAudit(actorId, id, "delete", error, [], now);
        return { error };
      }
      if (id === actorId) {
        const error = new UserAdminMutationError("self_delete", "Cannot delete your own account");
        this.writeRejectedAudit(actorId, id, "delete", error, [], now);
        return { error };
      }
      if (isUsableSuperAdmin(current, now) && this.countOtherUsableSuperAdmins(id, now) === 0) {
        const error = new UserAdminMutationError(
          "last_usable_super_admin",
          LAST_USABLE_SUPER_ADMIN_MESSAGE
        );
        this.writeRejectedAudit(actorId, id, "delete", error, [], now);
        return { error };
      }
      const sessions = getDatabase().prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?").get(id);
      this.writeAudit({
        action: "auth.user_deleted",
        actorId,
        targetId: id,
        details: {
          username: current.username,
          role: current.role,
          sessionsRemoved: Number(sessions.count)
        },
        now
      });
      getDatabase().prepare("DELETE FROM users WHERE id = ?").run(id);
      return { value: null };
    });
    if ("error" in outcome) throw outcome.error;
  }
  /** Login-state writes are intentionally narrower than administrator writes. */
  updateAuthenticationState(id, data) {
    const sets = [];
    const values = [];
    if (data.lastLogin !== void 0) {
      sets.push("last_login = ?");
      values.push(data.lastLogin);
    }
    if (data.loginAttempts !== void 0) {
      sets.push("login_attempts = ?");
      values.push(data.loginAttempts);
    }
    if (data.lockedUntil !== void 0) {
      sets.push("locked_until = ?");
      values.push(data.lockedUntil);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(Date.now(), id);
    getDatabase().prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  recordLoginFailure(id, maxAttempts, lockedUntil) {
    const row = getDatabase().prepare(
      `UPDATE users
       SET login_attempts = login_attempts + 1,
           locked_until = CASE WHEN login_attempts + 1 >= ? THEN ? ELSE locked_until END,
           updated_at = ?
       WHERE id = ?
       RETURNING login_attempts, locked_until`
    ).get(maxAttempts, lockedUntil, Date.now(), id);
    if (!row) return null;
    return { attempts: row.login_attempts, locked: row.locked_until !== null && row.locked_until >= lockedUntil };
  }
  resetLoginAttempts(id) {
    this.updateAuthenticationState(id, { loginAttempts: 0, lockedUntil: null, lastLogin: Date.now() });
  }
  insert(data, now = Date.now()) {
    const result = getDatabase().prepare(
      `INSERT INTO users (qq_id, username, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(data.qqId ?? null, data.username ?? null, data.passwordHash ?? null, data.role, now, now);
    return this.findById(Number(result.lastInsertRowid));
  }
  applyAdministrativeUpdate(id, data, now) {
    const sets = [];
    const values = [];
    if (data.passwordHash !== void 0) {
      sets.push("password_hash = ?");
      values.push(data.passwordHash);
    }
    if (data.role !== void 0) {
      sets.push("role = ?");
      values.push(data.role);
    }
    if (data.loginAttempts !== void 0) {
      sets.push("login_attempts = ?");
      values.push(data.loginAttempts);
    }
    if (data.lockedUntil !== void 0) {
      sets.push("locked_until = ?");
      values.push(data.lockedUntil);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(now, id);
    getDatabase().prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  changedAdministrativeFields(current, projected) {
    const changed = [];
    if (current.password_hash !== projected.password_hash) changed.push("password");
    if (current.role !== projected.role) changed.push("role");
    if (current.login_attempts !== projected.login_attempts) changed.push("loginAttempts");
    if (current.locked_until !== projected.locked_until) changed.push("lockedUntil");
    return changed;
  }
  countOtherUsableSuperAdmins(excludedId, now) {
    const exclusion = excludedId === null ? "" : "AND id <> ?";
    const values = [now];
    if (excludedId !== null) values.push(excludedId);
    const row = getDatabase().prepare(
      `SELECT COUNT(*) AS count
       FROM users
       WHERE role = 'super_admin'
         AND username IS NOT NULL AND length(trim(username)) > 0
         AND password_hash IS NOT NULL AND length(password_hash) > 0
         AND (locked_until IS NULL OR locked_until <= ?)
         ${exclusion}`
    ).get(...values);
    return Number(row.count);
  }
  revokeSessions(userId, now) {
    const result = getDatabase().prepare(
      "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
    ).run(now, userId);
    return Number(result.changes);
  }
  writeRejectedAudit(actorId, targetId, attemptedAction, error, changedFields, now, details = {}) {
    this.writeAudit({
      action: "auth.user_mutation_rejected",
      actorId,
      targetId,
      details: {
        attemptedAction,
        reason: error.code,
        changedFields,
        ...details
      },
      now
    });
  }
  writeAudit(data) {
    getDatabase().prepare(
      `INSERT INTO audit_logs (action, actor_id, target_type, target_id, details, created_at)
       VALUES (?, ?, 'user', ?, ?, ?)`
    ).run(
      data.action,
      data.actorId === void 0 ? null : String(data.actorId),
      String(data.targetId),
      JSON.stringify(data.details),
      data.now ?? Date.now()
    );
  }
  immediateTransaction(operation) {
    const database = getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
};
var userRepo = new UserRepository();

// src/modules/auth/index.ts
var LEGACY_CREDENTIALS_FILENAME = "credentials.txt";
var BOOTSTRAP_CREDENTIALS_FILENAME = "bootstrap-credentials.json";
var BOOTSTRAP_SCHEMA_VERSION = 1;
var FORCE_BOOTSTRAP_RECOVERY_ENV = "QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY";
var MIN_PASSWORD_LENGTH = 12;
var ROLE_RANK = {
  super_admin: 5,
  group_admin: 4,
  auditor: 3,
  viewer: 2,
  member: 1
};
function hasRole(userRole, required) {
  return ROLE_RANK[userRole] >= ROLE_RANK[required];
}
function validatePasswordForCreation(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 1024) return "Password is too long";
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
    return "Password must contain uppercase, lowercase, digit, and special character";
  }
  return null;
}
function normalizeUsername(value) {
  const username = value.trim();
  if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) return null;
  return username;
}
function issueTokens(user) {
  const accessId = randomUUID3();
  const refreshId = randomUUID3();
  const accessToken = signAccessToken({ sub: user.id, role: user.role, jti: accessId });
  const refreshToken = signRefreshToken({ sub: user.id, jti: refreshId });
  const accessPayload = verifyAccessToken(accessToken);
  const refreshPayload = verifyToken(refreshToken);
  if (!accessPayload?.exp || !refreshPayload?.exp) throw new Error("Could not issue session tokens");
  const now = Date.now();
  authSessionRepo.purgeExpired(now);
  authSessionRepo.create({ tokenId: accessId, userId: user.id, kind: "access", issuedAt: now, expiresAt: accessPayload.exp * 1e3 });
  authSessionRepo.create({ tokenId: refreshId, userId: user.id, kind: "refresh", issuedAt: now, expiresAt: refreshPayload.exp * 1e3 });
  return { accessToken, refreshToken };
}
function bootstrapPath(dataPath) {
  return join3(dataPath, BOOTSTRAP_CREDENTIALS_FILENAME);
}
function removeFile(path) {
  try {
    if (existsSync3(path)) unlinkSync3(path);
  } catch {
  }
}
function writePrivateBootstrap(path, username, password) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID3()}`;
  let descriptor = null;
  try {
    descriptor = openSync2(temporary, "wx", 384);
    writeFileSync2(descriptor, `${JSON.stringify({
      schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
      username,
      password,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2)}
`, "utf8");
    closeSync2(descriptor);
    descriptor = null;
    renameSync3(temporary, path);
    try {
      chmodSync2(path, 384);
    } catch {
    }
  } catch (error) {
    if (descriptor !== null) closeSync2(descriptor);
    removeFile(temporary);
    throw error;
  }
}
function readJsonBootstrap(path) {
  try {
    const value = JSON.parse(readFileSync2(path, "utf8"));
    const username = typeof value["username"] === "string" ? normalizeUsername(value["username"]) : null;
    const password = typeof value["password"] === "string" ? value["password"] : "";
    if (value["schemaVersion"] !== BOOTSTRAP_SCHEMA_VERSION || !username || !password) return null;
    return { username, password };
  } catch {
    return null;
  }
}
var BOOTSTRAP_CREDENTIALS_ERROR = "Both valid QQ_GUARDIAN_BOOTSTRAP_USERNAME and QQ_GUARDIAN_BOOTSTRAP_PASSWORD are required";
function configuredBootstrapCredentials() {
  const configuredUsername = process.env["QQ_GUARDIAN_BOOTSTRAP_USERNAME"]?.trim() ?? "";
  const configuredPassword = process.env["QQ_GUARDIAN_BOOTSTRAP_PASSWORD"] ?? "";
  if (!configuredUsername && !configuredPassword) return null;
  const username = normalizeUsername(configuredUsername);
  if (!username || !configuredPassword || validatePasswordForCreation(configuredPassword)) {
    throw new Error(BOOTSTRAP_CREDENTIALS_ERROR);
  }
  return { username, password: configuredPassword };
}
function bootstrapCredentials(dataPath) {
  const configured = configuredBootstrapCredentials();
  if (configured) return { ...configured, oneTimeFile: false };
  const oneTimePath = bootstrapPath(dataPath);
  if (existsSync3(oneTimePath)) {
    const credentials2 = readJsonBootstrap(oneTimePath);
    if (!credentials2) throw new Error("Bootstrap credential file is malformed; replace it with explicit bootstrap environment credentials");
    return { ...credentials2, oneTimeFile: true };
  }
  const credentials = { username: "admin", password: randomBytes3(24).toString("base64url") };
  writePrivateBootstrap(oneTimePath, credentials.username, credentials.password);
  return { ...credentials, oneTimeFile: true };
}
function discardLegacyCredentialFile(dataPath) {
  removeFile(join3(dataPath, LEGACY_CREDENTIALS_FILENAME));
}
async function ensureBootstrapAdmin() {
  const { dataPath } = getRuntimeHost().paths;
  const recoverySetting = process.env[FORCE_BOOTSTRAP_RECOVERY_ENV]?.trim() ?? "";
  if (recoverySetting && recoverySetting !== "0" && recoverySetting !== "1") {
    throw new Error(`${FORCE_BOOTSTRAP_RECOVERY_ENV} must be 0, 1, or unset`);
  }
  const forceRecovery = recoverySetting === "1";
  const recoveryCredentials = forceRecovery ? configuredBootstrapCredentials() : null;
  if (forceRecovery && !recoveryCredentials) throw new Error(BOOTSTRAP_CREDENTIALS_ERROR);
  const users = userRepo.findAll();
  if (users.some((user) => isUsableSuperAdmin(user))) {
    discardLegacyCredentialFile(dataPath);
    return;
  }
  if (users.length > 0 && !forceRecovery) {
    discardLegacyCredentialFile(dataPath);
    console.warn(
      "[qq-guardian] No currently usable super administrator exists. Startup recovery is disabled; wait for a temporary lock to expire or follow the documented break-glass recovery procedure."
    );
    return;
  }
  const credentials = recoveryCredentials ? { ...recoveryCredentials, oneTimeFile: false } : bootstrapCredentials(dataPath);
  const passwordHash = await hashPassword(credentials.password);
  const recovered = forceRecovery ? userRepo.recoverSuperAdmin({ username: credentials.username, passwordHash }) : userRepo.createBootstrapAdmin({
    username: credentials.username,
    passwordHash,
    role: "super_admin"
  });
  if (!recovered) {
    discardLegacyCredentialFile(dataPath);
    return;
  }
  removeFile(join3(dataPath, LEGACY_CREDENTIALS_FILENAME));
  if (!credentials.oneTimeFile) removeFile(bootstrapPath(dataPath));
  console.info(
    forceRecovery ? "[qq-guardian] Break-glass super-administrator recovery completed and audited. Remove QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY before the next start; no secret was written to logs." : "[qq-guardian] Bootstrap administrator created. Read the local one-time bootstrap credential file or use the configured environment credential; no secret was written to logs."
  );
}
function consumeBootstrapAfterLogin(user) {
  if (user.role === "super_admin") removeFile(bootstrapPath(getRuntimeHost().paths.dataPath));
}
async function login(usernameInput, password, ip, userAgent) {
  const username = normalizeUsername(usernameInput);
  const config = configManager.get().auth;
  const user = username ? userRepo.findByUsername(username) : null;
  if (!user?.password_hash) return { ok: false, error: "Invalid credentials" };
  if (user.locked_until && Date.now() < user.locked_until) return { ok: false, error: "Account temporarily locked" };
  if (!await verifyPassword(user.password_hash, password)) {
    const outcome = userRepo.recordLoginFailure(user.id, config.maxLoginAttempts, Date.now() + config.lockoutSeconds * 1e3);
    auditRepo.logLogin({ userId: user.id, ip, userAgent, success: false });
    return { ok: false, error: outcome?.locked ? "Account temporarily locked" : "Invalid credentials" };
  }
  userRepo.resetLoginAttempts(user.id);
  auditRepo.logLogin({ userId: user.id, ip, userAgent, success: true });
  consumeBootstrapAfterLogin(user);
  return { ok: true, ...issueTokens(user) };
}
function refreshTokens(refreshToken) {
  const payload = verifyToken(refreshToken);
  if (!payload || payload.type !== "refresh") return null;
  if (!authSessionRepo.findActive(payload.jti, payload.sub, "refresh")) return null;
  const user = userRepo.findById(payload.sub);
  if (!user || user.locked_until && Date.now() < user.locked_until) return null;
  if (!authSessionRepo.revoke(payload.jti)) return null;
  return issueTokens(user);
}
function authenticateAccessToken(token) {
  const payload = verifyAccessToken(token);
  if (!payload || !authSessionRepo.findActive(payload.jti, payload.sub, "access")) return null;
  const user = userRepo.findById(payload.sub);
  if (!user || user.locked_until && Date.now() < user.locked_until || user.role !== payload.role) return null;
  return { user, role: user.role };
}
function logout(token) {
  const payload = verifyToken(token);
  if (payload) authSessionRepo.revoke(payload.jti);
}

// src/database/repositories/rate-limit.ts
var CLEANUP_INTERVAL_MS = 6e4;
var LoginRateLimitRepository = class {
  lastCleanupAt = 0;
  consume(scope, bucketKey, limit, windowMs, now = Date.now()) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("rate-limit limit must be a positive integer");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError("rate-limit window must be a positive integer");
    if (!bucketKey) throw new TypeError("rate-limit bucket key must not be empty");
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
    ).get(scope, bucketKey, resetAt, now, now, now);
    return {
      allowed: row.attempts <= limit,
      attempts: row.attempts,
      resetAt: row.reset_at
    };
  }
  pruneExpired(now = Date.now(), force = false) {
    if (!force && now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return 0;
    this.lastCleanupAt = now;
    const result = getDatabase().prepare("DELETE FROM login_rate_limits WHERE reset_at <= ?").run(now);
    return Number(result.changes);
  }
  clearForTests() {
    getDatabase().prepare("DELETE FROM login_rate_limits").run();
    this.lastCleanupAt = 0;
  }
};
var loginRateLimitRepo = new LoginRateLimitRepository();

// src/modules/groups/index.ts
var _botInfo;
var _groupList;
var RETRY_ATTEMPTS = 3;
var RETRY_DELAY_MS = 1500;
function sleep(ms) {
  return new Promise((resolve4) => setTimeout(resolve4, ms));
}
function nonNegativeCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function normalizeBotInfoResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const info = value;
  const userId = normalizeOneBotId(info["user_id"]);
  return userId !== null && typeof info["nickname"] === "string" ? { user_id: userId, nickname: info["nickname"] } : null;
}
function normalizeGroupListResponse(value) {
  if (!Array.isArray(value)) return null;
  const groups = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const group = entry;
    const groupId = normalizeOneBotId(group["group_id"]);
    const memberCount = nonNegativeCount(group["member_count"]);
    const maxMemberCount = nonNegativeCount(group["max_member_count"]);
    if (groupId === null || typeof group["group_name"] !== "string" || memberCount === null || maxMemberCount === null) return null;
    groups.push({
      group_id: groupId,
      group_name: group["group_name"],
      member_count: memberCount,
      max_member_count: maxMemberCount
    });
  }
  return groups;
}
async function fetchBotInfo() {
  const log = getLogger().child({ module: "groups" });
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const info = normalizeBotInfoResponse(await callOneBot("get_login_info", {}));
      if (!info) {
        throw new Error("get_login_info returned an unexpected shape");
      }
      log.info({ user_id: info.user_id, nickname: info.nickname, attempt }, "Bot account info fetched");
      _botInfo = info;
      const cfg = configManager.get();
      if (cfg.core.selfId !== info.user_id) {
        configManager.update({ core: { selfId: info.user_id } });
      }
      return info;
    } catch (err) {
      log.error(
        { attempt, maxAttempts: RETRY_ATTEMPTS, error: String(err) },
        "Failed to fetch bot account info"
      );
      if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  log.error("Bot account info fetch exhausted all retries \u2014 group list pull will be skipped this boot");
  return null;
}
async function fetchGroupList() {
  const log = getLogger().child({ module: "groups" });
  try {
    const list = normalizeGroupListResponse(await callOneBot("get_group_list", {}));
    if (!list) throw new Error("get_group_list returned an unexpected shape");
    log.info({ count: list.length }, "Group list fetched");
    _groupList = list;
    return list;
  } catch (err) {
    log.error({ error: String(err) }, "Failed to fetch group list");
    return null;
  }
}
function mergeGroupsIntoConfig(groups) {
  const cfg = configManager.get();
  const existing = cfg.approval.groups;
  const merged = {};
  for (const g of groups) {
    const gid = g.group_id;
    const prior = existing[gid];
    if (prior) {
      merged[gid] = { groupName: g.group_name };
    } else {
      merged[gid] = buildNewGroupConfig(cfg, g.group_name);
    }
  }
  if (Object.keys(merged).length > 0) {
    configManager.update({ approval: { groups: merged } });
  }
}
async function bootstrapGroups() {
  const log = getLogger().child({ module: "groups" });
  const bot = await fetchBotInfo();
  if (!bot) return;
  const groups = await fetchGroupList();
  if (!groups) return;
  mergeGroupsIntoConfig(groups);
  log.info({ groupCount: groups.length }, "Group bootstrap complete");
}
function getCachedBotInfo() {
  return _botInfo;
}
function getCachedGroupList() {
  return _groupList;
}

// src/modules/update/index.ts
import { createHash as createHash4 } from "node:crypto";
import { createReadStream, existsSync as existsSync4, mkdirSync as mkdirSync3, renameSync as renameSync4, unlinkSync as unlinkSync4 } from "node:fs";
import { join as join4 } from "node:path";
var ALLOWED_DOWNLOAD_ORIGINS = /* @__PURE__ */ new Set([
  "github.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
  "releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com"
]);
var GITHUB_API_ORIGINS = /* @__PURE__ */ new Set(["api.github.com"]);
var MAX_RELEASE_METADATA_BYTES = 2 * 1024 * 1024;
var MAX_UPDATE_BYTES = 100 * 1024 * 1024;
var MAX_CHECKSUM_BYTES = 16 * 1024;
var MAX_RELEASE_VERSION_LENGTH = 128;
var LEGACY_RELEASE_TAG_PREFIX = "napcat-plugin-qq-guardianv";
var SEMVER_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function validateDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid download URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Downloads must use credential-free HTTPS URLs without custom ports");
  }
  if (!ALLOWED_DOWNLOAD_ORIGINS.has(url.hostname.toLowerCase())) {
    throw new Error("Downloads from this host are not permitted");
  }
}
function normalizeReleaseVersion(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RELEASE_VERSION_LENGTH) return null;
  const candidate = value.startsWith(LEGACY_RELEASE_TAG_PREFIX) ? `v${value.slice(LEGACY_RELEASE_TAG_PREFIX.length)}` : value;
  const match = SEMVER_TAG.exec(candidate);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4];
  if (prerelease?.split(".").some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return null;
  }
  return `${match[1]}.${match[2]}.${match[3]}${prerelease ? `-${prerelease}` : ""}${match[5] ? `+${match[5]}` : ""}`;
}
var currentVersion = "1.0.0";
function setCurrentVersion(version7) {
  currentVersion = version7;
}
function getCurrentVersion() {
  return currentVersion;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeDownloadUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    validateDownloadUrl(value);
    return new URL(value).href;
  } catch {
    return null;
  }
}
function releasePageUrl(value, repo, tag) {
  const [owner, name] = repo.split("/");
  const fallback = `https://github.com/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/releases/tag/${encodeURIComponent(tag)}`;
  if (typeof value !== "string" || value.length > 2048) return fallback;
  try {
    const url = new URL(value);
    const expectedPrefix = `/${owner}/${name}/releases/`;
    if (url.origin !== "https://github.com" || url.username || url.password || !url.pathname.startsWith(expectedPrefix)) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}
function releaseAssetUrl(value, repo, tag, assetName) {
  const safe = safeDownloadUrl(value);
  if (!safe) return null;
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra !== void 0) return null;
  try {
    const url = new URL(safe);
    if (url.origin !== "https://github.com") return null;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.length !== 6 || segments[0] !== owner || segments[1] !== name || segments[2] !== "releases" || segments[3] !== "download" || segments[4] !== tag || segments[5] !== assetName) return null;
    return url.href;
  } catch {
    return null;
  }
}
function selectReleaseAssetPair(assets, runtimeKind, version7, repo, tag) {
  const acceptedArchiveNames = runtimeKind === "napcat" ? [`napcat-plugin-qq-guardian-v${version7}.zip`, "napcat-plugin-qq-guardian.zip"] : runtimeKind === "snowluma" ? [`qq-guardian-snowluma-v${version7}.zip`, "qq-guardian-snowluma.zip"] : [];
  for (const archiveName of acceptedArchiveNames) {
    const archiveMatches = assets.filter((asset) => asset["name"] === archiveName);
    if (archiveMatches.length === 0) continue;
    if (archiveMatches.length !== 1) return { downloadUrl: null, checksumUrl: null };
    const checksumName = `${archiveName}.sha256`;
    const checksumMatches = assets.filter((asset) => asset["name"] === checksumName);
    if (checksumMatches.length !== 1) return { downloadUrl: null, checksumUrl: null };
    const downloadUrl = releaseAssetUrl(archiveMatches[0]?.["browser_download_url"], repo, tag, archiveName);
    const checksumUrl = releaseAssetUrl(checksumMatches[0]?.["browser_download_url"], repo, tag, checksumName);
    return downloadUrl && checksumUrl ? { downloadUrl, checksumUrl } : { downloadUrl: null, checksumUrl: null };
  }
  return { downloadUrl: null, checksumUrl: null };
}
function normalizeGitHubRelease(release, repo, runtimeKind = "napcat") {
  if (!isRecord(release)) return null;
  const tag = typeof release["tag_name"] === "string" ? release["tag_name"] : "";
  const version7 = normalizeReleaseVersion(tag);
  if (!version7) return null;
  const assets = Array.isArray(release["assets"]) ? release["assets"].filter(isRecord) : [];
  const { downloadUrl, checksumUrl } = selectReleaseAssetPair(assets, runtimeKind, version7, repo, tag);
  const rawPublishedAt = release["published_at"];
  const published = typeof rawPublishedAt === "string" && rawPublishedAt.length <= 128 ? Date.parse(rawPublishedAt) : Number.NaN;
  return {
    version: version7,
    tag,
    prerelease: release["prerelease"] === true,
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : "",
    downloadUrl,
    checksumUrl,
    releaseUrl: releasePageUrl(release["html_url"], repo, tag),
    releaseNotes: typeof release["body"] === "string" ? release["body"].slice(0, 1e5) : ""
  };
}
async function fetchGitHubJson(path) {
  const response = await fetchRemote(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json" }
  }, {
    allowedHosts: GITHUB_API_ORIGINS,
    timeoutMs: 1e4
  });
  if (!response.ok) {
    await releaseRemoteResponse(response);
    throw new Error(`GitHub API returned HTTP ${response.status}`);
  }
  return readResponseJson(response, MAX_RELEASE_METADATA_BYTES);
}
async function checkForUpdate() {
  const repo = configManager.get().update.githubRepo;
  const log = getLogger().child({ module: "update" });
  try {
    const release = await fetchGitHubJson(`/repos/${repo}/releases/latest`);
    const info = normalizeGitHubRelease(release, repo, getRuntimeHost().kind);
    if (!info?.version) {
      log.warn({ repo }, "Update check found no usable release");
      return null;
    }
    if (!isNewerVersion(info.version, currentVersion)) {
      log.info({ latest: info.version, current: currentVersion }, "Update check: already up to date");
      return null;
    }
    log.info({ latest: info.version, current: currentVersion, autoDownload: Boolean(info.downloadUrl) }, "Update available");
    return info;
  } catch (error) {
    log.warn(error, "Update check skipped");
    return null;
  }
}
async function fetchReleases() {
  const repo = configManager.get().update.githubRepo;
  const log = getLogger().child({ module: "update" });
  try {
    const releases = await fetchGitHubJson(`/repos/${repo}/releases?per_page=100`);
    if (!Array.isArray(releases)) return [];
    const runtimeKind = getRuntimeHost().kind;
    return releases.flatMap((release) => {
      const info = normalizeGitHubRelease(release, repo, runtimeKind);
      return info ? [info] : [];
    });
  } catch (error) {
    log.warn(error, "Fetch releases skipped");
    return [];
  }
}
async function sha256File(path) {
  const hash = createHash4("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function downloadUpdate(info) {
  const normalizedVersion = normalizeReleaseVersion(info.version);
  if (!normalizedVersion) throw new Error("Update version must be a valid semantic version");
  const downloadUrl = info.downloadUrl;
  const checksumUrl = info.checksumUrl;
  if (!downloadUrl || !checksumUrl) {
    throw new Error("This release has no SHA-256 archive pair; download it manually from the release page");
  }
  validateDownloadUrl(downloadUrl);
  validateDownloadUrl(checksumUrl);
  await withLock(locks.update(), async () => {
    const log = getLogger().child({ module: "update" });
    const backupDir = join4(getRuntimeHost().paths.dataPath, "backups");
    mkdirSync3(backupDir, { recursive: true });
    const safeVersion = normalizedVersion.replace(/\+/g, "_");
    const finalPath = join4(backupDir, `update-${safeVersion}.zip`);
    const unverifiedPath = `${finalPath}.unverified`;
    if (existsSync4(finalPath) || existsSync4(unverifiedPath)) {
      throw new Error("Update artifact already exists; remove it explicitly before downloading again");
    }
    log.info({ version: info.version }, "Downloading verified update");
    const archive = await fetchRemote(downloadUrl, {}, {
      allowedHosts: ALLOWED_DOWNLOAD_ORIGINS,
      timeoutMs: 12e4
    });
    if (!archive.ok) {
      await releaseRemoteResponse(archive);
      throw new Error(`Update download failed: HTTP ${archive.status}`);
    }
    const totalBytes = await writeResponseToFile(archive, unverifiedPath, MAX_UPDATE_BYTES);
    try {
      const checksum = await fetchRemote(checksumUrl, {}, {
        allowedHosts: ALLOWED_DOWNLOAD_ORIGINS,
        timeoutMs: 15e3
      });
      if (!checksum.ok) {
        await releaseRemoteResponse(checksum);
        throw new Error(`Checksum download failed: HTTP ${checksum.status}`);
      }
      const rawChecksum = (await readResponseBytes(checksum, MAX_CHECKSUM_BYTES)).toString("utf8").trim();
      const expected = rawChecksum.match(/^([a-fA-F0-9]{64})(?:\s|$)/)?.[1]?.toLowerCase();
      if (!expected) throw new Error("Release checksum file is malformed");
      if (await sha256File(unverifiedPath) !== expected) {
        throw new Error("Release checksum does not match the downloaded archive");
      }
      renameSync4(unverifiedPath, finalPath);
    } catch (error) {
      try {
        unlinkSync4(unverifiedPath);
      } catch {
      }
      throw error;
    }
    log.info({ version: info.version, path: finalPath, bytes: totalBytes }, "Verified update downloaded; extract it and restart Guardian to apply");
    bus.emit("AuditCreated", {
      action: "plugin.update_downloaded",
      actorId: null,
      targetType: "plugin",
      targetId: "qq-guardian",
      details: { fromVersion: currentVersion, toVersion: info.version, downloadPath: finalPath },
      timestamp: Date.now()
    });
  });
}
function isNewerVersion(latest, current) {
  const parse = (value) => {
    const parts = value.split(".").map((part) => Math.max(0, Number.parseInt(part, 10) || 0));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [latestMajor, latestMinor, latestPatch] = parse(latest);
  const [currentMajor, currentMinor, currentPatch] = parse(current);
  if (latestMajor !== currentMajor) return latestMajor > currentMajor;
  if (latestMinor !== currentMinor) return latestMinor > currentMinor;
  return latestPatch > currentPatch;
}

// src/api/index.ts
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      getLogger().error(error, "Unhandled API request error");
      if (error instanceof ConfigValidationError) {
        res.status(400).json({ code: -1, message: error.message });
        return;
      }
      res.status(500).json({ code: -1, message: "Internal server error" });
    }
  };
}
function extractBearer(req) {
  const raw = req.headers["authorization"] ?? req.headers["Authorization"];
  const hdr = Array.isArray(raw) ? raw[0] : raw;
  return hdr?.startsWith("Bearer ") ? hdr.slice(7) : void 0;
}
var authenticatedOperators = /* @__PURE__ */ new WeakMap();
function requireAuth(minRole, fn) {
  return wrap(async (req, res) => {
    const token = extractBearer(req);
    if (!token) {
      res.status(401).json({ code: -1, message: "Unauthorized" });
      return;
    }
    const authenticated = authenticateAccessToken(token);
    if (!authenticated) {
      res.status(401).json({ code: -1, message: "Invalid, expired, or revoked token" });
      return;
    }
    if (!hasRole(authenticated.role, minRole)) {
      res.status(403).json({ code: -1, message: "Forbidden" });
      return;
    }
    authenticatedOperators.set(req, authenticated.user.id);
    try {
      await fn(req, res);
    } finally {
      authenticatedOperators.delete(req);
    }
  });
}
var ok = (res, data = {}) => res.json({ code: 0, data });
var bad = (res, status, message) => res.status(status).json({ code: -1, message });
function respondToUserMutationError(res, error) {
  if (!(error instanceof UserAdminMutationError)) return false;
  const status = error.code === "user_not_found" ? 404 : error.code === "self_delete" ? 400 : 409;
  bad(res, status, error.message);
  return true;
}
function intParam(value, fallback, max) {
  const n = Number.parseInt(Array.isArray(value) ? value[0] ?? "" : value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}
function positiveRowId(value) {
  const normalized = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}
function pagination(req) {
  return {
    limit: intParam(req.query["limit"], 50, 200),
    offset: intParam(req.query["offset"], 0, Number.MAX_SAFE_INTEGER)
  };
}
function getClientIp(req) {
  const realIp = req.headers["x-real-ip"] ?? req.headers["X-Real-IP"];
  if (realIp) {
    const ip = (Array.isArray(realIp) ? realIp[0] : realIp)?.trim();
    if (ip) return ip;
  }
  const fwd = req.headers["x-forwarded-for"] ?? req.headers["X-Forwarded-For"];
  if (fwd) {
    const header = Array.isArray(fwd) ? fwd.join(",") : fwd;
    const ips = header.split(",").map((s) => s.trim()).filter(Boolean);
    const ip = ips[ips.length - 1];
    if (ip) return ip;
  }
  return "127.0.0.1";
}
function checkIpRateLimit(ip) {
  const cfg = configManager.get().auth;
  const now = Date.now();
  const global = loginRateLimitRepo.consume(
    "global",
    "*",
    cfg.rateLimitRequests * 5,
    cfg.rateLimitWindowMs,
    now
  );
  if (!global.allowed) return false;
  return loginRateLimitRepo.consume(
    "ip",
    ip,
    cfg.rateLimitRequests,
    cfg.rateLimitWindowMs,
    now
  ).allowed;
}
function operatorId(req) {
  const id = authenticatedOperators.get(req);
  if (id === void 0) throw new Error("Authenticated operator context is unavailable");
  return id;
}
var REDACTED2 = "[redacted]";
function redactSecrets(raw) {
  return {
    ...raw,
    webui: { ...raw.webui, jwtSecret: REDACTED2 },
    ai: { ...raw.ai, apiKey: raw.ai.apiKey ? REDACTED2 : "" }
  };
}
var APPROVAL_ACTIONS2 = /* @__PURE__ */ new Set(["auto_approve", "auto_reject", "manual", "captcha"]);
var USER_ROLES = /* @__PURE__ */ new Set(["super_admin", "group_admin", "auditor", "viewer", "member"]);
var RISK_ACTIONS2 = /* @__PURE__ */ new Set(["mute", "kick", "notify_admin", "log_only", "off"]);
var MAX_MUTE_SECONDS = 30 * 86400;
function buildProviderTelemetryPayload(provider) {
  const providerView = provider ?? {
    provider: "unknown",
    transport: "unknown",
    state: "unknown",
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
    events: { total: 0, dropped: 0 }
  };
  return {
    provider: providerView,
    providers: [providerView],
    metrics: {
      provider_transport_connections: providerView.state === "connected" ? 1 : 0,
      provider_transport_errors_total: providerView.errorsTotal,
      provider_last_heartbeat_time: providerView.lastHeartbeatAt
    },
    correlation_id: providerView.lastCorrelationId
  };
}
function providerTelemetryPayload() {
  let provider = null;
  try {
    provider = getProviderTelemetry();
  } catch {
  }
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
    correlation_id: telemetry.correlation_id
  };
}
function mergedGroupList(list) {
  const cfg = configManager.get();
  return list.map((g) => ({
    group_id: g.group_id,
    group_name: g.group_name,
    member_count: g.member_count,
    max_member_count: g.max_member_count,
    ...resolveGroupConfig(cfg, g.group_id)
  }));
}
function registerRoutes() {
  const ctx = getRuntimeHost();
  const r = ctx.router;
  r.postNoAuth("/auth/login", wrap(async (req, res) => {
    const b = req.body;
    const ip = getClientIp(req);
    if (!checkIpRateLimit(ip)) {
      res.status(429).json({ code: -1, message: "Too many login attempts. Please try again later." });
      return;
    }
    const result = await login(
      String(b["username"] ?? ""),
      String(b["password"] ?? ""),
      ip,
      (() => {
        const ua = req.headers["user-agent"] ?? req.headers["User-Agent"];
        return Array.isArray(ua) ? ua[0] : ua;
      })()
    );
    if (!result.ok) return bad(res, 401, result.error ?? "Login failed");
    ok(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
  }));
  r.postNoAuth("/auth/refresh", wrap(async (req, res) => {
    const b = req.body;
    const oldRefreshToken = String(b["refreshToken"] ?? "");
    const tokens = refreshTokens(oldRefreshToken);
    if (!tokens) return bad(res, 401, "Invalid, expired, or revoked refresh token");
    ok(res, tokens);
  }));
  r.postNoAuth("/auth/logout", wrap(async (req, res) => {
    const token = extractBearer(req);
    if (token) logout(token);
    const refreshToken = String(req.body["refreshToken"] ?? "");
    if (refreshToken) logout(refreshToken);
    ok(res);
  }));
  r.getNoAuth("/auth/me", requireAuth("viewer", (req, res) => {
    const user = userRepo.findById(operatorId(req));
    ok(res, { id: user?.id, username: user?.username, role: user?.role });
  }));
  r.getNoAuth("/stats", requireAuth("viewer", (_req, res) => ok(res, getOverviewStats())));
  r.getNoAuth("/metrics", requireAuth("viewer", (_req, res) => ok(res, metricsPayload())));
  r.getNoAuth("/health/verbose", requireAuth("viewer", (_req, res) => ok(res, verboseHealthPayload())));
  r.getNoAuth("/bot/info", requireAuth("viewer", async (_req, res) => {
    const cached = getCachedBotInfo();
    if (cached) {
      ok(res, cached);
      return;
    }
    const info = normalizeBotInfoResponse(await callOneBot("get_login_info", {}));
    if (!info) throw new Error("get_login_info returned an unexpected shape");
    ok(res, info);
  }));
  r.getNoAuth("/groups", requireAuth("viewer", async (_req, res) => {
    const list = getCachedGroupList() ?? normalizeGroupListResponse(await callOneBot("get_group_list", {}));
    if (!list) throw new Error("get_group_list returned an unexpected shape");
    ok(res, mergedGroupList(list));
  }));
  r.postNoAuth("/groups/refresh", requireAuth("group_admin", async (_req, res) => {
    await bootstrapGroups();
    ok(res, mergedGroupList(getCachedGroupList() ?? []));
  }));
  r.postNoAuth("/groups/:groupId", requireAuth("group_admin", async (req, res) => {
    const groupId = normalizeOneBotId(req.params["groupId"]);
    if (!groupId) return bad(res, 400, "groupId must be a positive integer");
    const gid = groupId;
    const b = req.body;
    const cfg = configManager.get();
    const existing = resolveGroupConfig(cfg, groupId);
    const bool = (key, fallback) => {
      const v = b[key];
      if (v === void 0 || v === null) return fallback;
      return parseBoolean(v) ?? fallback;
    };
    const strArr = (key, fallback, maxItemLength = 1024) => {
      const value = b[key];
      if (value === void 0) return fallback;
      if (!Array.isArray(value) || value.length > 100) return null;
      if (value.some((entry) => typeof entry !== "string" || entry.length > maxItemLength)) return null;
      return [...value];
    };
    if (b["action"] !== void 0 && !APPROVAL_ACTIONS2.has(String(b["action"]))) {
      return bad(res, 400, "action must be one of auto_approve|auto_reject|manual|captcha");
    }
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const key of ["curfewStart", "curfewEnd"]) {
      const v = b[key];
      if (v !== void 0 && (typeof v !== "string" || !HHMM.test(v))) {
        return bad(res, 400, `${key} must be a 24h "HH:MM" string`);
      }
    }
    if (b["welcomeTemplate"] !== void 0 && (typeof b["welcomeTemplate"] !== "string" || b["welcomeTemplate"].length > 500)) {
      return bad(res, 400, "welcomeTemplate must be a string of at most 500 characters");
    }
    const approveKeywords = strArr("approveKeywords", existing.approveKeywords);
    const rejectKeywords = strArr("rejectKeywords", existing.rejectKeywords);
    const approvePatterns = strArr("approvePatterns", existing.approvePatterns, 512);
    const rejectPatterns = strArr("rejectPatterns", existing.rejectPatterns, 512);
    if (!approveKeywords || !rejectKeywords || !approvePatterns || !rejectPatterns) {
      return bad(res, 400, "Keyword/pattern lists must contain at most 100 bounded strings");
    }
    try {
      for (const pattern of [...approvePatterns, ...rejectPatterns]) await validateRegexPattern(pattern);
    } catch (error) {
      return bad(res, 400, error instanceof Error ? error.message : "Invalid approval pattern");
    }
    {
      const effStart = typeof b["curfewStart"] === "string" ? b["curfewStart"] : existing.curfewStart;
      const effEnd = typeof b["curfewEnd"] === "string" ? b["curfewEnd"] : existing.curfewEnd;
      const changingWindow = effStart !== existing.curfewStart || effEnd !== existing.curfewEnd;
      if (changingWindow && effStart === effEnd) {
        return bad(res, 400, "curfew window cannot be zero-length (start must differ from end)");
      }
    }
    configManager.update({
      approval: {
        groups: {
          [gid]: {
            enabled: bool("enabled", existing.enabled),
            action: b["action"] !== void 0 ? b["action"] : existing.action,
            approveKeywords,
            rejectKeywords,
            approvePatterns,
            rejectPatterns,
            rejectReason: typeof b["rejectReason"] === "string" ? b["rejectReason"] : existing.rejectReason,
            riskEnabled: bool("riskEnabled", existing.riskEnabled),
            autoKickBlacklisted: bool("autoKickBlacklisted", existing.autoKickBlacklisted),
            notifyOnRisk: bool("notifyOnRisk", existing.notifyOnRisk),
            notifyOnJoin: bool("notifyOnJoin", existing.notifyOnJoin),
            groupName: existing.groupName,
            welcomeEnabled: bool("welcomeEnabled", existing.welcomeEnabled),
            welcomeTemplate: typeof b["welcomeTemplate"] === "string" ? b["welcomeTemplate"] : existing.welcomeTemplate,
            curfewEnabled: bool("curfewEnabled", existing.curfewEnabled),
            curfewStart: typeof b["curfewStart"] === "string" ? b["curfewStart"] : existing.curfewStart,
            curfewEnd: typeof b["curfewEnd"] === "string" ? b["curfewEnd"] : existing.curfewEnd
          }
        }
      }
    });
    ok(res);
  }));
  r.getNoAuth("/approvals", requireAuth("viewer", (req, res) => {
    const { limit, offset } = pagination(req);
    ok(res, approvalRepo.findAllPending(limit, offset));
  }));
  r.postNoAuth("/approvals/:id/approve", requireAuth("group_admin", async (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    await approvalService.approveManually(id, String(operatorId(req)));
    ok(res);
  }));
  r.postNoAuth("/approvals/:id/reject", requireAuth("group_admin", async (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    const b = req.body;
    await approvalService.rejectManually(
      id,
      String(operatorId(req)),
      String(b["reason"] ?? "\u5DF2\u88AB\u7BA1\u7406\u5458\u62D2\u7EDD")
    );
    ok(res);
  }));
  r.getNoAuth("/blacklist", requireAuth("viewer", (req, res) => {
    const { limit, offset } = pagination(req);
    ok(res, blacklistRepo.findAll(limit, offset));
  }));
  r.postNoAuth("/blacklist", requireAuth("group_admin", (req, res) => {
    const b = req.body;
    const userId = normalizeOneBotId(b["userId"]);
    const groupId = b["groupId"] === void 0 || b["groupId"] === null || b["groupId"] === "" ? null : normalizeOneBotId(b["groupId"]);
    const reason = b["reason"];
    if (!userId) return bad(res, 400, "userId must be a positive integer");
    if (groupId === null && b["groupId"] !== void 0 && b["groupId"] !== null && b["groupId"] !== "") {
      return bad(res, 400, "groupId must be a positive integer when provided");
    }
    if (reason !== void 0 && (typeof reason !== "string" || reason.length > 512)) {
      return bad(res, 400, "reason must be a string of at most 512 characters");
    }
    ok(res, blacklistRepo.add({
      userId,
      groupId,
      reason: typeof reason === "string" ? reason : "",
      // JWT identity, never a caller-supplied value — same accountability rule
      // as approvals and punishments.
      createdBy: String(operatorId(req))
    }));
  }));
  r.deleteNoAuth("/blacklist/:userId", requireAuth("group_admin", (req, res) => {
    const userId = normalizeOneBotId(req.params["userId"]);
    const queryGroupId = req.query["groupId"];
    const groupIdValue = Array.isArray(queryGroupId) ? queryGroupId[0] : queryGroupId;
    const gid = groupIdValue === void 0 ? null : normalizeOneBotId(groupIdValue);
    if (!userId || groupIdValue !== void 0 && !gid) return bad(res, 400, "userId and groupId must be positive integers");
    blacklistRepo.remove(userId, gid);
    ok(res);
  }));
  r.getNoAuth("/punishments", requireAuth("viewer", (req, res) => {
    const { limit, offset } = pagination(req);
    ok(res, punishmentRepo.findAll(limit, offset));
  }));
  r.postNoAuth("/punishments/mute", requireAuth("group_admin", async (req, res) => {
    const b = req.body;
    const groupId = normalizeOneBotId(b["groupId"]);
    const userId = normalizeOneBotId(b["userId"]);
    const reason = b["reason"];
    if (!groupId || !userId) return bad(res, 400, "groupId and userId must be positive integers");
    if (reason !== void 0 && (typeof reason !== "string" || reason.length > 512)) {
      return bad(res, 400, "reason must be a string of at most 512 characters");
    }
    const duration = b["durationSeconds"] === void 0 || b["durationSeconds"] === "" ? 600 : Number(b["durationSeconds"]);
    if (!Number.isInteger(duration) || duration < 1 || duration > MAX_MUTE_SECONDS) {
      return bad(res, 400, `durationSeconds must be an integer between 1 and ${MAX_MUTE_SECONDS}`);
    }
    ok(res, await punishmentService.mute(
      groupId,
      userId,
      duration,
      typeof reason === "string" ? reason : "",
      String(operatorId(req))
    ));
  }));
  r.postNoAuth("/punishments/kick", requireAuth("group_admin", async (req, res) => {
    const b = req.body;
    const groupId = normalizeOneBotId(b["groupId"]);
    const userId = normalizeOneBotId(b["userId"]);
    const reason = b["reason"];
    if (!groupId || !userId) return bad(res, 400, "groupId and userId must be positive integers");
    if (reason !== void 0 && (typeof reason !== "string" || reason.length > 512)) {
      return bad(res, 400, "reason must be a string of at most 512 characters");
    }
    ok(res, await punishmentService.kick(
      groupId,
      userId,
      typeof reason === "string" ? reason : "",
      String(operatorId(req))
    ));
  }));
  r.postNoAuth("/punishments/:id/revoke", requireAuth("group_admin", async (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    await punishmentService.revoke(id, String(operatorId(req)));
    ok(res);
  }));
  r.getNoAuth("/risk/rules", requireAuth(
    "viewer",
    (_req, res) => ok(res, getDatabase().prepare("SELECT * FROM risk_rules ORDER BY created_at DESC").all())
  ));
  r.postNoAuth("/risk/rules", requireAuth("super_admin", async (req, res) => {
    const b = req.body;
    const action = String(b["action"] ?? "mute");
    const name = b["name"];
    const pattern = b["pattern"];
    if (!RISK_ACTIONS2.has(action)) {
      return bad(res, 400, "action must be one of mute|kick|notify_admin|log_only|off");
    }
    if (typeof name !== "string" || name.length < 1 || name.length > 128) {
      return bad(res, 400, "name must be a string of 1-128 characters");
    }
    if (typeof pattern !== "string" || pattern.length < 1 || pattern.length > 512) {
      return bad(res, 400, "pattern must be a string of 1-512 characters");
    }
    try {
      ok(res, await riskService.addRule({
        name,
        pattern,
        action
      }));
    } catch (error) {
      return bad(res, 400, error instanceof Error ? error.message : "Invalid risk rule");
    }
  }));
  r.postNoAuth("/risk/rules/:id/toggle", requireAuth("super_admin", (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    const b = req.body;
    const enabled = parseBoolean(b["enabled"]);
    if (enabled === void 0) return bad(res, 400, "enabled must be a boolean");
    riskService.toggleRule(id, enabled);
    ok(res);
  }));
  r.deleteNoAuth("/risk/rules/:id", requireAuth("super_admin", (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    getDatabase().prepare("DELETE FROM risk_rules WHERE id = ?").run(id);
    riskService.reloadRules();
    ok(res);
  }));
  r.getNoAuth("/audit", requireAuth("auditor", (req, res) => {
    const { limit, offset } = pagination(req);
    ok(res, auditRepo.findAll({ limit, offset }));
  }));
  r.getNoAuth("/config", requireAuth("viewer", (_req, res) => {
    ok(res, redactSecrets(configManager.get()));
  }));
  r.postNoAuth("/config", requireAuth("super_admin", async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return bad(res, 400, "Configuration update body must be an object");
    }
    const body = req.body;
    const ALLOWED = /* @__PURE__ */ new Set(["core", "approval", "captcha", "risk", "punishment", "blacklist", "auth", "monitor", "update", "ai", "commands", "intel"]);
    const unknown = Object.keys(body).filter((k) => !ALLOWED.has(k));
    if (unknown.length > 0) {
      return bad(res, 400, `Unknown or non-updatable config section(s): ${unknown.join(", ")}`);
    }
    const update = { ...body };
    const ai = body["ai"];
    if (ai && typeof ai === "object" && !Array.isArray(ai)) {
      const safeAi = { ...ai };
      if (safeAi["apiKey"] === REDACTED2) delete safeAi["apiKey"];
      update["ai"] = safeAi;
    }
    await configManager.updateValidated(
      update,
      validatePersistedApprovalPatterns
    );
    ok(res);
  }));
  r.getNoAuth("/intel/status", requireAuth("viewer", (_req, res) => {
    ok(res, intelService.getStatus());
  }));
  r.postNoAuth("/intel/refresh", requireAuth("group_admin", async (_req, res) => {
    await intelService.refresh(true);
    ok(res, intelService.getStatus());
  }));
  r.postNoAuth("/approvals/sync", requireAuth("group_admin", async (_req, res) => {
    ok(res, { processed: await syncPendingJoinRequests() });
  }));
  r.getNoAuth("/update/check", requireAuth(
    "viewer",
    async (_req, res) => ok(res, { current: getCurrentVersion(), latest: await checkForUpdate() })
  ));
  r.getNoAuth("/update/releases", requireAuth("viewer", async (_req, res) => {
    const releases = await fetchReleases();
    ok(res, {
      current: getCurrentVersion(),
      githubRepo: configManager.get().update.githubRepo,
      releases
    });
  }));
  r.postNoAuth("/update/download", requireAuth("super_admin", async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return bad(res, 400, "Update download body must be an object");
    }
    const body = req.body;
    const version7 = body["version"];
    const downloadUrl = body["downloadUrl"];
    const checksumUrl = body["checksumUrl"];
    const normalizedVersion = normalizeReleaseVersion(version7);
    if (!normalizedVersion || typeof downloadUrl !== "string" || downloadUrl.length > 2048 || typeof checksumUrl !== "string" || checksumUrl.length > 2048) {
      return bad(res, 400, "version must be SemVer; downloadUrl and checksumUrl are required strings");
    }
    await downloadUpdate({
      version: normalizedVersion,
      downloadUrl,
      checksumUrl,
      publishedAt: "",
      releaseUrl: "",
      releaseNotes: ""
    });
    ok(res);
  }));
  function sanitizeUser(user) {
    const { password_hash: _, ...sanitized } = user;
    return { ...sanitized, is_usable_super_admin: isUsableSuperAdmin(user) };
  }
  r.getNoAuth("/users", requireAuth("super_admin", (_req, res) => {
    ok(res, userRepo.findAll().map((u) => sanitizeUser(u)));
  }));
  r.getNoAuth("/users/:id", requireAuth("super_admin", (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    const user = userRepo.findById(id);
    if (!user) {
      bad(res, 404, "User not found");
      return;
    }
    ok(res, sanitizeUser(user));
  }));
  r.postNoAuth("/users", requireAuth("super_admin", async (req, res) => {
    const b = req.body;
    const username = String(b["username"] ?? "").trim();
    const password = String(b["password"] ?? "");
    const role = String(b["role"] ?? "viewer");
    if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username) || !password) {
      bad(res, 400, "username and password are required");
      return;
    }
    if (!USER_ROLES.has(role)) {
      bad(res, 400, "invalid role");
      return;
    }
    const passwordError = validatePasswordForCreation(password);
    if (passwordError) {
      bad(res, 400, passwordError);
      return;
    }
    if (userRepo.findByUsername(username)) {
      bad(res, 409, "username already exists");
      return;
    }
    const qqId = b["qqId"];
    const normalizedQqId = qqId === void 0 ? void 0 : normalizeOneBotId(qqId);
    if (qqId !== void 0 && normalizedQqId === null) {
      bad(res, 400, "qqId must be an unsigned 64-bit decimal identifier");
      return;
    }
    const passwordHash = await hashPassword(password);
    const created = userRepo.createByAdministrator({
      username,
      passwordHash,
      role,
      qqId: normalizedQqId ?? void 0
    }, operatorId(req));
    ok(res, sanitizeUser(created));
  }));
  r.putNoAuth("/users/:id", requireAuth("super_admin", async (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    const b = req.body;
    const update = {};
    if (b["role"] !== void 0) {
      if (!USER_ROLES.has(String(b["role"]))) {
        bad(res, 400, "invalid role");
        return;
      }
      update.role = b["role"];
    }
    if (b["password"] !== void 0) {
      const password = String(b["password"]);
      const passwordError = validatePasswordForCreation(password);
      if (passwordError) {
        bad(res, 400, passwordError);
        return;
      }
      update.passwordHash = await hashPassword(password);
    }
    try {
      const user = Object.keys(update).length ? userRepo.updateByAdministrator(id, update, operatorId(req)) : userRepo.findById(id);
      if (!user) return bad(res, 404, "User not found");
      ok(res, sanitizeUser(user));
    } catch (error) {
      if (respondToUserMutationError(res, error)) return;
      throw error;
    }
  }));
  r.deleteNoAuth("/users/:id", requireAuth("super_admin", (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    try {
      userRepo.deleteByAdministrator(id, operatorId(req));
      ok(res);
    } catch (error) {
      if (respondToUserMutationError(res, error)) return;
      throw error;
    }
  }));
  r.postNoAuth("/users/:id/unlock", requireAuth("super_admin", (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    try {
      userRepo.updateByAdministrator(
        id,
        { loginAttempts: 0, lockedUntil: null },
        operatorId(req)
      );
      ok(res);
    } catch (error) {
      if (respondToUserMutationError(res, error)) return;
      throw error;
    }
  }));
  r.postNoAuth("/users/:id/password", requireAuth("super_admin", async (req, res) => {
    const id = positiveRowId(req.params["id"]);
    if (!id) return bad(res, 400, "id must be a positive integer");
    const password = String(req.body["password"] ?? "");
    if (!password) {
      bad(res, 400, "password is required");
      return;
    }
    const passwordError = validatePasswordForCreation(password);
    if (passwordError) {
      bad(res, 400, passwordError);
      return;
    }
    try {
      userRepo.updateByAdministrator(
        id,
        { passwordHash: await hashPassword(password) },
        operatorId(req)
      );
      ok(res);
    } catch (error) {
      if (respondToUserMutationError(res, error)) return;
      throw error;
    }
  }));
}

// src/migration/shadow.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync5, renameSync as renameSync6, unlinkSync as unlinkSync6 } from "fs";
import { randomUUID as randomUUID5 } from "crypto";
import { dirname as dirname2, join as join6, resolve as resolve2 } from "path";

// src/database/validation.ts
var OPERATIONAL_TABLES = [
  "users",
  "approval_records",
  "captcha_sessions",
  "blacklist",
  "punishment_records",
  "audit_logs",
  "login_logs",
  "stat_snapshots",
  "risk_rules",
  "auth_sessions",
  "login_rate_limits"
];
var REQUIRED_TABLES = [...OPERATIONAL_TABLES, "schema_migrations"];
var RISK_ACTIONS3 = /* @__PURE__ */ new Set(["mute", "kick", "notify_admin", "log_only", "off"]);
var ONEBOT_ID_COLUMNS = {
  users: ["qq_id"],
  approval_records: ["group_id", "user_id", "operator_id"],
  captcha_sessions: ["group_id", "user_id"],
  blacklist: ["user_id", "group_id", "created_by"],
  punishment_records: ["group_id", "user_id", "operator_id", "revoked_by"],
  audit_logs: ["actor_id"],
  stat_snapshots: ["group_id"]
};
var DatabaseValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseValidationError";
  }
};
function tableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  );
}
function tableColumns(db, table) {
  return new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
  );
}
function tableColumnTypes(db, table) {
  return new Map(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, row.type.toUpperCase()])
  );
}
function detectRetiredDatabaseFields(db) {
  const tables = tableNames(db);
  const retired = [];
  if (tables.has("users")) {
    const columns = tableColumns(db, "users");
    for (const column of ["totp_secret", "totp_enabled"]) {
      if (columns.has(column)) retired.push(`users.${column}`);
    }
  }
  if (tables.has("risk_rules")) {
    const columns = tableColumns(db, "risk_rules");
    for (const column of ["type", "weight"]) {
      if (columns.has(column)) retired.push(`risk_rules.${column}`);
    }
  }
  return retired;
}
function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}
function requireColumns(db, table, columns) {
  const actual = tableColumns(db, table);
  for (const column of columns) {
    if (!actual.has(column)) {
      throw new DatabaseValidationError(`${table} is missing required column ${column}`);
    }
  }
}
function validateIdentifierColumns(db) {
  for (const [table, columns] of Object.entries(ONEBOT_ID_COLUMNS)) {
    const types = tableColumnTypes(db, table);
    for (const column of columns) {
      if (types.get(column) !== "TEXT") {
        throw new DatabaseValidationError(`${table}.${column} must use TEXT affinity`);
      }
      const invalid = db.prepare(`
        SELECT rowid FROM ${table}
        WHERE ${column} IS NOT NULL AND (
          typeof(${column}) <> 'text'
          OR ${column} = ''
          OR ${column} = '0'
          OR ${column} GLOB '*[^0-9]*'
          OR (length(${column}) > 1 AND substr(${column}, 1, 1) = '0')
          OR length(${column}) > 20
          OR (length(${column}) = 20 AND ${column} > '18446744073709551615')
        )
        LIMIT 1
      `).get();
      if (invalid) {
        throw new DatabaseValidationError(`${table}.${column} contains a non-canonical identifier at row ${invalid.rowid}`);
      }
    }
  }
}
function getDatabaseSchemaVersion(db) {
  if (!tableNames(db).has("schema_migrations")) return 0;
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  return row.version ?? 0;
}
function captureOperationalRowCounts(db) {
  const present = tableNames(db);
  return Object.fromEntries(
    OPERATIONAL_TABLES.filter((table) => present.has(table)).map((table) => [table, countRows(db, table)])
  );
}
function assertRowCountsPreserved(source, candidate) {
  for (const [table, count] of Object.entries(source)) {
    if (candidate[table] !== count) {
      throw new DatabaseValidationError(
        `${table} row count changed during migration (${count} -> ${candidate[table] ?? "missing"})`
      );
    }
  }
}
async function validateDatabase(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new DatabaseValidationError(`integrity_check failed: ${JSON.stringify(integrity)}`);
  }
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new DatabaseValidationError(`foreign_key_check failed: ${JSON.stringify(foreignKeyViolations)}`);
  }
  const tables = tableNames(db);
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) throw new DatabaseValidationError(`missing required table ${table}`);
  }
  const schemaVersion = getDatabaseSchemaVersion(db);
  if (schemaVersion !== DATABASE_SCHEMA_VERSION) {
    throw new DatabaseValidationError(
      `schema version ${schemaVersion} does not match ${DATABASE_SCHEMA_VERSION}`
    );
  }
  requireColumns(db, "users", [
    "id",
    "qq_id",
    "username",
    "password_hash",
    "role",
    "login_attempts",
    "locked_until",
    "last_login",
    "created_at",
    "updated_at"
  ]);
  const userColumns = tableColumns(db, "users");
  for (const retired of ["totp_secret", "totp_enabled"]) {
    if (userColumns.has(retired)) throw new DatabaseValidationError(`users still has retired column ${retired}`);
  }
  requireColumns(db, "risk_rules", [
    "id",
    "name",
    "pattern",
    "action",
    "enabled",
    "created_at",
    "updated_at"
  ]);
  const riskColumns = tableColumns(db, "risk_rules");
  for (const retired of ["type", "weight"]) {
    if (riskColumns.has(retired)) throw new DatabaseValidationError(`risk_rules still has retired column ${retired}`);
  }
  requireColumns(db, "auth_sessions", [
    "token_id",
    "user_id",
    "kind",
    "issued_at",
    "expires_at",
    "revoked_at"
  ]);
  requireColumns(db, "login_rate_limits", [
    "scope",
    "bucket_key",
    "attempts",
    "reset_at",
    "updated_at"
  ]);
  validateIdentifierColumns(db);
  const rules = db.prepare("SELECT id, pattern, action, enabled FROM risk_rules").all();
  for (const rule of rules) {
    if (typeof rule.pattern !== "string" || typeof rule.action !== "string") {
      throw new DatabaseValidationError(`risk_rules row ${rule.id} has invalid pattern/action`);
    }
    assertSafeRegularExpression(rule.pattern, `risk_rules[${rule.id}].pattern`);
    if (!RISK_ACTIONS3.has(rule.action)) {
      throw new DatabaseValidationError(`risk_rules row ${rule.id} has unsupported action ${rule.action}`);
    }
    if (rule.enabled !== 0 && rule.enabled !== 1) {
      throw new DatabaseValidationError(`risk_rules row ${rule.id} has invalid enabled state`);
    }
  }
  const verdicts = await probePatternsInWorkers(rules.map((rule) => rule.pattern));
  for (const rule of rules) {
    if (!verdicts.get(rule.pattern)) {
      throw new DatabaseValidationError(`risk_rules row ${rule.id} failed performance test (possible ReDoS)`);
    }
  }
  return { schemaVersion, rowCounts: captureOperationalRowCounts(db) };
}

// src/migration/files.ts
import {
  chmodSync as chmodSync3,
  closeSync as closeSync3,
  copyFileSync as copyFileSync2,
  existsSync as existsSync5,
  fsyncSync,
  mkdirSync as mkdirSync4,
  openSync as openSync3,
  readFileSync as readFileSync3,
  readSync,
  renameSync as renameSync5,
  rmSync,
  statSync,
  unlinkSync as unlinkSync5,
  writeFileSync as writeFileSync3
} from "fs";
import { createHash as createHash5, randomUUID as randomUUID4 } from "crypto";
import { dirname, join as join5, relative, resolve } from "path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/migration/types.ts
var SHADOW_MIGRATION_FORMAT = "shadow-migration-v1";
var ShadowMigrationError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ShadowMigrationError";
  }
};

// src/migration/files.ts
var HASH_BUFFER_SIZE = 1024 * 1024;
function syncBestEffort(fd) {
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = error.code;
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP") throw error;
  }
}
function assertPathInside(root, path, label) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const relation = relative(resolvedRoot, resolvedPath);
  if (relation === ".." || relation.startsWith("..\\") || relation.startsWith("../") || relation === "") {
    if (relation === "") return resolvedPath;
    throw new ShadowMigrationError(`${label} must remain within ${resolvedRoot}`);
  }
  if (relation.startsWith("..") || resolve(resolvedRoot, relation) !== resolvedPath) {
    throw new ShadowMigrationError(`${label} must remain within ${resolvedRoot}`);
  }
  return resolvedPath;
}
function ensureRegularFile(path, label) {
  if (!existsSync5(path) || !statSync(path).isFile()) {
    throw new ShadowMigrationError(`${label} does not exist as a regular file: ${path}`);
  }
}
function sha256File2(path) {
  const fd = openSync3(path, "r");
  const hash = createHash5("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE);
  try {
    let offset = 0;
    for (; ; ) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
  } finally {
    closeSync3(fd);
  }
  return hash.digest("hex");
}
function describeArtifact(path) {
  ensureRegularFile(path, "artifact");
  return { path: resolve(path), sha256: sha256File2(path), bytes: statSync(path).size };
}
function verifyArtifact(artifact, label) {
  ensureRegularFile(artifact.path, label);
  const bytes = statSync(artifact.path).size;
  const hash = sha256File2(artifact.path);
  if (bytes !== artifact.bytes || hash !== artifact.sha256) {
    throw new ShadowMigrationError(`${label} no longer matches its verified checksum`);
  }
}
function artifactMatches(path, expected) {
  try {
    const actual = describeArtifact(path);
    return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
  } catch {
    return false;
  }
}
function writeFileAtomically(path, content) {
  mkdirSync4(dirname(path), { recursive: true, mode: 448 });
  const temporary = join5(dirname(path), `.${randomUUID4()}.${process.pid}.tmp`);
  let fd;
  try {
    writeFileSync3(temporary, content, { mode: 384 });
    fd = openSync3(temporary, "r+");
    syncBestEffort(fd);
    closeSync3(fd);
    fd = void 0;
    renameSync5(temporary, path);
  } catch (error) {
    if (fd !== void 0) closeSync3(fd);
    try {
      if (existsSync5(temporary)) unlinkSync5(temporary);
    } catch {
    }
    throw error;
  }
}
function writeJsonAtomically(path, value) {
  writeFileAtomically(path, `${JSON.stringify(value, null, 2)}
`);
}
function readJson(path) {
  return JSON.parse(readFileSync3(path, "utf8"));
}
function copyArtifact(source, destination, label) {
  ensureRegularFile(source, label);
  mkdirSync4(dirname(destination), { recursive: true, mode: 448 });
  copyFileSync2(source, destination);
  try {
    chmodSync3(destination, 384);
  } catch {
  }
  const copied = describeArtifact(destination);
  const original = describeArtifact(source);
  if (copied.bytes !== original.bytes || copied.sha256 !== original.sha256) {
    throw new ShadowMigrationError(`${label} copy did not match the source checksum`);
  }
  return copied;
}
function snapshotDatabase(source, destination) {
  ensureRegularFile(source, "database source");
  mkdirSync4(dirname(destination), { recursive: true, mode: 448 });
  if (existsSync5(destination)) unlinkSync5(destination);
  const db = new DatabaseSync2(source, { readOnly: true, timeout: 5e3 });
  try {
    const escapedDestination = resolve(destination).replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escapedDestination}'`);
  } finally {
    db.close();
  }
  try {
    chmodSync3(destination, 384);
  } catch {
  }
  return describeArtifact(destination);
}
function replaceFromArtifact(source, target, label) {
  ensureRegularFile(source, label);
  const temporary = join5(dirname(target), `.${randomUUID4()}.${process.pid}.next`);
  mkdirSync4(dirname(target), { recursive: true, mode: 448 });
  try {
    copyFileSync2(source, temporary);
    const fd = openSync3(temporary, "r+");
    try {
      syncBestEffort(fd);
    } finally {
      closeSync3(fd);
    }
    renameSync5(temporary, target);
    try {
      chmodSync3(target, 384);
    } catch {
    }
  } catch (error) {
    try {
      if (existsSync5(temporary)) unlinkSync5(temporary);
    } catch {
    }
    throw new ShadowMigrationError(`Could not replace ${label}: ${String(error)}`, { cause: error });
  }
  return describeArtifact(target);
}
function removeSqliteSidecars(databasePath) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync5(sidecar)) unlinkSync5(sidecar);
  }
}
function removeStagingDirectory(dataDir, stagingDir) {
  const migrationRoot = assertPathInside(dataDir, join5(dataDir, "migration"), "migration root");
  const resolvedStaging = assertPathInside(migrationRoot, stagingDir, "staging directory");
  if (existsSync5(resolvedStaging)) rmSync(resolvedStaging, { recursive: true, force: false });
}
function writeJournal(path, journal) {
  journal.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  writeJsonAtomically(path, journal);
}
function acquireMigrationLock(dataDir) {
  mkdirSync4(dataDir, { recursive: true });
  const lockPath = join5(dataDir, "migration.lock");
  const createLock = () => openSync3(lockPath, "wx");
  let fd;
  try {
    fd = createLock();
  } catch (error) {
    const code = error.code;
    if (code !== "EEXIST") throw error;
    let holder = {};
    try {
      holder = JSON.parse(readFileSync3(lockPath, "utf8"));
    } catch {
    }
    const pid = typeof holder.pid === "number" && Number.isSafeInteger(holder.pid) && holder.pid > 0 ? holder.pid : void 0;
    if (pid !== void 0) {
      try {
        process.kill(pid, 0);
        throw new ShadowMigrationError(`A Guardian migration is already running (pid ${pid})`);
      } catch (probeError) {
        if (probeError instanceof ShadowMigrationError) throw probeError;
        if (probeError.code === "EPERM") {
          throw new ShadowMigrationError(`A Guardian migration lock is held by inaccessible pid ${pid}`);
        }
        if (probeError.code !== "ESRCH") throw probeError;
      }
    }
    if (pid === void 0 && Date.now() - statSync(lockPath).mtimeMs < 3e4) {
      throw new ShadowMigrationError("A Guardian migration lock is being initialized; retry shortly");
    }
    const stalePath = join5(dataDir, `migration.lock.stale-${Date.now()}-${randomUUID4()}`);
    renameSync5(lockPath, stalePath);
    fd = createLock();
  }
  try {
    writeFileSync3(fd, JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }));
    syncBestEffort(fd);
  } finally {
    closeSync3(fd);
  }
  return () => {
    try {
      if (existsSync5(lockPath)) unlinkSync5(lockPath);
    } catch {
    }
  };
}

// src/migration/shadow.ts
var JOURNAL_FILENAME = "migration-state.json";
var CREDENTIALS_FILENAME = "credentials.txt";
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function asRecord2(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShadowMigrationError(`${label} is malformed`);
  }
  return value;
}
function resolveLayout(paths) {
  const configDir = resolve2(paths.configDir);
  const dataDir = resolve2(paths.dataDir);
  const configPath = assertPathInside(configDir, join6(configDir, CONFIG_FILENAME), "config path");
  const databasePath = assertPathInside(dataDir, getDatabasePath(dataDir), "database path");
  return {
    configDir,
    dataDir,
    configPath,
    databasePath,
    credentialsPath: assertPathInside(dataDir, join6(dataDir, CREDENTIALS_FILENAME), "credentials path"),
    journalPath: assertPathInside(dataDir, join6(dataDir, JOURNAL_FILENAME), "migration journal path")
  };
}
function migrationId() {
  return randomUUID5();
}
function migrationDirectoryName(id) {
  return `migration-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${id}`;
}
function ensureFileOrAbsent(path, label) {
  if (!existsSync6(path)) return false;
  ensureRegularFile(path, label);
  return true;
}
function parseJournal(value, layout) {
  const record2 = asRecord2(value, "migration journal");
  if (record2.format !== SHADOW_MIGRATION_FORMAT || typeof record2.id !== "string") {
    throw new ShadowMigrationError("migration journal has an unsupported format");
  }
  const journal = record2;
  const pathRecord = asRecord2(journal.paths, "migration journal paths");
  if (resolve2(String(pathRecord.configPath)) !== layout.configPath || resolve2(String(pathRecord.databasePath)) !== layout.databasePath || resolve2(String(pathRecord.credentialsPath)) !== layout.credentialsPath) {
    throw new ShadowMigrationError("migration journal does not match the configured persistent paths");
  }
  const backupsRoot = assertPathInside(layout.dataDir, join6(layout.dataDir, "backups"), "backups root");
  const stagingRoot = assertPathInside(layout.dataDir, join6(layout.dataDir, "migration"), "staging root");
  const backupDir = assertPathInside(backupsRoot, String(pathRecord.backupDir), "journal backup directory");
  const stagingDir = assertPathInside(stagingRoot, String(pathRecord.stagingDir), "journal staging directory");
  if (backupDir !== resolve2(String(pathRecord.backupDir)) || stagingDir !== resolve2(String(pathRecord.stagingDir))) {
    throw new ShadowMigrationError("migration journal has non-canonical artifact paths");
  }
  if (!Object.values([
    "prepared",
    "backup_verified",
    "staged",
    "staged_validated",
    "activating",
    "active_validated",
    "completed",
    "recovery_required"
  ]).includes(journal.phase)) {
    throw new ShadowMigrationError("migration journal has an invalid phase");
  }
  return journal;
}
function loadJournal(layout) {
  if (!existsSync6(layout.journalPath)) return null;
  return parseJournal(readJson(layout.journalPath), layout);
}
function artifactMetadataMatches(value, expected, label) {
  const record2 = asRecord2(value, label);
  return typeof record2.path === "string" && resolve2(record2.path) === resolve2(expected.path) && record2.sha256 === expected.sha256 && record2.bytes === expected.bytes;
}
function optionalArtifactMetadataMatches(value, expected, label) {
  if (expected === null) return value === null;
  return artifactMetadataMatches(value, expected, label);
}
function completedJournalProvesPreviousConfigGeneration(journal, layout, activeConfigSchemaVersion, canonicalDatabase) {
  if (journal.phase !== "completed" || activeConfigSchemaVersion !== CONFIG_SCHEMA_VERSION - 1 || !canonicalDatabase) {
    return false;
  }
  assertRecoverableJournal(journal, layout);
  const manifestPath = assertPathInside(
    journal.paths.backupDir,
    join6(journal.paths.backupDir, "manifest.json"),
    "completed migration manifest"
  );
  ensureRegularFile(manifestPath, "completed migration manifest");
  const manifest = asRecord2(readJson(manifestPath), "completed migration manifest");
  const target = asRecord2(manifest.target, "completed migration manifest target");
  const validation = asRecord2(manifest.validation, "completed migration validation");
  const source = asRecord2(manifest.source, "completed migration source");
  if (manifest.format !== SHADOW_MIGRATION_FORMAT || manifest.migrationId !== journal.id || manifest.createdAt !== journal.createdAt || target.configSchemaVersion !== activeConfigSchemaVersion || target.databaseSchemaVersion !== DATABASE_SCHEMA_VERSION || validation.configSchemaVersion !== activeConfigSchemaVersion || validation.databaseSchemaVersion !== DATABASE_SCHEMA_VERSION || !artifactMetadataMatches(source.config, journal.source.config, "completed migration source config") || !optionalArtifactMetadataMatches(
    source.database,
    journal.source.database,
    "completed migration source database"
  ) || !optionalArtifactMetadataMatches(
    source.credentials,
    journal.source.credentials,
    "completed migration source credentials"
  )) {
    return false;
  }
  return true;
}
function archiveJournal(layout, journal, reason) {
  const archivePath = assertPathInside(
    layout.dataDir,
    join6(layout.dataDir, `migration-state.${journal.id}.${reason}.json`),
    "archived migration journal path"
  );
  if (existsSync6(archivePath)) {
    throw new ShadowMigrationError(`refusing to overwrite an existing journal archive: ${archivePath}`);
  }
  renameSync6(layout.journalPath, archivePath);
}
function assertArtifactPath(artifact, expectedPath, label) {
  if (resolve2(artifact.path) !== resolve2(expectedPath)) {
    throw new ShadowMigrationError(`${label} path does not match the migration layout`);
  }
}
function assertRecoverableJournal(journal, layout) {
  if (!journal.source) throw new ShadowMigrationError("migration journal has no verified source backup");
  const backupDir = journal.paths.backupDir;
  assertArtifactPath(journal.source.config, join6(backupDir, CONFIG_FILENAME), "source config");
  if (journal.source.database) assertArtifactPath(journal.source.database, join6(backupDir, "qqadmin.db"), "source database");
  if (journal.source.credentials) assertArtifactPath(journal.source.credentials, join6(backupDir, CREDENTIALS_FILENAME), "source credentials");
  verifyArtifact(journal.source.config, "source config backup");
  if (journal.source.database) verifyArtifact(journal.source.database, "source database backup");
  if (journal.source.credentials) verifyArtifact(journal.source.credentials, "source credentials backup");
  assertPathInside(layout.dataDir, backupDir, "journal backup directory");
}
function assertCandidateJournal(journal) {
  if (!journal.candidate) throw new ShadowMigrationError("migration journal has no staged candidate");
  assertArtifactPath(journal.candidate.config, join6(journal.paths.stagingDir, "config.next.json"), "candidate config");
  assertArtifactPath(journal.candidate.database, join6(journal.paths.stagingDir, "qqadmin.next.db"), "candidate database");
  verifyArtifact(journal.candidate.config, "candidate config");
  verifyArtifact(journal.candidate.database, "candidate database");
}
function activeMatchesCandidate(journal, layout) {
  if (!journal.candidate) return false;
  return artifactMatches(layout.configPath, journal.candidate.config) && artifactMatches(layout.databasePath, journal.candidate.database);
}
async function validateActiveCandidate(journal, layout) {
  assertCandidateJournal(journal);
  const config = validateCanonicalConfigFile(readJson(layout.configPath));
  await validatePersistedApprovalPatterns(config.config);
  const db = openDatabaseFile(layout.databasePath, true);
  try {
    await validateDatabase(db);
  } finally {
    db.close();
  }
  if (!activeMatchesCandidate(journal, layout)) {
    throw new ShadowMigrationError("active files changed while migration validation was running");
  }
}
function restoreFromBackup(journal, layout) {
  assertRecoverableJournal(journal, layout);
  if (!journal.source.database && existsSync6(layout.databasePath) && (!journal.candidate || !artifactMatches(layout.databasePath, journal.candidate.database))) {
    throw new ShadowMigrationError(
      "cannot remove a database that was absent before migration because it no longer matches the staged candidate"
    );
  }
  replaceFromArtifact(journal.source.config.path, layout.configPath, "source configuration backup");
  if (journal.source.database) {
    removeSqliteSidecars(layout.databasePath);
    replaceFromArtifact(journal.source.database.path, layout.databasePath, "source database backup");
    if (!artifactMatches(layout.databasePath, journal.source.database)) {
      throw new ShadowMigrationError("restored database does not match its verified backup");
    }
    return;
  }
  if (!existsSync6(layout.databasePath)) return;
  removeSqliteSidecars(layout.databasePath);
  unlinkSync6(layout.databasePath);
}
function cleanupCompletedStaging(layout, journal) {
  try {
    removeStagingDirectory(layout.dataDir, journal.paths.stagingDir);
  } catch {
  }
}
async function recoverIncompleteJournal(layout) {
  const journal = loadJournal(layout);
  if (!journal || journal.phase === "completed") return "none";
  if (journal.phase === "prepared" || journal.phase === "backup_verified" || journal.phase === "staged" || journal.phase === "staged_validated") {
    archiveJournal(layout, journal, "abandoned-before-activation");
    return "discarded";
  }
  assertRecoverableJournal(journal, layout);
  if (activeMatchesCandidate(journal, layout)) {
    await validateActiveCandidate(journal, layout);
    journal.phase = "active_validated";
    delete journal.error;
    writeJournal(layout.journalPath, journal);
    journal.phase = "completed";
    writeJournal(layout.journalPath, journal);
    cleanupCompletedStaging(layout, journal);
    return "completed";
  }
  journal.phase = "recovery_required";
  writeJournal(layout.journalPath, journal);
  restoreFromBackup(journal, layout);
  archiveJournal(layout, journal, "recovered-source");
  return "restored";
}
async function configIsCanonical(layout) {
  const raw = readJson(layout.configPath);
  const record2 = asRecord2(raw, "config file");
  const version7 = record2.schemaVersion;
  if (version7 === CONFIG_SCHEMA_VERSION) {
    const config = validateCanonicalConfigFile(raw);
    await validatePersistedApprovalPatterns(config.config);
    return true;
  }
  if (typeof version7 === "number" && version7 > CONFIG_SCHEMA_VERSION) {
    throw new ShadowMigrationError(`config schema ${version7} is newer than this Guardian runtime`);
  }
  return false;
}
async function databaseIsCanonical(layout) {
  const db = openDatabaseFile(layout.databasePath, true);
  try {
    const version7 = getDatabaseSchemaVersion(db);
    if (version7 > DATABASE_SCHEMA_VERSION) {
      throw new ShadowMigrationError(`database schema ${version7} is newer than this Guardian runtime`);
    }
    if (version7 !== DATABASE_SCHEMA_VERSION) return false;
    await validateDatabase(db);
    return true;
  } finally {
    db.close();
  }
}
function createJournal(layout) {
  const id = migrationId();
  const backupDir = assertPathInside(
    layout.dataDir,
    join6(layout.dataDir, "backups", migrationDirectoryName(id)),
    "migration backup directory"
  );
  const stagingDir = assertPathInside(
    layout.dataDir,
    join6(layout.dataDir, "migration", id),
    "migration staging directory"
  );
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    format: SHADOW_MIGRATION_FORMAT,
    id,
    createdAt: now,
    updatedAt: now,
    phase: "prepared",
    paths: {
      configPath: layout.configPath,
      databasePath: layout.databasePath,
      credentialsPath: layout.credentialsPath,
      backupDir,
      stagingDir
    },
    source: null,
    candidate: null
  };
}
function createBackups(journal, layout) {
  mkdirSync5(journal.paths.backupDir, { recursive: true, mode: 448 });
  const config = copyArtifact(layout.configPath, join6(journal.paths.backupDir, CONFIG_FILENAME), "configuration");
  const database = existsSync6(layout.databasePath) ? snapshotDatabase(layout.databasePath, join6(journal.paths.backupDir, "qqadmin.db")) : null;
  const credentials = existsSync6(layout.credentialsPath) ? copyArtifact(layout.credentialsPath, join6(journal.paths.backupDir, CREDENTIALS_FILENAME), "credentials") : null;
  return { config, database, credentials };
}
function readSourceDatabaseMetadata(source) {
  if (!source) return { rowCounts: {}, retiredFields: [] };
  const db = openDatabaseFile(source.path, true);
  try {
    return {
      rowCounts: captureOperationalRowCounts(db),
      retiredFields: detectRetiredDatabaseFields(db)
    };
  } finally {
    db.close();
  }
}
async function createCandidateDatabase(candidatePath, source, sourceRowCounts) {
  mkdirSync5(dirname2(candidatePath), { recursive: true, mode: 448 });
  if (source) {
    copyArtifact(source.path, candidatePath, "database staging source");
  }
  let rowCounts;
  const db = openDatabaseFile(candidatePath);
  try {
    runMigrations(db);
    const report = await validateDatabase(db);
    assertRowCountsPreserved(sourceRowCounts, report.rowCounts);
    db.exec("PRAGMA journal_mode = DELETE");
    rowCounts = report.rowCounts;
  } finally {
    db.close();
    removeSqliteSidecars(candidatePath);
  }
  return { artifact: describeArtifact(candidatePath), rowCounts };
}
function writeManifest(path, manifest) {
  writeJsonAtomically(path, manifest);
}
async function performMigration(layout) {
  const journal = createJournal(layout);
  mkdirSync5(layout.dataDir, { recursive: true, mode: 448 });
  writeJournal(layout.journalPath, journal);
  try {
    journal.source = createBackups(journal, layout);
    verifyArtifact(journal.source.config, "configuration backup");
    if (journal.source.database) verifyArtifact(journal.source.database, "database backup");
    if (journal.source.credentials) verifyArtifact(journal.source.credentials, "credentials backup");
    journal.phase = "backup_verified";
    writeJournal(layout.journalPath, journal);
    const sourceMetadata = readSourceDatabaseMetadata(journal.source.database);
    const manifest = {
      format: SHADOW_MIGRATION_FORMAT,
      migrationId: journal.id,
      createdAt: journal.createdAt,
      source: journal.source,
      target: {
        configSchemaVersion: CONFIG_SCHEMA_VERSION,
        databaseSchemaVersion: DATABASE_SCHEMA_VERSION
      }
    };
    writeManifest(join6(journal.paths.backupDir, "manifest.json"), manifest);
    mkdirSync5(journal.paths.stagingDir, { recursive: true, mode: 448 });
    const migratedConfig = migrateLegacyConfig(readJson(journal.source.config.path));
    const candidateConfigPath = join6(journal.paths.stagingDir, "config.next.json");
    writeJsonAtomically(candidateConfigPath, migratedConfig.file);
    const candidateConfigFile = validateCanonicalConfigFile(readJson(candidateConfigPath));
    await validatePersistedApprovalPatterns(candidateConfigFile.config);
    const candidateConfig = describeArtifact(candidateConfigPath);
    const candidateDatabase = await createCandidateDatabase(
      join6(journal.paths.stagingDir, "qqadmin.next.db"),
      journal.source.database,
      sourceMetadata.rowCounts
    );
    journal.candidate = { config: candidateConfig, database: candidateDatabase.artifact };
    journal.phase = "staged";
    writeJournal(layout.journalPath, journal);
    const validation = {
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      sourceRowCounts: sourceMetadata.rowCounts,
      candidateRowCounts: candidateDatabase.rowCounts,
      preservedConfigFields: migratedConfig.preservedFields,
      retiredConfigFields: migratedConfig.retiredFields,
      retiredDatabaseFields: sourceMetadata.retiredFields
    };
    writeJsonAtomically(join6(journal.paths.stagingDir, "validation.json"), validation);
    manifest.validation = validation;
    writeManifest(join6(journal.paths.backupDir, "manifest.json"), manifest);
    journal.phase = "staged_validated";
    writeJournal(layout.journalPath, journal);
    assertCandidateJournal(journal);
    journal.phase = "activating";
    writeJournal(layout.journalPath, journal);
    replaceFromArtifact(journal.candidate.config.path, layout.configPath, "staged configuration");
    if (!artifactMatches(layout.configPath, journal.candidate.config)) {
      throw new ShadowMigrationError("active configuration did not match the staged candidate");
    }
    removeSqliteSidecars(layout.databasePath);
    replaceFromArtifact(journal.candidate.database.path, layout.databasePath, "staged database");
    if (!artifactMatches(layout.databasePath, journal.candidate.database)) {
      throw new ShadowMigrationError("active database did not match the staged candidate");
    }
    journal.phase = "active_validated";
    writeJournal(layout.journalPath, journal);
    await validateActiveCandidate(journal, layout);
    journal.phase = "completed";
    delete journal.error;
    writeJournal(layout.journalPath, journal);
    cleanupCompletedStaging(layout, journal);
    return { status: "migrated", journalPath: layout.journalPath, backupDir: journal.paths.backupDir };
  } catch (error) {
    const activeJournal = loadJournal(layout) ?? journal;
    activeJournal.error = errorMessage(error);
    if (activeJournal.phase === "activating" || activeJournal.phase === "active_validated" || activeJournal.phase === "recovery_required") {
      activeJournal.phase = "recovery_required";
      writeJournal(layout.journalPath, activeJournal);
      try {
        restoreFromBackup(activeJournal, layout);
        archiveJournal(layout, activeJournal, "recovered-after-failure");
        throw new ShadowMigrationError(
          `Migration failed after activation began; the verified original data was restored. ${errorMessage(error)}`,
          { cause: error }
        );
      } catch (recoveryError) {
        if (recoveryError instanceof ShadowMigrationError && recoveryError.cause === error) throw recoveryError;
        activeJournal.error = `${errorMessage(error)}; recovery failed: ${errorMessage(recoveryError)}`;
        activeJournal.phase = "recovery_required";
        writeJournal(layout.journalPath, activeJournal);
        throw new ShadowMigrationError(
          `Migration failed and could not restore automatically. Do not start Guardian; use ${activeJournal.paths.backupDir}. ${errorMessage(recoveryError)}`,
          { cause: recoveryError }
        );
      }
    }
    writeJournal(layout.journalPath, activeJournal);
    throw new ShadowMigrationError(
      `Migration staging failed before live data was changed. ${errorMessage(error)}`,
      { cause: error }
    );
  }
}
async function runGuardianShadowMigration(paths) {
  const layout = resolveLayout(paths);
  const configExists = ensureFileOrAbsent(layout.configPath, "configuration");
  const databaseExists = ensureFileOrAbsent(layout.databasePath, "database");
  const journalExists = existsSync6(layout.journalPath);
  if (!configExists && !databaseExists && !journalExists) {
    return { status: "not-needed", journalPath: layout.journalPath };
  }
  if (!journalExists && !configExists && databaseExists) {
    throw new ShadowMigrationError(
      `Refusing to create a replacement config for an existing database. Restore ${layout.configPath} first.`
    );
  }
  const release = acquireMigrationLock(layout.dataDir);
  try {
    const recovery = await recoverIncompleteJournal(layout);
    if (recovery === "completed") {
      const completed = loadJournal(layout);
      return {
        status: "recovered",
        journalPath: layout.journalPath,
        backupDir: completed?.paths.backupDir
      };
    }
    const completedJournal = loadJournal(layout);
    const nowConfigExists = ensureFileOrAbsent(layout.configPath, "configuration");
    const nowDatabaseExists = ensureFileOrAbsent(layout.databasePath, "database");
    if (completedJournal?.phase === "completed" && (!nowConfigExists || !nowDatabaseExists)) {
      const missing = [
        !nowConfigExists ? "configuration" : null,
        !nowDatabaseExists ? "database" : null
      ].filter(Boolean).join(" and ");
      throw new ShadowMigrationError(
        `A completed migration journal exists but the active ${missing} is missing. Restore the verified backup in ${completedJournal.paths.backupDir} before starting Guardian.`
      );
    }
    if (!nowConfigExists && !nowDatabaseExists) {
      return { status: "not-needed", journalPath: layout.journalPath };
    }
    if (!nowConfigExists) {
      throw new ShadowMigrationError(`configuration disappeared during migration recovery: ${layout.configPath}`);
    }
    const rawConfig = readJson(layout.configPath);
    const activeConfigSchemaVersion = asRecord2(rawConfig, "config file").schemaVersion;
    const canonicalConfig = await configIsCanonical(layout);
    const canonicalDatabase = nowDatabaseExists ? await databaseIsCanonical(layout) : false;
    const verifiedConfigUpgrade = completedJournal?.phase === "completed" && !canonicalConfig ? completedJournalProvesPreviousConfigGeneration(
      completedJournal,
      layout,
      activeConfigSchemaVersion,
      canonicalDatabase
    ) : false;
    if (completedJournal?.phase === "completed" && (!canonicalConfig || !canonicalDatabase) && !verifiedConfigUpgrade) {
      throw new ShadowMigrationError(
        `A completed migration journal conflicts with restored legacy data. Restore with the matching pre-migration release, or archive ${layout.journalPath} before intentionally rerunning migration.`
      );
    }
    if (canonicalConfig && (!nowDatabaseExists || canonicalDatabase)) {
      return {
        status: completedJournal?.phase === "completed" ? "already-migrated" : "not-needed",
        journalPath: layout.journalPath,
        backupDir: completedJournal?.paths.backupDir
      };
    }
    if (verifiedConfigUpgrade) {
      archiveJournal(layout, completedJournal, "superseded-by-schema-upgrade");
    }
    return await performMigration(layout);
  } finally {
    release();
  }
}

// src/lifecycle.ts
var state = "idle";
var bootPromise = null;
var generation = 0;
function readPackageVersion(pluginPath) {
  try {
    const packagePath = join7(pluginPath, "package.json");
    if (existsSync7(packagePath)) {
      return JSON.parse(readFileSync4(packagePath, "utf8")).version ?? "1.0.0";
    }
  } catch {
  }
  return "1.0.0";
}
function ensurePrivateDirectory(directory) {
  mkdirSync6(directory, { recursive: true, mode: 448 });
  try {
    chmodSync4(directory, 448);
  } catch {
  }
}
async function cleanup() {
  const steps = [
    () => stopAuditModule(),
    () => captchaService.stop(),
    () => stopApprovalSync(),
    () => intelService.stop(),
    () => stopCurfewModule(),
    () => stopMonitorModule(),
    () => stopStatisticsModule(),
    () => closeDatabase(),
    () => bus.removeAllListeners(),
    () => clearRuntimeHost()
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.error("[qq-guardian] cleanup step failed", error);
    }
  }
}
function ensureBootIsCurrent(expectedGeneration) {
  if (state !== "booting" || generation !== expectedGeneration) {
    throw new Error("Guardian startup was interrupted by teardown");
  }
}
function registerWebUi(host) {
  const { pluginPath } = host.paths;
  const candidates = [
    { absolute: join7(pluginPath, "dist", "webui", "index.html"), relative: "dist/webui/index.html" },
    { absolute: join7(pluginPath, "webui", "index.html"), relative: "webui/index.html" }
  ];
  const found = candidates.find((candidate) => existsSync7(candidate.absolute));
  const log = getLogger().child({ module: "lifecycle" });
  if (!found) {
    log.warn("WebUI index.html not found; run pnpm build");
    return;
  }
  host.router.static("/static", dirname3(found.relative));
  host.router.page({
    path: "guardian",
    title: "QQ Guardian",
    icon: "\u{1F6E1}\uFE0F",
    htmlFile: found.relative,
    description: "QQ Group Guardian management panel"
  });
  log.info({ htmlFile: found.relative }, "WebUI registered");
}
async function boot(host) {
  if (state === "running") return;
  if (state === "booting" && bootPromise) return bootPromise;
  if (state === "stopping") throw new Error("Guardian is stopping; wait for teardown to complete");
  state = "booting";
  const bootGeneration = ++generation;
  const task = (async () => {
    const log = getLogger().child({ module: "lifecycle" });
    try {
      setRuntimeHost(host);
      const { dataPath, configDir, pluginPath } = host.paths;
      for (const directory of [dataPath, join7(dataPath, "backups"), configDir]) {
        ensurePrivateDirectory(directory);
      }
      log.info({ runtime: host.kind }, "Plugin booting");
      const migration = await runGuardianShadowMigration({ configDir, dataDir: dataPath });
      log.info({ migration: migration.status, backupDir: migration.backupDir }, "Persistent storage migration checked");
      configManager.init(configDir);
      const config = configManager.get();
      const unsafeAiWarning = privateAIEndpointStartupWarning();
      if (unsafeAiWarning) {
        log.warn({ setting: PRIVATE_AI_ENDPOINTS_ENV }, unsafeAiWarning);
      }
      ensureBootIsCurrent(bootGeneration);
      openDatabase(dataPath);
      ensureBootIsCurrent(bootGeneration);
      log.info("Database ready");
      initAuditModule();
      await initCurfewModule();
      initStatisticsModule();
      initMonitorModule();
      captchaService.init();
      riskService.reloadRules();
      intelService.init();
      ensureBootIsCurrent(bootGeneration);
      await ensureBootstrapAdmin();
      ensureBootIsCurrent(bootGeneration);
      registerWebUi(host);
      registerRoutes();
      log.info("API routes registered");
      await bootstrapGroups();
      ensureBootIsCurrent(bootGeneration);
      initApprovalSync();
      const version7 = readPackageVersion(pluginPath);
      setCurrentVersion(version7);
      if (config.update.autoCheckOnStartup) {
        void checkForUpdate().then((info) => {
          if (info) log.info({ version: info.version }, "Update available");
        }).catch((error) => log.debug(error, "Update check skipped"));
      }
      ensureBootIsCurrent(bootGeneration);
      state = "running";
      log.info({ version: version7 }, "Plugin boot complete");
    } catch (error) {
      log.error(error, "Boot failed; cleaning up partial initialization");
      await cleanup();
      if (state === "booting" && generation === bootGeneration) state = "idle";
      throw error;
    }
  })();
  bootPromise = task;
  try {
    await task;
  } finally {
    if (bootPromise === task) bootPromise = null;
  }
}
async function teardown() {
  if (state === "idle" || state === "stopping") return;
  const log = getLogger().child({ module: "lifecycle" });
  const inFlightBoot = bootPromise;
  state = "stopping";
  generation += 1;
  log.info("Plugin tearing down");
  await cleanup();
  if (inFlightBoot) {
    try {
      await inFlightBoot;
    } catch {
    }
  }
  state = "idle";
  log.info("Plugin teardown complete");
}

// src/adapters/napcat/runtime-host.ts
import { existsSync as existsSync8, statSync as statSync2 } from "node:fs";
import { basename, dirname as dirname4, resolve as resolve3 } from "node:path";

// src/runtime/onebot-provider.ts
var GUARDIAN_ONEBOT_ACTIONS = Object.freeze([
  "get_login_info",
  "get_group_list",
  "get_group_member_info",
  "get_group_system_msg",
  "send_group_msg",
  "send_private_msg",
  "delete_msg",
  "set_group_ban",
  "set_group_kick",
  "set_group_whole_ban",
  "set_group_add_request"
]);
var GUARDIAN_ONEBOT_EVENTS = Object.freeze([
  "message.group",
  "message.private",
  "request.group.add",
  "notice.group_increase"
]);
var GUARDIAN_ONEBOT_MESSAGES = Object.freeze([
  "segment.text",
  "segment.at",
  "segment.reply",
  "segment.json",
  "segment.miniapp"
]);
var SENSITIVE_VALUE = /((?:access[_-]?token|authorization|password|secret|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi;
var BEARER_TOKEN = /(bearer\s+)[a-z0-9._~+\/-]+/gi;
var URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
var QUERY_SECRET = /([?&](?:access_token|token|key|secret)=)[^&#\s]+/gi;
var MAX_DIAGNOSTIC_LENGTH = 256;
function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function sanitizeProviderDiagnostic(value) {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "").trim();
  if (!raw) return void 0;
  const sanitized = raw.replace(BEARER_TOKEN, "$1[REDACTED]").replace(URL_CREDENTIALS, "$1[REDACTED]@").replace(QUERY_SECRET, "$1[REDACTED]").replace(SENSITIVE_VALUE, "$1[REDACTED]");
  return sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH);
}
var OneBotProviderError = class extends Error {
  category;
  provider;
  action;
  providerCode;
  retryable;
  diagnostic;
  constructor(options) {
    super(`OneBot action ${options.action} failed (${options.category})`, { cause: options.cause });
    this.name = "OneBotProviderError";
    this.category = options.category;
    this.provider = options.provider;
    this.action = options.action;
    this.providerCode = options.providerCode;
    this.retryable = options.retryable ?? false;
    this.diagnostic = sanitizeProviderDiagnostic(options.diagnostic);
  }
};
function createOneBotCapabilities(options = {}) {
  return Object.freeze({
    actions: Object.freeze([...new Set(options.actions ?? [])]),
    events: Object.freeze([...new Set(options.events ?? [])]),
    messages: Object.freeze([...new Set(options.messages ?? [])]),
    transports: Object.freeze([...new Set(options.transports ?? [])])
  });
}
function createGuardianOneBotCapabilities(transports) {
  return createOneBotCapabilities({
    actions: GUARDIAN_ONEBOT_ACTIONS,
    events: GUARDIAN_ONEBOT_EVENTS,
    messages: GUARDIAN_ONEBOT_MESSAGES,
    transports
  });
}
function requireOneBotId(params, key) {
  if (normalizeOneBotId(params[key]) === null) throw new TypeError(`${key} must be a canonical OneBot identifier`);
}
function requireBoolean(params, key) {
  if (typeof params[key] !== "boolean") throw new TypeError(`${key} must be boolean`);
}
function requireNonEmptyString(params, key) {
  if (typeof params[key] !== "string" || !params[key].trim()) throw new TypeError(`${key} must be a non-empty string`);
}
function requireMessage(params) {
  const message = params["message"];
  if (typeof message === "string") return;
  if (Array.isArray(message)) return;
  throw new TypeError("message must be a string or OneBot segment array");
}
function validateOneBotActionParameters(action, params) {
  if (!isPlainRecord(params)) throw new TypeError("OneBot action parameters must be an object");
  switch (action) {
    case "get_login_info":
    case "get_group_list":
    case "get_group_system_msg":
      return;
    case "get_group_member_info":
      requireOneBotId(params, "group_id");
      requireOneBotId(params, "user_id");
      if (params["no_cache"] !== void 0) requireBoolean(params, "no_cache");
      return;
    case "send_group_msg":
      requireOneBotId(params, "group_id");
      requireMessage(params);
      return;
    case "send_private_msg":
      requireOneBotId(params, "user_id");
      requireMessage(params);
      return;
    case "delete_msg":
      if (normalizeOneBotMessageId(params["message_id"]) === null) {
        throw new TypeError("message_id must be a canonical OneBot message handle");
      }
      return;
    case "set_group_ban":
      requireOneBotId(params, "group_id");
      requireOneBotId(params, "user_id");
      if (!Number.isSafeInteger(params["duration"]) || Number(params["duration"]) < 0) {
        throw new TypeError("duration must be a non-negative safe integer");
      }
      return;
    case "set_group_kick":
      requireOneBotId(params, "group_id");
      requireOneBotId(params, "user_id");
      if (params["reject_add_request"] !== void 0) requireBoolean(params, "reject_add_request");
      return;
    case "set_group_whole_ban":
      requireOneBotId(params, "group_id");
      requireBoolean(params, "enable");
      return;
    case "set_group_add_request":
      requireNonEmptyString(params, "flag");
      requireBoolean(params, "approve");
      if (params["sub_type"] !== void 0) requireNonEmptyString(params, "sub_type");
      if (params["reason"] !== void 0 && typeof params["reason"] !== "string") {
        throw new TypeError("reason must be a string");
      }
      return;
    default:
      return;
  }
}
function unwrapOneBotEnvelope(provider, action, value) {
  if (!isPlainRecord(value)) return value;
  const hasEnvelopeKey = "status" in value || "retcode" in value;
  if (!hasEnvelopeKey) return value;
  const status = value["status"];
  const retcode = value["retcode"];
  if (status !== void 0 && status !== "ok" && status !== "failed") {
    throw new OneBotProviderError({
      category: "invalid_response",
      provider,
      action,
      diagnostic: "invalid OneBot status field"
    });
  }
  if (retcode !== void 0 && !Number.isSafeInteger(retcode)) {
    throw new OneBotProviderError({
      category: "invalid_response",
      provider,
      action,
      diagnostic: "invalid OneBot retcode field"
    });
  }
  if (status === "failed" || typeof retcode === "number" && retcode !== 0) {
    throw new OneBotProviderError({
      category: "logical",
      provider,
      action,
      providerCode: typeof retcode === "number" ? retcode : void 0,
      diagnostic: typeof value["wording"] === "string" ? value["wording"] : typeof value["message"] === "string" ? value["message"] : "provider returned a failed OneBot envelope"
    });
  }
  return "data" in value ? value["data"] : null;
}
function normalizedIdField(provider, action, value, key) {
  const normalized = normalizeOneBotId(value[key]);
  if (normalized === null) {
    throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: `invalid ${key}` });
  }
  return normalized;
}
function normalizeOneBotActionResponse(provider, action, value) {
  switch (action) {
    case "get_login_info": {
      if (!isPlainRecord(value) || typeof value["nickname"] !== "string") {
        throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid get_login_info response" });
      }
      return { ...value, user_id: normalizedIdField(provider, action, value, "user_id") };
    }
    case "get_group_list": {
      if (!Array.isArray(value)) {
        throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid get_group_list response" });
      }
      return value.map((item) => {
        if (!isPlainRecord(item) || typeof item["group_name"] !== "string" || !Number.isSafeInteger(item["member_count"]) || Number(item["member_count"]) < 0 || !Number.isSafeInteger(item["max_member_count"]) || Number(item["max_member_count"]) < 0) {
          throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid group-list entry" });
        }
        return { ...item, group_id: normalizedIdField(provider, action, item, "group_id") };
      });
    }
    case "get_group_member_info": {
      if (!isPlainRecord(value)) {
        throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid member-info response" });
      }
      const role = value["role"];
      if (role !== "member" && role !== "admin" && role !== "owner") {
        throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid member-info role" });
      }
      return {
        ...value,
        group_id: normalizedIdField(provider, action, value, "group_id"),
        user_id: normalizedIdField(provider, action, value, "user_id")
      };
    }
    case "get_group_system_msg":
      if (!isPlainRecord(value)) {
        throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid group-system-message response" });
      }
      return value;
    case "send_group_msg":
    case "send_private_msg": {
      if (!isPlainRecord(value)) {
        throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid send-message response" });
      }
      const messageId = normalizeOneBotMessageId(value["message_id"]);
      if (messageId === null) {
        throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid message_id in send response" });
      }
      return { ...value, message_id: messageId };
    }
    case "delete_msg":
    case "set_group_ban":
    case "set_group_kick":
    case "set_group_whole_ban":
    case "set_group_add_request":
      if (value === null || value === void 0) return null;
      if (isPlainRecord(value)) return value;
      throw new OneBotProviderError({ category: "invalid_response", provider, action, diagnostic: "invalid mutation response" });
    default:
      return value;
  }
}
function classifyUnknownProviderError(error) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${name} ${message}`.toLowerCase();
  if (/unauthori[sz]ed|forbidden|authentication|authorization|invalid[^\n]*token|\b(?:401|403)\b/.test(text)) return "authentication";
  if (name === "AbortError" || /timed?\s*out|timeout/.test(text)) return "timeout";
  if (/not connected|disconnect|connection[^\n]*(?:closed|failed|refused|reset)|econn(?:refused|reset)|\bepipe\b/.test(text)) return "connection";
  if (/network|fetch failed|socket|websocket/.test(text)) return "transport";
  if (/unsupported[^\n]*action|unknown[^\n]*action|action[^\n]*not supported/.test(text)) return "unsupported";
  if (/malformed|protocol|frame|invalid[^\n]*(?:packet|response|json)/.test(text)) return "protocol";
  if (/retcode|onebot[^\n]*failed|action[^\n]*failed|provider[^\n]*failed/.test(text)) return "logical";
  return "adapter_internal";
}
function normalizeOneBotProviderError(options) {
  if (options.error instanceof OneBotProviderError) return options.error;
  const category = classifyUnknownProviderError(options.error);
  const providerCode = options.error && typeof options.error === "object" && "code" in options.error && (typeof options.error.code === "string" || typeof options.error.code === "number") ? options.error.code : void 0;
  return new OneBotProviderError({
    category,
    provider: options.provider,
    action: options.action,
    providerCode,
    retryable: category === "transport" || category === "connection" || category === "timeout",
    diagnostic: options.error,
    cause: options.error
  });
}
function createOneBotGateway(options) {
  const actions = new Set(options.capabilities.actions);
  const events = new Set(options.capabilities.events);
  const messages = new Set(options.capabilities.messages);
  const transports = new Set(options.capabilities.transports);
  return Object.freeze({
    identity: options.identity,
    capabilities: options.capabilities,
    supportsAction: (action) => actions.has(action),
    supportsEvent: (event) => events.has(event),
    supportsMessage: (segment) => messages.has(segment),
    supportsTransport: (transport) => transports.has(transport),
    connectionState: options.connectionState,
    async call(action, params = {}) {
      if (!actions.has(action)) {
        throw new OneBotProviderError({
          category: "capability_mismatch",
          provider: options.identity,
          action,
          diagnostic: "action is not declared by provider capabilities"
        });
      }
      try {
        validateOneBotActionParameters(action, params);
      } catch (error) {
        throw new OneBotProviderError({
          category: "invalid_parameters",
          provider: options.identity,
          action,
          diagnostic: error,
          cause: error
        });
      }
      let raw;
      try {
        raw = await options.invoke(action, params);
      } catch (error) {
        throw normalizeOneBotProviderError({ provider: options.identity, action, error });
      }
      const unwrapped = unwrapOneBotEnvelope(options.identity, action, raw);
      return normalizeOneBotActionResponse(options.identity, action, unwrapped);
    }
  });
}

// src/adapters/napcat/runtime-host.ts
var VOID_RESPONSE_ACTIONS = /* @__PURE__ */ new Set([
  "delete_msg",
  "set_group_ban",
  "set_group_whole_ban",
  "set_group_kick",
  "set_group_add_request"
]);
function resolveNapCatConfigDir(configPath) {
  const absolutePath = resolve3(configPath);
  if (existsSync8(absolutePath)) {
    return statSync2(absolutePath).isDirectory() ? absolutePath : dirname4(absolutePath);
  }
  return basename(absolutePath).toLowerCase() === "config.json" ? dirname4(absolutePath) : absolutePath;
}
function createNapCatRuntimeHost(ctx) {
  const provider = createProviderDiagnostics({
    provider: "napcat",
    transport: "napcat-action-api",
    isConnected: () => true
  });
  const onebot = createOneBotGateway({
    identity: "napcat",
    capabilities: createGuardianOneBotCapabilities(["plugin-api"]),
    connectionState: () => provider.snapshot().state,
    invoke: async (action, params) => {
      try {
        return await ctx.actions.call(action, params, ctx.adapterName, ctx.pluginManager.config);
      } catch (error) {
        if (VOID_RESPONSE_ACTIONS.has(action) && error instanceof Error && /no data returned/i.test(error.message)) {
          return null;
        }
        throw error;
      }
    }
  });
  return {
    kind: "napcat",
    pluginId: ctx.pluginName || "napcat-plugin-qq-guardian",
    paths: {
      pluginPath: ctx.pluginPath,
      dataPath: ctx.dataPath,
      configDir: resolveNapCatConfigDir(ctx.configPath)
    },
    logger: ctx.logger,
    provider,
    onebot,
    router: ctx.router
  };
}

// src/index.ts
async function plugin_init(ctx) {
  await boot(createNapCatRuntimeHost(ctx));
}
async function plugin_cleanup(_ctx) {
  await teardown();
}
var plugin_config_schema = [
  {
    key: "selfId",
    type: "string",
    label: "\u673A\u5668\u4EBA QQ \u53F7 / Bot QQ ID",
    description: "\u8FD0\u884C\u672C\u63D2\u4EF6\u7684\u673A\u5668\u4EBA QQ \u53F7 (Bot account QQ number)",
    default: "0"
  },
  {
    key: "defaultApproval",
    type: "select",
    label: "\u9ED8\u8BA4\u5165\u7FA4\u5BA1\u6279\u65B9\u5F0F / Default Approval",
    description: "\u672A\u5355\u72EC\u914D\u7F6E\u7684\u7FA4\u7684\u9ED8\u8BA4\u5904\u7406\u65B9\u5F0F",
    options: [
      { label: "\u4EBA\u5DE5\u5BA1\u6838 (Manual)", value: "manual" },
      { label: "\u81EA\u52A8\u901A\u8FC7 (Auto-approve)", value: "auto_approve" },
      { label: "\u81EA\u52A8\u62D2\u7EDD (Auto-reject)", value: "auto_reject" },
      { label: "\u9A8C\u8BC1\u7801 (Captcha)", value: "captcha" }
    ],
    default: "manual"
  },
  {
    key: "riskEnabled",
    type: "boolean",
    label: "\u542F\u7528\u98CE\u9669\u63A7\u5236 / Enable Risk Control",
    description: "\u81EA\u52A8\u68C0\u6D4B\u5E76\u5904\u7406\u8FDD\u89C4\u6D88\u606F\u3002\u6BCF\u7C7B\u68C0\u6D4B\u5668\u7684\u5904\u7406\u52A8\u4F5C\u8BF7\u5728 WebUI \u8BBE\u7F6E\u9875\u914D\u7F6E / Per-detector actions are configured in the WebUI Settings page",
    default: true
  },
  {
    key: "autoKickBlacklisted",
    type: "boolean",
    label: "\u81EA\u52A8\u8E22\u51FA\u9ED1\u540D\u5355\u7528\u6237 / Auto-kick Blacklisted",
    description: "\u9ED1\u540D\u5355\u7528\u6237\u5165\u7FA4\u65F6\u81EA\u52A8\u8E22\u51FA",
    default: true
  },
  {
    key: "riskRecallMessage",
    type: "boolean",
    label: "\u64A4\u56DE\u8FDD\u89C4\u6D88\u606F / Recall Risky Messages",
    description: "\u68C0\u6D4B\u5230\u98CE\u9669\u6D88\u606F\u65F6\u540C\u65F6\u64A4\u56DE\u8BE5\u6D88\u606F\uFF08\u9644\u52A0\u4E8E\u98CE\u9669\u5904\u7406\u52A8\u4F5C\u4E4B\u4E0A\uFF09",
    default: false
  },
  {
    key: "approvalRealtimeSync",
    type: "boolean",
    label: "\u5B9E\u65F6\u540C\u6B65\u5165\u7FA4\u7533\u8BF7 / Realtime Admission Sync",
    description: "\u5B9A\u65F6\u62C9\u53D6\u7FA4\u7CFB\u7EDF\u6D88\u606F\uFF0C\u8865\u5904\u7406\u9519\u8FC7\u7684\u5165\u7FA4\u7533\u8BF7\uFF08\u673A\u5668\u4EBA\u79BB\u7EBF/\u91CD\u542F\u671F\u95F4\u7684\u7533\u8BF7\u4E5F\u4F1A\u6309\u6700\u65B0\u6570\u636E\u5BA1\u6279\uFF09",
    default: true
  },
  {
    key: "useBuiltinApproveKeywords",
    type: "boolean",
    label: "\u5185\u7F6E\u901A\u8FC7\u5173\u952E\u8BCD / Built-in Approve Keywords",
    description: "\u9AD8\u98CE\u9669\u663E\u5F0F\u9009\u9879\uFF1A\u7533\u8BF7\u4EBA\u53EF\u4F2A\u9020\u201C\u670B\u53CB\u63A8\u8350\u201D\u7B49\u6587\u672C\uFF1B\u542F\u7528\u540E\u4EBA\u5DE5\u5BA1\u6838\u7FA4\u4F1A\u81EA\u52A8\u653E\u884C\u5339\u914D\u8005\u3002\u9ED8\u8BA4\u5173\u95ED\uFF0C\u5EFA\u8BAE\u6539\u7528\u6BCF\u7FA4\u53EF\u4FE1\u89C4\u5219 / HIGH RISK: applicant-controlled referral text can bypass manual review; prefer trusted per-group rules",
    default: false
  },
  {
    key: "intelEnabled",
    type: "boolean",
    label: "\u4E91\u7AEF\u98CE\u63A7\u6570\u636E / Cloud Intel Feed",
    description: "\u542F\u7528\u540E\u9ED8\u8BA4\u4EC5\u89C2\u5BDF\uFF1B\u8FDC\u7AEF\u5BA1\u6838/\u5904\u7F5A\u8FD8\u9700\u8981\u8D85\u7EA7\u7BA1\u7406\u5458\u914D\u7F6E SHA-256 \u56FA\u5B9A\u503C\u5E76\u9009\u62E9 enforce / enabled feeds observe by default; remote actions require super-admin SHA-256 pins plus enforce mode",
    default: false
  },
  {
    key: "commandsEnabled",
    type: "boolean",
    label: "\u542F\u7528\u7FA4\u5185\u6307\u4EE4 / Enable In-chat Commands",
    description: "\u5141\u8BB8\u7FA4\u4E3B/\u7BA1\u7406\u5458\u5728\u7FA4\u5185\u4F7F\u7528\u6307\u4EE4\uFF08\u5982 /guard mute @\u67D0\u4EBA 10\uFF09",
    default: true
  },
  {
    key: "commandPrefix",
    type: "string",
    label: "\u6307\u4EE4\u524D\u7F00 / Command Prefix",
    description: "\u7FA4\u5185\u6307\u4EE4\u7684\u524D\u7F00\uFF0C\u9ED8\u8BA4 /guard",
    default: "/guard"
  },
  {
    key: "githubRepo",
    type: "string",
    label: "GitHub \u4ED3\u5E93 / GitHub Repo (update check)",
    description: "\u683C\u5F0F \u7528\u6237\u540D/\u4ED3\u5E93\u540D\uFF0C\u6307\u5411\u4F60\u81EA\u5DF1\u7684\u4ED3\u5E93\u624D\u80FD\u68C0\u6D4B\u5230\u4F60\u53D1\u5E03\u7684\u65B0\u7248\u672C / format owner/repo \u2014 point at your own fork to detect your own releases",
    default: "ShiYuPIay/napcat-plugin-qq-guardian"
  }
];
async function plugin_get_config(_ctx) {
  try {
    const cfg = configManager.get();
    return {
      selfId: cfg.core?.selfId ?? "0",
      defaultApproval: cfg.approval?.defaultAction ?? "manual",
      riskEnabled: cfg.risk?.enabled ?? true,
      autoKickBlacklisted: cfg.blacklist?.autoKickOnJoin ?? true,
      riskRecallMessage: cfg.risk?.recallMessage ?? false,
      approvalRealtimeSync: cfg.approval?.realtimeSyncEnabled ?? true,
      useBuiltinApproveKeywords: cfg.approval?.useBuiltinApproveKeywords ?? false,
      intelEnabled: cfg.intel?.enabled ?? false,
      commandsEnabled: cfg.commands?.enabled ?? true,
      commandPrefix: cfg.commands?.prefix ?? "/guard",
      githubRepo: cfg.update?.githubRepo ?? "ShiYuPIay/napcat-plugin-qq-guardian"
    };
  } catch {
    return { selfId: "0", defaultApproval: "manual", riskEnabled: true, autoKickBlacklisted: true, riskRecallMessage: false, approvalRealtimeSync: true, useBuiltinApproveKeywords: false, intelEnabled: false, commandsEnabled: true, commandPrefix: "/guard", githubRepo: "ShiYuPIay/napcat-plugin-qq-guardian" };
  }
}
async function plugin_set_config(_ctx, config) {
  if (!configManager.get()) return;
  const c = config;
  const requestedSelfId = c["selfId"];
  const selfId = requestedSelfId === void 0 ? void 0 : normalizeOneBotId(requestedSelfId, { allowZero: true });
  if (requestedSelfId !== void 0 && selfId === null) {
    throw new TypeError("selfId must be an exact unsigned 64-bit decimal identifier");
  }
  configManager.update({
    core: { selfId: selfId ?? void 0 },
    approval: {
      defaultAction: ["auto_approve", "auto_reject", "manual", "captcha"].includes(c["defaultApproval"]) ? c["defaultApproval"] : void 0,
      realtimeSyncEnabled: parseBoolean(c["approvalRealtimeSync"]),
      useBuiltinApproveKeywords: parseBoolean(c["useBuiltinApproveKeywords"])
    },
    intel: { enabled: parseBoolean(c["intelEnabled"]) },
    risk: {
      enabled: parseBoolean(c["riskEnabled"]),
      recallMessage: parseBoolean(c["riskRecallMessage"])
    },
    blacklist: { autoKickOnJoin: parseBoolean(c["autoKickBlacklisted"]) },
    commands: {
      enabled: parseBoolean(c["commandsEnabled"]),
      prefix: typeof c["commandPrefix"] === "string" && c["commandPrefix"].trim() ? c["commandPrefix"].trim() : void 0
    },
    update: { githubRepo: c["githubRepo"] !== void 0 ? String(c["githubRepo"]) : void 0 }
  });
}
export {
  plugin_cleanup,
  plugin_config_schema,
  plugin_get_config,
  plugin_init,
  plugin_onevent,
  plugin_onmessage,
  plugin_set_config
};
