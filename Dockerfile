FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node . .

RUN mkdir -p /app/accounts && chown -R node:node /app

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 9655) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]