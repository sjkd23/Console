FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY src/db/migrations ./src/db/migrations

USER node
EXPOSE 4000

CMD [ "sh", "-c", "node dist/scripts/migrate.js && exec node dist/server.js" ]
