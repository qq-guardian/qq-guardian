import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchRemote, isPrivateNetworkAddress, readResponseBytes, validateRemoteUrl } from '../../src/runtime/safe-fetch.ts';

test('recognizes private IPv4 and IPv6 address ranges', () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '172.16.0.1', '192.168.1.1', '198.18.0.1', '169.254.169.254',
    '::1', 'fc00::1', 'fe80::1', 'fe90::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
  ]) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  assert.equal(isPrivateNetworkAddress('8.8.8.8'), false);
});

test('rejects non-HTTPS, credentials, disallowed hosts, and private DNS answers', async () => {
  await assert.rejects(validateRemoteUrl('http://example.com', {}, async () => ['93.184.216.34']));
  await assert.rejects(validateRemoteUrl('https://user:pass@example.com', {}, async () => ['93.184.216.34']));
  await assert.rejects(validateRemoteUrl('https://example.com', { allowedHosts: new Set(['github.com']) }, async () => ['93.184.216.34']));
  await assert.rejects(validateRemoteUrl('https://example.com', {}, async () => ['127.0.0.1']));
});

test('accepts a public HTTPS host with a public DNS result', async () => {
  const url = await validateRemoteUrl('https://example.com/feed.json', {}, async () => ['93.184.216.34']);
  assert.equal(url.hostname, 'example.com');
});

test('re-resolves at connection time and refuses a private DNS rebind', async () => {
  let resolutions = 0;
  await assert.rejects(
    fetchRemote('http://safe.example/rebind', {}, { allowHttp: true }, async () => {
      resolutions += 1;
      return resolutions === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
    }),
    /private network address/
  );
  assert.equal(resolutions, 2);
});

test('streams a pinned native HTTP response and validates its redirect hop', async () => {
  let userAgent = '';
  const server = createServer((req, res) => {
    userAgent = String(req.headers['user-agent'] ?? '');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    res.end('safe response');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetchRemote(
      `http://127.0.0.1:${address.port}/redirect`,
      {},
      { allowHttp: true, allowPrivateNetwork: true },
    );
    assert.equal(await readResponseBytes(response, 1024).then((bytes) => bytes.toString('utf8')), 'safe response');
    assert.equal(userAgent, 'qq-guardian');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('does not forward provider credentials across an origin-changing redirect', async () => {
  let receivedAuthorization = '';
  const destination = createServer((req, res) => {
    receivedAuthorization = String(req.headers.authorization ?? '');
    res.end('redirect destination');
  });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const destinationAddress = destination.address();
  assert.ok(destinationAddress && typeof destinationAddress !== 'string');

  const source = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destinationAddress.port}/final` });
    res.end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceAddress = source.address();
  assert.ok(sourceAddress && typeof sourceAddress !== 'string');

  try {
    const response = await fetchRemote(
      `http://127.0.0.1:${sourceAddress.port}/start`,
      { headers: { Authorization: 'Bearer provider-secret' } },
      { allowHttp: true, allowPrivateNetwork: true },
    );
    await readResponseBytes(response, 1024);
    assert.equal(receivedAuthorization, '');
  } finally {
    source.close();
    destination.close();
    await Promise.all([once(source, 'close'), once(destination, 'close')]);
  }
});
