import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoolean, parseBooleanOr } from '../../src/core/config/boolean.ts';

describe('strict boolean parsing', () => {
  it('accepts native and canonical serialized booleans', () => {
    assert.equal(parseBoolean(true), true);
    assert.equal(parseBoolean(false), false);
    assert.equal(parseBoolean('true'), true);
    assert.equal(parseBoolean('false'), false);
    assert.equal(parseBoolean('1'), true);
    assert.equal(parseBoolean('0'), false);
    assert.equal(parseBoolean(1), true);
    assert.equal(parseBoolean(0), false);
  });

  it('does not treat arbitrary non-empty strings as true', () => {
    assert.equal(parseBoolean('yes'), undefined);
    assert.equal(parseBoolean('FALSE'), undefined);
    assert.equal(parseBoolean({}), undefined);
  });

  it('preserves a fallback for absent or invalid values', () => {
    assert.equal(parseBooleanOr(undefined, true), true);
    assert.equal(parseBooleanOr('invalid', false), false);
    assert.equal(parseBooleanOr('false', true), false);
  });
});
