import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  loadContractSchemas,
  loadProviderContract,
  PROVIDERS,
  validateProviderContract,
} from '../../scripts/lib/provider-contracts.mjs';
import { validateJsonSchema } from '../../scripts/lib/json-schema.mjs';

describe('provider JSON Schema gates', () => {
  for (const provider of PROVIDERS) {
    it(`accepts the reviewed ${provider} compatibility corpus`, () => {
      assert.deepEqual(validateProviderContract(provider), { valid: true, errors: [] });
    });
  }

  it('fails closed when a provider emits a malformed action envelope', () => {
    const contract = structuredClone(loadProviderContract('napcat'));
    contract.cases[0].payload.action = 42;
    const result = validateProviderContract('napcat', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /action: expected string/);
  });

  it('rejects unsafe identifier encodings', () => {
    const contract = structuredClone(loadProviderContract('snowluma'));
    contract.cases[2].payload.user_id = '09007199254740996';
    const result = validateProviderContract('snowluma', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /must match exactly one oneOf branch/);
  });

  it('rejects canonical identifier strings outside the unsigned 64-bit runtime range', () => {
    const contract = structuredClone(loadProviderContract('snowluma'));
    contract.cases[2].payload.group_id = '18446744073709551616';
    const result = validateProviderContract('snowluma', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /must match exactly one oneOf branch/);
  });

  it('accepts signed numeric and string message handles', () => {
    const schemas = loadContractSchemas();
    const payload = structuredClone(
      loadProviderContract('napcat').cases.find((contractCase) => contractCase.covers.includes('events:message.group')).payload,
    );
    payload.message_id = -42;
    assert.deepEqual(validateJsonSchema(schemas.event, payload), { valid: true, errors: [] });
    payload.message_id = '-42';
    assert.deepEqual(validateJsonSchema(schemas.event, payload), { valid: true, errors: [] });
  });

  it('requires the reviewed parameters for each covered action fixture', () => {
    for (const provider of PROVIDERS) {
      const contract = structuredClone(loadProviderContract(provider));
      contract.cases.find((contractCase) => contractCase.schema === 'action-request').payload.params = {};
      const result = validateProviderContract(provider, contract, loadContractSchemas());
      assert.equal(result.valid, false, `${provider} must reject an empty covered action`);
      assert.match(result.errors.join('\n'), /must match exactly one oneOf branch/);
    }
  });

  it('rejects numerically rounded identifiers instead of treating them as exact', () => {
    const contract = structuredClone(loadProviderContract('napcat'));
    contract.cases[2].payload = {
      time: 1767225600,
      self_id: Number.MAX_SAFE_INTEGER + 1,
      post_type: 'notice',
      notice_type: 'group_increase',
      user_id: 20001,
      group_id: 30001,
    };
    contract.cases[2].schema = 'event';
    contract.cases[2].covers = ['events:notice.group_increase'];
    const result = validateProviderContract('napcat', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /must match at least one anyOf branch/);
  });

  it('rejects unsafe numeric event timestamps rejected by runtime normalization', () => {
    const schemas = loadContractSchemas();
    const payload = structuredClone(
      loadProviderContract('napcat').cases.find((contractCase) => contractCase.schema === 'event').payload,
    );
    payload.time = Number.MAX_SAFE_INTEGER + 1;
    const result = validateJsonSchema(schemas.event, payload);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /must be at most 9007199254740991/);
  });

  it('fails closed on unsupported, duplicate, or unevidenced capability drift', () => {
    const contract = structuredClone(loadProviderContract('snowluma'));
    contract.matrix.events.at(-1).reason = '';
    contract.matrix.actions[1].evidence = 'test/does-not-exist.test.ts';
    contract.matrix.events.push({ ...contract.matrix.events[0] });
    contract.cases[0].covers = ['events:request.friend'];
    const result = validateProviderContract('snowluma', contract, loadContractSchemas());
    const errors = result.errors.join('\n');
    assert.equal(result.valid, false);
    assert.match(errors, /unsupported capabilities require a reason|shorter than 1/);
    assert.match(errors, /evidence path does not resolve/);
    assert.match(errors, /duplicate capability/);
    assert.match(errors, /cannot cover unsupported capability/);
  });

  it('requires capability evidence to resolve to a regular file', () => {
    const contract = structuredClone(loadProviderContract('napcat'));
    contract.matrix.actions[0].evidence = 'src';
    const result = validateProviderContract('napcat', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /evidence path does not resolve to a repository file/);
  });

  it('binds event and message coverage to compatible event payloads', () => {
    const contract = structuredClone(loadProviderContract('napcat'));
    const messageCase = contract.cases.find((contractCase) => contractCase.covers.includes('events:message.group'));
    messageCase.schema = 'action-response';
    messageCase.payload = { status: 'ok', retcode: 0, data: null };
    const result = validateProviderContract('napcat', contract, loadContractSchemas());
    const errors = result.errors.join('\n');
    assert.equal(result.valid, false);
    assert.match(errors, /event capability events:message.group requires a matching event fixture/);
    assert.match(errors, /message capability messages:segment.text requires a message event fixture/);
  });

  it('verifies declared message coverage against the fixture segments', () => {
    const contract = structuredClone(loadProviderContract('napcat'));
    const messageCase = contract.cases.find((contractCase) => contractCase.covers.includes('messages:segment.text'));
    messageCase.payload.message[0].type = 'at';
    const result = validateProviderContract('napcat', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /does not contain a text segment/);
  });

  it('accepts string-form OneBot message ingress supported by runtime normalization', () => {
    const schemas = loadContractSchemas();
    const payload = structuredClone(
      loadProviderContract('napcat').cases.find((contractCase) => contractCase.covers.includes('events:message.group')).payload,
    );
    payload.message = '[CQ:at,qq=12345] hello';
    assert.deepEqual(validateJsonSchema(schemas.event, payload), { valid: true, errors: [] });
  });

  it('requires sender data in message event schema fixtures', () => {
    const contract = structuredClone(loadProviderContract('napcat'));
    const messageCase = contract.cases.find((contractCase) => contractCase.covers.includes('events:message.group'));
    delete messageCase.payload.sender;
    const result = validateProviderContract('napcat', contract, loadContractSchemas());
    const errors = result.errors.join('\n');
    assert.equal(result.valid, false);
    assert.match(errors, /message event fixture .* requires sender data/);
    assert.match(errors, /must match exactly one oneOf branch/);
  });

  it('requires group_id for group messages while allowing private messages without it', () => {
    const schemas = loadContractSchemas();
    const contract = structuredClone(loadProviderContract('napcat'));
    const groupMessage = contract.cases.find((contractCase) => contractCase.covers.includes('events:message.group'));
    delete groupMessage.payload.group_id;
    const result = validateProviderContract('napcat', contract, schemas);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /must match exactly one oneOf branch/);

    const privateMessage = structuredClone(loadProviderContract('snowluma').cases.at(-1).payload);
    privateMessage.message_type = 'private';
    delete privateMessage.group_id;
    assert.deepEqual(validateJsonSchema(schemas.event, privateMessage), { valid: true, errors: [] });
  });

  it('requires group_id for group request fixtures', () => {
    const contract = structuredClone(loadProviderContract('napcat'));
    const request = contract.cases.find((contractCase) => contractCase.covers.includes('events:request.group.add'));
    delete request.payload.group_id;
    const result = validateProviderContract('napcat', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /must match exactly one oneOf branch/);
  });

  it('requires both identifiers for group-increase capability coverage', () => {
    const contract = structuredClone(loadProviderContract('snowluma'));
    const notice = contract.cases.find((contractCase) => contractCase.covers.includes('events:notice.group_increase'));
    delete notice.payload.group_id;
    let result = validateProviderContract('snowluma', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /event payload does not match events:notice\.group_increase/);

    const second = structuredClone(loadProviderContract('snowluma'));
    const secondNotice = second.cases.find((contractCase) => contractCase.covers.includes('events:notice.group_increase'));
    delete secondNotice.payload.user_id;
    result = validateProviderContract('snowluma', second, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /event payload does not match events:notice\.group_increase/);
  });

  it('fails closed on unsupported tuple-valued items schemas', () => {
    assert.throws(
      () => validateJsonSchema({ type: 'array', items: [{ type: 'string' }] }, ['value']),
      /tuple schemas are not supported/,
    );
  });

  it('fails closed on malformed additionalProperties values', () => {
    assert.throws(
      () => validateJsonSchema({ type: 'object', additionalProperties: 'false' }, { unexpected: true }),
      /additionalProperties: must be a boolean or schema object/,
    );
  });

  it('rejects provider drift and unknown schema names', () => {
    const contract = structuredClone(loadProviderContract('napcat'));
    contract.provider = 'snowluma';
    contract.cases[0].schema = 'unreviewed-packet';
    const result = validateProviderContract('napcat', contract, loadContractSchemas());
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /expected napcat/);
    assert.match(result.errors.join('\n'), /unknown schema/);
  });
});
