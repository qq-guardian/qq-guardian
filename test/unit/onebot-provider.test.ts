import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGuardianOneBotCapabilities,
  createOneBotCapabilities,
  createOneBotGateway,
  GUARDIAN_ONEBOT_ACTIONS,
  identifyOneBotProvider,
  OneBotProviderError,
  sanitizeProviderDiagnostic,
} from '../../src/runtime/onebot-provider.ts';

const validCases: Record<string, { params: Record<string, unknown>; response: unknown }> = {
  get_login_info: {
    params: {},
    response: { user_id: 10001, nickname: 'guardian' },
  },
  get_group_list: {
    params: {},
    response: [{ group_id: 30001, group_name: 'group', member_count: 3, max_member_count: 200 }],
  },
  get_group_member_info: {
    params: { group_id: '30001', user_id: '20001', no_cache: true },
    response: { group_id: 30001, user_id: 20001, role: 'admin' },
  },
  get_group_system_msg: {
    params: {},
    response: { invited_requests: [], join_requests: [] },
  },
  send_group_msg: {
    params: { group_id: '30001', message: [{ type: 'text', data: { text: 'hello' } }] },
    response: { message_id: -42 },
  },
  send_private_msg: {
    params: { user_id: '20001', message: 'hello' },
    response: { message_id: '43' },
  },
  delete_msg: {
    params: { message_id: '-42' },
    response: null,
  },
  set_group_ban: {
    params: { group_id: '30001', user_id: '20001', duration: 60 },
    response: null,
  },
  set_group_kick: {
    params: { group_id: '30001', user_id: '20001', reject_add_request: false },
    response: null,
  },
  set_group_whole_ban: {
    params: { group_id: '30001', enable: true },
    response: null,
  },
  set_group_add_request: {
    params: { flag: 'request-1', sub_type: 'add', approve: true },
    response: null,
  },
};

test('identifies SnowLuma, NapCat, generic OneBot v11, and unknown providers', () => {
  assert.equal(identifyOneBotProvider({ implementation: 'SnowLuma 1.14' }), 'snowluma');
  assert.equal(identifyOneBotProvider({ implementation: 'NapCatQQ' }), 'napcat');
  assert.equal(identifyOneBotProvider({ implementation: 'custom-gateway', protocol: 'OneBot v11' }), 'generic-onebot-v11');
  assert.equal(identifyOneBotProvider({ implementation: 'custom-gateway' }), 'unknown');
});

test('normalizes every action currently emitted by Guardian behind one capability gateway', async () => {
  assert.deepEqual([...GUARDIAN_ONEBOT_ACTIONS].sort(), Object.keys(validCases).sort());
  const gateway = createOneBotGateway({
    identity: 'generic-onebot-v11',
    capabilities: createGuardianOneBotCapabilities(['http']),
    connectionState: () => 'connected',
    invoke: async (action) => validCases[action]?.response,
  });

  for (const action of GUARDIAN_ONEBOT_ACTIONS) {
    const fixture = validCases[action];
    assert.ok(fixture, `missing fixture for ${action}`);
    assert.equal(gateway.supportsAction?.(action), true);
    await gateway.call(action, fixture.params);
  }

  assert.equal(gateway.identity, 'generic-onebot-v11');
  assert.equal(gateway.connectionState?.(), 'connected');
  assert.equal(gateway.supportsEvent?.('message.group'), true);
  assert.equal(gateway.supportsMessage?.('segment.text'), true);
  assert.equal(gateway.supportsTransport?.('http'), true);

  const login = await gateway.call('get_login_info', {}) as Record<string, unknown>;
  const groups = await gateway.call('get_group_list', {}) as Record<string, unknown>[];
  const member = await gateway.call('get_group_member_info', validCases.get_group_member_info.params) as Record<string, unknown>;
  const sent = await gateway.call('send_group_msg', validCases.send_group_msg.params) as Record<string, unknown>;
  assert.equal(login.user_id, '10001');
  assert.equal(groups[0]?.group_id, '30001');
  assert.equal(member.group_id, '30001');
  assert.equal(member.user_id, '20001');
  assert.equal(sent.message_id, '-42');
});

