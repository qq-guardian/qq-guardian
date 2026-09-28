import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseCompose = readFileSync(join(root, 'deploy', 'compose.yaml'), 'utf8');
const httpsCompose = readFileSync(join(root, 'deploy', 'compose.https.yaml'), 'utf8');
const caddyfile = readFileSync(join(root, 'deploy', 'Caddyfile'), 'utf8');
const environment = readFileSync(join(root, 'deploy', '.env.example'), 'utf8');
const runbook = readFileSync(join(root, 'deploy', 'HTTPS.md'), 'utf8');

describe('Guardian HTTPS deployment overlay', () => {
  it('keeps the raw Guardian HTTP mapping loopback-only', () => {
    assert.match(baseCompose, /"127\.0\.0\.1:\$\{GUARDIAN_HTTP_HOST_PORT:-6099\}:6099"/);
    assert.doesNotMatch(baseCompose, /"0\.0\.0\.0:\$\{GUARDIAN_HTTP_HOST_PORT/);
  });

  it('pins the Caddy image and exposes only the TLS terminator publicly', () => {
    assert.match(httpsCompose, /^  guardian-https:\r?\n/m);
    assert.match(httpsCompose, /^    image: caddy:2\.11\.4-alpine$/m);
    assert.match(httpsCompose, /GUARDIAN_DOMAIN: \$\{GUARDIAN_DOMAIN:\?Set GUARDIAN_DOMAIN/);
    assert.match(httpsCompose, /"\$\{GUARDIAN_HTTP_REDIRECT_HOST_PORT:-80\}:80"/);
    assert.match(httpsCompose, /"\$\{GUARDIAN_HTTPS_HOST_PORT:-443\}:443"/);
    assert.match(httpsCompose, /"\$\{GUARDIAN_HTTPS_HOST_PORT:-443\}:443\/udp"/);
    assert.match(httpsCompose, /no-new-privileges:true/);
  });

  it('terminates HTTPS at Caddy and proxies only to the private Guardian service', () => {
    assert.match(caddyfile, /^\{\$GUARDIAN_DOMAIN\} \{/m);
    assert.match(caddyfile, /^  reverse_proxy guardian:6099$/m);
    assert.doesNotMatch(caddyfile, /tls_insecure_skip_verify/);
  });

  it('documents TLS for public Guardian and external OneBot connections', () => {
    assert.match(environment, /# GUARDIAN_DOMAIN=guardian\.example\.com/);
    assert.match(environment, /untrusted network[\s\S]*wss:\/\//);
    assert.match(runbook, /Do not[\s\S]*raw Guardian mapping[\s\S]*0\.0\.0\.0/);
    assert.match(runbook, /SNOWLUMA_WS_URL=wss:\/\//);
  });
});
