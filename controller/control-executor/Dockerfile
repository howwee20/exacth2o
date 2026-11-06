FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY test ./test

ENV NODE_ENV=production

CMD ["node", "src/control-executor.mjs"]
