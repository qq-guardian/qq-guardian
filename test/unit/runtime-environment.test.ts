import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultHttpHost,
  detectRuntimeEnvironment,
  readBoundedInteger,
  readPort,
} from '../../src/runtime/environment.ts';

test('detects native Windows without Linux/container assumptions', () => {
  const environment = detectRuntimeEnvironment({ platform: 'win32', env: {} });
  assert.deepEqual(environment, {
    operatingSystem: 'windows',
    deployment: 'native',
    isContainer: false,
    isWsl: false,
    isTermux: false,
  });
  assert.equal(defaultHttpHost(environment), '127.0.0.1');
});

test('treats an explicitly supplied probe as a self-contained snapshot', () => {
  const environment = detectRuntimeEnvironment({ platform: 'linux', env: {} });
  assert.deepEqual(environment, {
    operatingSystem: 'linux',
    deployment: 'native',
    isContainer: false,
    isWsl: false,
    isTermux: false,
  });
});

test('detects WSL2 by its runtime marker', () => {
  const environment = detectRuntimeEnvironment({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' },
  });
  assert.equal(environment.deployment, 'wsl2');
  assert.equal(environment.isWsl, true);
  assert.equal(environment.isContainer, false);
});

test('detects Docker and chooses an exposed listener only inside the container', () => {
  const environment = detectRuntimeEnvironment({
    platform: 'linux',
    env: { CONTAINER: 'docker' },
  });
  assert.equal(environment.deployment, 'docker');
  assert.equal(defaultHttpHost(environment), '0.0.0.0');
});

test('detects Termux on Android-compatible Linux environments', () => {
  const environment = detectRuntimeEnvironment({
    platform: 'linux',
    env: { TERMUX_VERSION: '0.118' },
  });
  assert.equal(environment.deployment, 'termux');
  assert.equal(environment.operatingSystem, 'android');
});

test('accepts only valid TCP port values', () => {
  assert.equal(readPort('6099', 1), 6099);
  assert.equal(readPort('0', 6099), 6099);
  assert.equal(readPort('65536', 6099), 6099);
  assert.equal(readPort('NaN', 6099), 6099);
});

test('accepts only safe integers inside an explicit resource-limit range', () => {
  assert.equal(readBoundedInteger('64', 8, 1, 1_000), 64);
  assert.equal(readBoundedInteger('0', 8, 1, 1_000), 8);
  assert.equal(readBoundedInteger('1001', 8, 1, 1_000), 8);
  assert.equal(readBoundedInteger('1.5', 8, 1, 1_000), 8);
  assert.equal(readBoundedInteger('9007199254740992', 8, 1, Number.MAX_SAFE_INTEGER), 8);
});
