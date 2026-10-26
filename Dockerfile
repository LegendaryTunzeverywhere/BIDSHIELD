# Railway/root build: same image as docker/api.Dockerfile (context = repo root).
# Builds the SPA, then the Rust API binary, then ships a slim runtime.
# No BuildKit cache mounts (Railway's validator requires hard-coded service-id
# prefixes that are currently broken) and no VOLUME directive (attach a
# Railway Volume at /data from the dashboard instead).

FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ .
RUN npm run build

FROM rust:1-alpine AS api
RUN apk add --no-cache musl-dev gcc
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --bin api && cp target/release/api /usr/local/bin/bidshield-api

FROM alpine:3.22
# Runs as root so a Railway volume mounted at /data stays writable — Railway
# mounts volumes owned by root, and a non-root USER cannot create the SQLite
# database there ("unable to open database file"). Same reasoning as
# docker/railway/zecd.Dockerfile, which also runs as root for its volume.
RUN mkdir -p /data
COPY --from=api /usr/local/bin/bidshield-api /usr/local/bin/bidshield-api
COPY --from=web /src/web/dist /app/web/dist
ENV BIND=0.0.0.0:8080 \
    DB_PATH=/data/bidshield.db \
    WEB_DIST=/app/web/dist \
    RUST_LOG=info
EXPOSE 8080
CMD ["bidshield-api"]
