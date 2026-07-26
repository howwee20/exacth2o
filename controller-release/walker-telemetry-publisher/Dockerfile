FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /var/lib/walker-telemetry && chown node:node /var/lib/walker-telemetry

USER node
VOLUME ["/var/lib/walker-telemetry"]
CMD ["node", "src/index.mjs"]
