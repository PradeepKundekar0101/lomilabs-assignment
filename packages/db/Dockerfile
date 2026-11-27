# Build from the repo root: docker build -f packages/db/Dockerfile .
FROM node:26-alpine AS build
RUN npm install -g pnpm@12.23.0
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.cache/pnpm --mount=type=cache,target=/root/.local/share/pnpm \
    pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@lomi/db
RUN pnpm deploy --filter=@lomi/db --prod /out

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]
