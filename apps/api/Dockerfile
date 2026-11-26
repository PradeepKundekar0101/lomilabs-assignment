# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:26-alpine AS build
RUN npm install -g pnpm@12.23.0
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.cache/pnpm --mount=type=cache,target=/root/.local/share/pnpm \
    pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@lomi/api
RUN pnpm deploy --filter=@lomi/api --prod /out

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["node", "dist/main.js"]
