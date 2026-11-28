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
# The whole fixtures folder (24 KB), so the image also runs the seed without a volume (the ECS migrate task).
COPY --from=build /repo/fixtures fixtures
ENV EXPECTED_FIELDS_PATH=/app/fixtures/expected-fields.json FIXTURES_DIR=/app/fixtures
USER node
CMD ["node", "dist/main.js"]
