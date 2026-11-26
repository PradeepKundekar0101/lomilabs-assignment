# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:26-alpine AS build
RUN npm install -g pnpm@12.23.0
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.cache/pnpm --mount=type=cache,target=/root/.local/share/pnpm \
    pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@lomi/web

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
