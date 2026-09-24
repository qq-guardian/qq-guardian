# syntax=docker/dockerfile:1
# Build from the generated dist-snowluma/ directory. The build context contains
# no source tree, package manager, or development dependency: index.mjs is
# already self-contained, including the bundled SnowLuma SDK fallback.
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    QQ_GUARDIAN_DATA_DIR=/guardian/data \
    QQ_GUARDIAN_CONFIG_DIR=/guardian/config \
    QQ_GUARDIAN_HTTP_HOST=0.0.0.0 \
    QQ_GUARDIAN_HTTP_PORT=6099

WORKDIR /app

COPY --chown=node:node dist-snowluma/ /app/
RUN mkdir -p /guardian/data /guardian/config \
  && chown -R node:node /guardian

USER node

EXPOSE 6099

# The page route is deliberately unauthenticated; querying it confirms the
# HTTP host is accepting requests without placing a Guardian credential in the
# image or a Docker health-check command.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:6099/plugin/napcat-plugin-qq-guardian/page/guardian').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "index.mjs"]
