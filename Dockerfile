# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
ENV NODE_ENV=production     QQ_GUARDIAN_HTTP_HOST=0.0.0.0     QQ_GUARDIAN_HTTP_PORT=6099     QQ_GUARDIAN_DATA_DIR=/data     QQ_GUARDIAN_CONFIG_DIR=/config     SNOWLUMA_WS_URL=ws://snowluma:3001/     SNOWLUMA_TRANSPORT=forward-websocket
WORKDIR /app
COPY dist-snowluma/ /app/
COPY entrypoint.sh /usr/local/bin/qq-guardian-entrypoint
COPY healthcheck.sh /usr/local/bin/qq-guardian-healthcheck
RUN chmod +x /usr/local/bin/qq-guardian-entrypoint /usr/local/bin/qq-guardian-healthcheck     && mkdir -p /data /config /logs     && chown -R node:node /app /data /config /logs
USER node
EXPOSE 6099
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD /usr/local/bin/qq-guardian-healthcheck
ENTRYPOINT ["/usr/local/bin/qq-guardian-entrypoint"]
