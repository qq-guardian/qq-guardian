import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compose = readFileSync(join(root, 'deploy', 'compose.yaml'), 'utf8');
const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');
const systemdUnit = readFileSync(join(root, 'deploy', 'native', 'qq-guardian.service'), 'utf8');
const windowsStateInitializer = readFileSync(join(root, 'deploy', 'native', 'initialize-guardian-state.ps1'), 'utf8');

describe('deployment assets', () => {
  it('initializes named-volume ownership before the non-root Guardian service starts', () => {
    assert.match(compose, /guardian-storage-init:[\s\S]*?user: "0:0"[\s\S]*?network_mode: none[\s\S]*?chown -R 1000:1000 \/guardian\/data \/guardian\/config/);
    assert.match(compose, /^  guardian:\r?\n[\s\S]*?^      guardian-storage-init:\r?\n\s*condition: service_completed_successfully/m);
  });

  it('does not send local deployment environment files in the Docker build context', () => {
    assert.match(dockerignore, /^\.env$/m);
    assert.match(dockerignore, /^\.env\.\*$/m);
    assert.match(dockerignore, /^deploy\/\.env$/m);
    assert.match(dockerignore, /^deploy\/\.env\.\*$/m);
    assert.match(dockerignore, /^!deploy\/\.env\.example$/m);
    assert.match(dockerignore, /^deploy\/compose\.local\.yaml$/m);
  });

  it('passes the documented SDK fallback mode into the Guardian container', () => {
    assert.match(compose, /^      SNOWLUMA_SDK_FALLBACK: \$\{SNOWLUMA_SDK_FALLBACK:-auto\}$/m);
  });

  it('passes bounded SnowLuma ingress defaults into the Guardian container', () => {
    assert.match(compose, /^      SNOWLUMA_MAX_FRAME_BYTES: \$\{SNOWLUMA_MAX_FRAME_BYTES:-1048576\}$/m);
    assert.match(compose, /^      SNOWLUMA_RAW_QUEUE_LIMIT: \$\{SNOWLUMA_RAW_QUEUE_LIMIT:-64\}$/m);
    assert.match(compose, /^      SNOWLUMA_RAW_QUEUE_BYTES: \$\{SNOWLUMA_RAW_QUEUE_BYTES:-8388608\}$/m);
  });

  it('keeps break-glass administrator recovery disabled by default', () => {
    assert.match(compose, /^      QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY: \$\{QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY:-0\}$/m);
  });

  it('starts the standalone entry point that is actually packaged in the Linux release', () => {
    assert.match(systemdUnit, /^WorkingDirectory=\/opt\/qq-guardian\/dist-snowluma$/m);
    assert.match(systemdUnit, /^ExecStart=\/usr\/bin\/env node \/opt\/qq-guardian\/dist-snowluma\/index\.mjs$/m);
  });

  it('ships an explicit Windows ACL initializer for all persistent Guardian state', () => {
    assert.match(windowsStateInitializer, /\/inheritance:r/);
    assert.match(windowsStateInitializer, /S-1-5-18/);
    assert.match(windowsStateInitializer, /S-1-5-32-544/);
    assert.match(windowsStateInitializer, /Join-Path \$rootPath 'data'/);
    assert.match(windowsStateInitializer, /Join-Path \$rootPath 'config'/);
  });

  it('uses one POSIX launcher for native and Termux/proot deployments', () => {
    const sharedLauncher = join(root, 'deploy', 'native', 'start-guardian.sh');
    assert.equal(existsSync(sharedLauncher), true);
    assert.equal(existsSync(join(root, 'deploy', 'termux', 'start-guardian.sh')), false);
    assert.match(readFileSync(sharedLauncher, 'utf8'), /same proot Linux userland/);
  });
});
