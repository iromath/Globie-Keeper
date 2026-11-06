# API image. Build context is the repo root so db/migrations can be baked in:
#   docker build -f server/Dockerfile -t tradex367/globie-keeper-api .
FROM node:22-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev=false

FROM deps AS build
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Baked in so `node dist/db/migrate-cli.js` works on a host without the repo.
COPY db/migrations ./db/migrations
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3001/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
