import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes } from '../../src/api/index.ts';
import { configManager } from '../../src/core/config/index.ts';
import { hashPassword } from '../../src/core/crypto/index.ts';
import { closeDatabase, openDatabase } from '../../src/database/index.ts';
import { login } from '../../src/modules/auth/index.ts';
import type {
  GuardianHttpRequest,
  GuardianHttpResponse,
  GuardianRequestHandler,
} from '../../src/ports/http.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import { insertUserFixture } from '../helpers/user-fixtures.ts';

const roots: string[] = [];

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
  return {
    response,
    read: () => ({ statusCode, payload }),
  };
}

function request(
  token: string,
  params: Record<string, string> = {},
  body: unknown = {},
): GuardianHttpRequest {
  return {
    path: '',
    method: '',
    query: {},
    body,
    headers: { authorization: `Bearer ${token}` },
    params,
    raw: null,
  };
}

describe('user-management API invariant', () => {
  it('returns stable errors and exposes only the non-secret usability marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-user-api-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    configManager.init(join(root, 'config'));
    openDatabase(dataDir);

    const routes = new Map<string, GuardianRequestHandler>();
    const route = (method: string) =>
      (path: string, handler: GuardianRequestHandler) => routes.set(`${method} ${path}`, handler);
    const router = {
      getNoAuth: route('GET'),
      postNoAuth: route('POST'),
      putNoAuth: route('PUT'),
      deleteNoAuth: route('DELETE'),
    };
    setRuntimeHost({
      kind: 'snowluma',
      pluginId: 'test',
      paths: { pluginPath: root, dataPath: dataDir, configDir: join(root, 'config') },
      logger: console,
      onebot: { call: async () => null },
      router: router as never,
    });

    const administrator = insertUserFixture({
      username: 'api-admin',
      passwordHash: await hashPassword('Api-Admin-Password-123!'),
      role: 'super_admin',
    });
    const signedIn = await login('api-admin', 'Api-Admin-Password-123!', '127.0.0.1');
    assert.ok(signedIn.accessToken);
    registerRoutes();

    const listCapture = responseCapture();
    await routes.get('GET /users')!(
      request(signedIn.accessToken!),
      listCapture.response,
      () => {},
    );
    const listed = listCapture.read();
    assert.equal(listed.statusCode, 200);
    const listBody = listed.payload as {
      code: number;
      data: Array<Record<string, unknown>>;
    };
    assert.equal(listBody.code, 0);
    assert.equal(listBody.data[0]?.['is_usable_super_admin'], true);
    assert.equal('password_hash' in listBody.data[0]!, false);

    const updateCapture = responseCapture();
    await routes.get('PUT /users/:id')!(
      request(signedIn.accessToken!, { id: String(administrator.id) }, { role: 'viewer' }),
      updateCapture.response,
      () => {},
    );
    assert.deepEqual(updateCapture.read(), {
      statusCode: 409,
      payload: {
        code: -1,
        message: 'At least one unlocked, password-enabled super administrator must remain',
      },
    });

    const deleteCapture = responseCapture();
    await routes.get('DELETE /users/:id')!(
      request(signedIn.accessToken!, { id: String(administrator.id) }),
      deleteCapture.response,
      () => {},
    );
    assert.deepEqual(deleteCapture.read(), {
      statusCode: 400,
      payload: { code: -1, message: 'Cannot delete your own account' },
    });
  });
});
