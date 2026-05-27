FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# data/ is a bind mount from host (tokens.json is mounted in there)
ENV TOKENS_PATH=/app/data/tokens.json
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]
