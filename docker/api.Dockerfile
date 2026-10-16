FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ .
RUN npm run build

FROM rust:1-alpine AS api
RUN apk add --no-cache musl-dev gcc
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --bin api && cp target/release/api /usr/local/bin/bidshield-api

FROM alpine:3.22
RUN adduser -D -u 10001 app && mkdir -p /data && chown app /data
COPY --from=api /usr/local/bin/bidshield-api /usr/local/bin/bidshield-api
COPY --from=web /src/web/dist /app/web/dist
USER app
ENV BIND=0.0.0.0:8080 \
    DB_PATH=/data/bidshield.db \
    WEB_DIST=/app/web/dist \
    RUST_LOG=info
EXPOSE 8080
VOLUME /data
CMD ["bidshield-api"]
