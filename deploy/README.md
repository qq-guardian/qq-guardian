# Deployment assets

The canonical Docker and production deployment entry points are now at the
repository root:

- `docker-compose.yml`
- `Dockerfile`
- `entrypoint.sh`
- `healthcheck.sh`
- `install.sh`
- `update.sh`
- `uninstall.sh`
- `verify.sh`

This directory contains provider-specific integration assets and configuration
examples only. Do not create a second Compose or Dockerfile implementation
here; keeping one canonical deployment definition prevents release drift.
