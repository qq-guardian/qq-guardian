# 1Panel deployment

Create a **Compose** application from a checkout or uploaded copy of this
repository and select `deploy/compose.yaml`. Retaining the repository
layout is important: the Guardian Docker build uses `dist-snowluma/` as its
context. Run `pnpm run build` first when deploying from source; the runtime
image does not consume a development `node_modules` directory.

1. Populate the application's environment from `deploy/.env.example`.
   `VNC_PASSWD` may stay empty and the five explicit volume names must be
   preserved.
2. Start the SnowLuma service first without the `guardian` profile, then use
   local/noVNC access to sign into QQ and configure a Universal OneBot WebSocket.
3. Copy the configured OneBot access token to `SNOWLUMA_ACCESS_TOKEN`, then
   start the `guardian` profile. Recreate **Guardian only** when the token
   changes. The connection endpoint remains `ws://snowluma:3001/` when both
   services share this Compose application.
4. Add a trusted reverse proxy only for the Guardian HTTP port if remote WebUI
   access is needed. Keep SnowLuma OneBot, noVNC, and its WebUI unexposed.
   Do not remove `guardian-storage-init`; it is the one-shot volume ownership
   step required before Guardian's non-root process can use persistent data.

Do not use the panel's volume-deletion option while upgrading or restarting the
application. Guardian's migration backups, `config.json`, and `qqadmin.db`
live in the dedicated Guardian volumes. See
[the SnowLuma deployment guide](../../docs/deployment/snowluma.md) for validation and rollback.
