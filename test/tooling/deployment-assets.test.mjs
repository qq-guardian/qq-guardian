import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compose = readFileSync(join(root, 'deploy', 'compose.yaml'), 'utf8');
const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');
const deployWorkflow = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
const systemdUnit = readFileSync(join(root, 'deploy', 'native', 'qq-guardian.service'), 'utf8');
const windowsStateInitializer = readFileSync(join(root, 'deploy', 'native', 'initialize-guardian-state.ps1'), 'utf8');
const recoveryWorkflow = readFileSync(join(root, '.github', 'workflows', 'recover-v1-4-7-deployment.yml'), 'utf8');

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

  it('keeps the SnowLuma Docker runtime contract aligned with the official image', () => {
    assert.match(compose, /^    shm_size: \$\{SNOWLUMA_SHM_SIZE:-1gb\}$/m);
    assert.match(compose, /^    ulimits:\r?\n      nofile:\r?\n        soft: 65536\r?\n        hard: 1048576$/m);
    assert.match(compose, /^    cap_add:\r?\n      - SYS_PTRACE$/m);
    assert.match(compose, /^      - seccomp=unconfined$/m);
    const snowlumaService = compose.match(/^  snowluma:[\s\S]*?^  guardian-storage-init:/m)?.[0] ?? '';
    assert.ok(snowlumaService, 'SnowLuma service block must exist');
    assert.doesNotMatch(snowlumaService, /^      - no-new-privileges:true$/m);
    assert.match(compose, /^      - no-new-privileges:true$/m);
    assert.match(compose, /^      VNC_PASSWD: \$\{VNC_PASSWD:-\}$/m);
    assert.match(compose, /^      SNOWLUMA_ONEBOT_HOST: 0\.0\.0\.0$/m);
    assert.match(compose, /^      SNOWLUMA_WEBUI_HOST: 0\.0\.0\.0$/m);
    assert.match(compose, /^      SNOWLUMA_WEBUI_PORT: 5099$/m);
    assert.match(compose, /^      SNOWLUMA_EXTRA_QQ_HOMES: "\$\{SNOWLUMA_EXTRA_QQ_HOMES:-\}"$/m);
    assert.match(compose, /^      SNOWLUMA_QQ_FLAGS: "\$\{SNOWLUMA_QQ_FLAGS:---disable-gpu --disable-software-rasterizer --disable-gpu-compositing\}"$/m);
  });

  it('keeps Guardian and its HTTPS overlay behind the same Compose profile', () => {
    assert.match(compose, /^  guardian-storage-init:\r?\n    profiles:\r?\n      - guardian$/m);
    assert.match(compose, /^  guardian:\r?\n    profiles:\r?\n      - guardian$/m);
    const httpsOverlay = readFileSync(join(root, 'deploy', 'compose.https.yaml'), 'utf8');
    assert.match(httpsOverlay, /^  guardian-https:\r?\n    profiles:\r?\n      - guardian$/m);
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

  it('does not use a SIGPIPE-prone tar/head pipeline and contains the one-time v1.4.7 recovery workflow', () => {
    assert.match(deployWorkflow, /tar -tzf "release-input\/\$asset" \| sed -n '1p' \| cut -d\/ -f1/);
    assert.doesNotMatch(deployWorkflow, /tar -tzf[^\n]*\| head -n 1/);
    assert.match(recoveryWorkflow, /tag: v1\.4\.7/);
    assert.match(recoveryWorkflow, /source_sha: 0ef94cedaf5a1aa76afd31e0e0a002fd3b3da75f/);
  });

  it('builds the release image from an explicit minimal context that includes dist-snowluma', () => {
    assert.equal(deployWorkflow.includes('Prepare minimal Guardian image build context'), true);
    assert.equal(deployWorkflow.includes('test -f "$BUNDLE_PATH/dist-snowluma/index.mjs"'), true);
    assert.equal(deployWorkflow.includes('cp -a "$BUNDLE_PATH/dist-snowluma" "$context_dir/dist-snowluma"'), true);
    assert.equal(deployWorkflow.includes('context: ${{ steps.image-context.outputs.path }}'), true);
    assert.equal(deployWorkflow.includes('file: ${{ steps.image-context.outputs.path }}/Dockerfile'), true);
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
