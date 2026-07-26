FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY config ./config
COPY test ./test

ENV NODE_ENV=production

CMD ["node", "src/publisher.mjs"]