test('does not reject an unknown implementation when declared capabilities are compatible', async () => {
  const gateway = createOneBotGateway({
    identity: 'unknown',
    capabilities: createOneBotCapabilities({ actions: ['get_login_info'], transports: ['plugin-api'] }),
    connectionState: () => 'connected',
    invoke: async () => ({ user_id: '10001', nickname: 'compatible implementation' }),
  });
  const result = await gateway.call('get_login_info', {}) as Record<string, unknown>;
  assert.equal(gateway.identity, 'unknown');
  assert.equal(result.user_id, '10001');
});

test('fails closed on capability mismatches and invalid parameters', async () => {
  const gateway = createOneBotGateway({
    identity: 'generic-onebot-v11',
    capabilities: createOneBotCapabilities({ actions: ['set_group_ban'] }),
    connectionState: () => 'connected',
    invoke: async () => null,
  });

  await assert.rejects(
    gateway.call('set_group_kick', { group_id: '30001', user_id: '20001' }),
    (error: unknown) => error instanceof OneBotProviderError && error.category === 'capability_mismatch',
  );
  await assert.rejects(
    gateway.call('set_group_ban', { group_id: 'not-an-id', user_id: '20001', duration: 60 }),
    (error: unknown) => error instanceof OneBotProviderError && error.category === 'invalid_parameters',
  );
});

test('normalizes failed envelopes to typed logical errors with bounded redacted diagnostics', async () => {
  const gateway = createOneBotGateway({
    identity: 'generic-onebot-v11',
    capabilities: createOneBotCapabilities({ actions: ['get_login_info'] }),
    connectionState: () => 'connected',
    invoke: async () => ({
      status: 'failed',
      retcode: 1404,
      wording: 'unsupported; access_token=super-secret Authorization=Bearer another-secret',
      data: null,
    }),
  });

  await assert.rejects(gateway.call('get_login_info', {}), (error: unknown) => {
    assert.ok(error instanceof OneBotProviderError);
    assert.equal(error.category, 'logical');
    assert.equal(error.providerCode, 1404);
    assert.equal(error.provider, 'generic-onebot-v11');
    assert.doesNotMatch(error.diagnostic ?? '', /super-secret|another-secret/);
    assert.match(error.diagnostic ?? '', /REDACTED/);
    return true;
  });
});

test('normalizes adapter failures and strips credentials from diagnostics', async () => {
  const gateway = createOneBotGateway({
    identity: 'snowluma',
    capabilities: createOneBotCapabilities({ actions: ['get_login_info'] }),
    connectionState: () => 'disconnected',
    invoke: async () => {
      throw new Error('401 unauthorized Authorization=Bearer top-secret at https://user:pass@example.test/?token=query-secret');
    },
  });

  await assert.rejects(gateway.call('get_login_info', {}), (error: unknown) => {
    assert.ok(error instanceof OneBotProviderError);
    assert.equal(error.category, 'authentication');
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.diagnostic ?? '', /top-secret|query-secret|user:pass/);
    return true;
  });

  const sanitized = sanitizeProviderDiagnostic('https://user:pass@example.test/?access_token=secret Authorization=Bearer token');
  assert.doesNotMatch(sanitized ?? '', /user:pass|secret|Bearer token/);
});

test('rejects malformed normalized responses instead of leaking unchecked provider shapes', async () => {
  const gateway = createOneBotGateway({
    identity: 'napcat',
    capabilities: createOneBotCapabilities({ actions: ['get_group_member_info'] }),
    connectionState: () => 'connected',
    invoke: async () => ({ group_id: '30001', user_id: '20001', role: 'root' }),
  });
  await assert.rejects(
    gateway.call('get_group_member_info', { group_id: '30001', user_id: '20001' }),
    (error: unknown) => error instanceof OneBotProviderError && error.category === 'invalid_response',
  );
});
