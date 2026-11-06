FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY index.mjs ./

USER node

CMD ["node", "index.mjs"]
