# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 构建保留的认证、存储和 Sub2API 服务端接口。
FROM golang:1.25-alpine AS api-build

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN CGO_ENABLED=0 go build -o /server .

# Nginx 提供静态前端并将同源 API 请求反代到容器内 Go 服务。
FROM nginx:1.27-alpine

WORKDIR /app
COPY --from=api-build /server /app/server
COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN mkdir -p /app/data/prompts /app/data/logs/ai-calls && chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 3000
CMD ["sh", "-c", "PORT=18080 /app/server & exec nginx -g 'daemon off;'"]
