# Public HTTPS for Guardian

Guardian's base Compose deployment is intentionally private: the WebUI/API is
published only on host loopback and OneBot stays on the Compose network. Do not
change the raw Guardian mapping to `0.0.0.0` for Internet access. JWT bearer
tokens must not cross an untrusted network over plaintext HTTP.

For a public WebUI/API, use the optional Caddy overlay. Caddy terminates TLS on
public ports 80/443 and proxies to `guardian:6099` on the private Compose
network; the raw Guardian host mapping remains loopback-only.

## Requirements

1. Create an A/AAAA DNS record for a hostname you control, for example
   `guardian.example.com`, pointing to this host.
2. Permit inbound TCP 80 and TCP/UDP 443 to the host. Caddy needs public 80/443
   for normal automatic certificate issuance/renewal and serves HTTP/3 on UDP
   443 when available.
3. Set `GUARDIAN_DOMAIN` in the untracked `deploy/.env` file. Never put API
   tokens or administrator credentials in the Caddyfile.

## Start with automatic HTTPS

```sh
cp deploy/.env.example deploy/.env
# Edit deploy/.env and set at minimum VNC_PASSWD, the OneBot token when ready,
# and GUARDIAN_DOMAIN=guardian.example.com.

docker compose --env-file deploy/.env \
  -f deploy/compose.yaml \
  -f deploy/compose.https.yaml config

docker compose --env-file deploy/.env \
  -f deploy/compose.yaml \
  -f deploy/compose.https.yaml up -d --build
```

Open `https://<GUARDIAN_DOMAIN>/plugin/napcat-plugin-qq-guardian/page/guardian`.
HTTP requests on port 80 are handled by Caddy's automatic HTTPS redirect.
Certificate state is stored in the named `guardian-caddy-data` volume so normal
container replacement does not discard ACME state.

The overlay deliberately does **not** publish noVNC or SnowLuma's own WebUI.
Keep those loopback-only and use SSH/VPN/tunnel access when remote administration
is required.

## OneBot transport encryption

The bundled default `ws://snowluma:3001/` is service-to-service traffic on the
private Compose network and is not host-published. The Caddy WebUI overlay does
not turn that private OneBot socket into a public endpoint.

If Guardian connects to a separately deployed SnowLuma/compatible OneBot server
across an untrusted network, configure TLS on that remote endpoint and use an
explicit `SNOWLUMA_WS_URL=wss://...`. Likewise, do not expose Guardian's HTTP
webhook or reverse-WebSocket listener publicly without a trusted TLS-terminating
proxy/tunnel and `SNOWLUMA_ACCESS_TOKEN`.

## Panel deployments

BT Panel/1Panel users should either import both Compose files above or use the
panel's existing HTTPS reverse-proxy feature to proxy the loopback/private
Guardian service. In either case, the security invariant is the same: public
clients terminate HTTPS at the trusted proxy; Guardian itself is not directly
published on an unauthenticated plaintext public socket.
