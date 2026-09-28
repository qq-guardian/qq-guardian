import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { registerRoutes } from '../../src/api/index.ts';
import { configManager } from '../../src/core/config/index.ts';
import { hashPassword } from '../../src/core/crypto/index.ts';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import { login } from '../../src/modules/auth/index.ts';
import type {
  GuardianHttpRequest,
  GuardianHttpResponse,
  GuardianRequestHandler,
} from '../../src/ports/http.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import { insertUserFixture } from '../helpers/user-fixtures.ts';

const roots: string[] = [];
const MAX_SIGNED_64 = '9223372036854775807';
const FIRST_UNSAFE_INTEGER = '9007199254740992';

afterEach(() => {
  closeDatabase();
  clearRuntimeHost();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function responseCapture() {
  let statusCode = 200;
  let payload: unknown;
  const response: GuardianHttpResponse = {
    status(code) { statusCode = code; return response; },
    json(data) { payload = data; },
    send(data) { payload = data; },
    setHeader() { return response; },
    sendFile() {},
    redirect() {},
    raw: null,
  };
  return { response, read: () => ({ statusCode, payload }) };
}

function request(
  token: string,
  params: Record<string, string> = {},
  body: unknown = {},
  query: Record<string, string | string[] | undefined> = {},
): GuardianHttpRequest {
  return {
    path: '',
    method: '',
    query,
    body,
    headers: { authorization: `Bearer ${token}` },
    params,
    raw: null,
  };
}

async function invoke(
  routes: Map<string, GuardianRequestHandler>,
  route: string,
  req: GuardianHttpRequest,
): Promise<{ statusCode: number; payload: unknown }> {
  const capture = responseCapture();
  await routes.get(route)!(req, capture.response, () => {});
  return capture.read();
}

describe('OneBot identifier REST API contract', () => {
  it('round-trips exact decimal strings and rejects unsafe numeric bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-onebot-api-'));
    roots.push(root);
    const configDir = join(root, 'config');
    const dataDir = join(root, 'data');
    const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
    const routes = new Map<string, GuardianRequestHandler>();
    const route = (method: string) =>
      (path: string, handler: GuardianRequestHandler) => routes.set(`${method} ${path}`, handler);

    configManager.init(configDir);
    openDatabase(dataDir);
    setRuntimeHost({
      kind: 'snowluma',
      pluginId: 'api-contract',
      paths: { pluginPath: root, dataPath: dataDir, configDir },
      logger: {
        log() {}, debug() {}, info() {}, warn() {}, error() {},
      },
      onebot: {
        async call(action, params = {}) {
          actions.push({ action, params });
          return null;
        },
      },
      router: {
        getNoAuth: route('GET'),
        postNoAuth: route('POST'),
        putNoAuth: route('PUT'),
        deleteNoAuth: route('DELETE'),
      } as never,
    });

    insertUserFixture({
      username: 'identifier-admin',
      passwordHash: await hashPassword('Identifier-Admin-Password-123!'),
      role: 'super_admin',
    });
    const signedIn = await login(
      'identifier-admin',
      'Identifier-Admin-Password-123!',
      '127.0.0.1',
    );
    assert.ok(signedIn.accessToken);
    const token = signedIn.accessToken!;
    registerRoutes();

    const groupUpdate = await invoke(
      routes,
      'POST /groups/:groupId',
      request(token, { groupId: `0${MAX_SIGNED_64}` }, { enabled: true }),
    );
    assert.equal(groupUpdate.statusCode, 200);
    assert.ok(configManager.get().approval.groups[MAX_SIGNED_64]);
    assert.equal(configManager.get().approval.groups[`0${MAX_SIGNED_64}`], undefined);

    const blacklistAdd = await invoke(
      routes,
      'POST /blacklist',
      request(token, {}, {
        userId: MAX_SIGNED_64,
        groupId: FIRST_UNSAFE_INTEGER,
        reason: 'exact identifier test',
      }),
    );
    assert.equal(blacklistAdd.statusCode, 200);
    const blacklistPayload = blacklistAdd.payload as {
      code: number;
      data: { user_id: string; group_id: string; created_by: string };
    };
    assert.equal(blacklistPayload.code, 0);
    assert.equal(blacklistPayload.data.user_id, MAX_SIGNED_64);
    assert.equal(blacklistPayload.data.group_id, FIRST_UNSAFE_INTEGER);
    assert.equal(blacklistPayload.data.created_by, '1');

    const blacklistList = await invoke(routes, 'GET /blacklist', request(token));
    const listedBlacklist = blacklistList.payload as {
      data: Array<{ user_id: string; group_id: string }>;
    };
    assert.deepEqual(
      listedBlacklist.data.map(({ user_id, group_id }) => ({ user_id, group_id })),
      [{ user_id: MAX_SIGNED_64, group_id: FIRST_UNSAFE_INTEGER }],
    );

    const muteResult = await invoke(
      routes,
      'POST /punishments/mute',
      request(token, {}, {
        groupId: FIRST_UNSAFE_INTEGER,
        userId: MAX_SIGNED_64,
        durationSeconds: 60,
      }),
    );
    assert.equal(muteResult.statusCode, 200);
    assert.deepEqual(
      actions.find((entry) => entry.action === 'set_group_ban')?.params,
      { group_id: FIRST_UNSAFE_INTEGER, user_id: MAX_SIGNED_64, duration: 60 },
    );

    const stored = getDatabase().prepare(`
      SELECT group_id, user_id, operator_id,
        typeof(group_id) AS group_type,
        typeof(user_id) AS user_type,
        typeof(operator_id) AS operator_type
      FROM punishment_records
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...stored }, {
      group_id: FIRST_UNSAFE_INTEGER,
      user_id: MAX_SIGNED_64,
      operator_id: '1',
      group_type: 'text',
      user_type: 'text',
      operator_type: 'text',
    });

    const unsafeNumber = await invoke(
      routes,
      'POST /blacklist',
      request(token, {}, { userId: 9_007_199_254_740_992, reason: 'must reject' }),
    );
    assert.deepEqual(unsafeNumber, {
      statusCode: 400,
      payload: { code: -1, message: 'userId must be a positive integer' },
    });

    const exponent = await invoke(
      routes,
      'POST /punishments/mute',
      request(token, {}, { groupId: '1e6', userId: MAX_SIGNED_64, durationSeconds: 60 }),
    );
    assert.deepEqual(exponent, {
      statusCode: 400,
      payload: { code: -1, message: 'groupId and userId must be positive integers' },
    });

    const configUpdate = await invoke(
      routes,
      'POST /config',
      request(token, {}, { core: { selfId: MAX_SIGNED_64 } }),
    );
    assert.equal(configUpdate.statusCode, 200);
    assert.equal(configManager.get().core.selfId, MAX_SIGNED_64);

    const unsafeConfigUpdate = await invoke(
      routes,
      'POST /config',
      request(token, {}, { core: { selfId: 9_007_199_254_740_992 } }),
    );
    assert.equal(unsafeConfigUpdate.statusCode, 400);
    assert.equal(configManager.get().core.selfId, MAX_SIGNED_64);
  });
});
