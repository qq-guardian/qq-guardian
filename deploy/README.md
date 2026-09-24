# QQ Guardian deployment assets

This directory contains the operational inputs shipped with the preferred
SnowLuma standalone deployment. The NapCat target is installed by NapCat from
its provider archive; the standalone target is an ordinary Node process or a
Docker sidecar. The Compose Dockerfile consumes the generated sibling
`dist-snowluma/` runtime, while the full `releaseDownload.zip` also carries this
directory, source, tests, CI workflows, and verification scripts.

| Path | Use |
| --- | --- |
| `compose.yaml` / `Dockerfile` | SnowLuma + Guardian sidecar with five persistent volumes and a root-only volume-ownership initializer. |
| `compose.https.yaml` / `Caddyfile` / `HTTPS.md` | Optional Caddy automatic-HTTPS ingress; public 80/443 terminate TLS while Guardian remains on the private Compose service network. |
| `native/` | Native Windows/Linux launch and service templates. `start-guardian.sh` is the shared POSIX launcher for Linux and Termux/proot; there is no separate `termux/` directory. |
| `baota/` | BT Panel (Baota) Compose import notes. |
| `1panel/` | 1Panel Compose import notes. |
| `.env.example` | Safe, non-secret variable template; copy it to an untracked `deploy/.env`. |

Start with the central [deployment runbook](../DEPLOYMENT.md), then read the
[SnowLuma deployment guide](../docs/deployment/snowluma.md). For public Guardian
WebUI/API access, follow [the HTTPS overlay runbook](HTTPS.md) instead of
publishing Guardian's raw HTTP port. These documents define the OneBot
endpoint/token contract, transport choices, backup/rollback procedure, and
environment-specific constraints.
