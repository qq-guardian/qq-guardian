# BT Panel (Baota) deployment

BT Panel's Docker/Compose application view can run the standard
[`../../docker-compose.yml`](../../docker-compose.yml) unchanged when the repository layout is
retained. Clone or upload the repository, then select `deploy/compose.yaml` as
the Compose file so its `..` build context still points at the bundle root.

1. Copy `deploy/.env.example` to the panel application's `.env` file.
   `VNC_PASSWD` may stay empty so SnowLuma generates a random first-start password.
2. Start SnowLuma first without the `guardian` profile. Use
   `http://127.0.0.1:6081/` through the server's local browser, SSH tunnel, or
   a protected panel proxy to complete QQ login.
3. Configure SnowLuma's Universal `wsServers` token, put the exact token in
   the panel environment, then start the `guardian` profile. Recreate only
   Guardian when the token changes.
4. Keep the five named volumes listed in the Compose file. An application
   deletion workflow that also deletes volumes is a data deletion workflow;
   do not use it for upgrades. Keep `guardian-storage-init` enabled inside
   the `guardian` profile; it safely fixes ownership of the two Guardian
   volumes before the non-root runtime starts.

If the panel moves the Compose file to another directory, change only
`guardian.build.context` to the checked-out bundle root, or build the
Guardian image from that checkout first and use the existing tagged image.
Never change `SNOWLUMA_WS_URL` to `localhost` for this sidecar stack:
`localhost` inside Guardian is the Guardian container, not SnowLuma.

Follow the backup and rollback procedure in [the SnowLuma deployment guide](../../docs/deployment/snowluma.md).
