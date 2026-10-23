FROM node:26-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY relay.js ./
ENV NODE_ENV=production RELAY_PORT=8081 RELAY_CONFIG=/data/relay-config.json
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8081/health || exit 1
CMD ["node", "relay.js"]
