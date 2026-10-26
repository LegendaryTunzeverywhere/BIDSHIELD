# Single-service Railway image: zebra + funder + auctioneer + bootstrap + api,
# supervised by a small Node gateway that starts them on demand and stops them
# after IDLE_STOP_SECS of inactivity. One /data volume holds all state.
#
# Build from the repo root:
#   railway up --service bidshield
#   (or docker build -f docker/railway/allinone.Dockerfile .)

# ---- SPA ---------------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- Rust API ----------------------------------------------------------
FROM rust:1-alpine AS api
RUN apk add --no-cache musl-dev gcc
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --bin api && cp target/release/api /usr/local/bin/bidshield-api

# ---- zecd release binary (SHA256-verified) ------------------------------
FROM alpine:3.22 AS zecd
ARG ZECD_VERSION=0.8.2
RUN apk add --no-cache curl tar
WORKDIR /tmp
COPY docker/zecd/SHA256SUMS ./
RUN curl -fsSL -o "zecd-${ZECD_VERSION}-linux-amd64.tar.gz" \
      "https://github.com/zecrocks/zecd/releases/download/v${ZECD_VERSION}/zecd-${ZECD_VERSION}-linux-amd64.tar.gz" \
 && grep "  zecd-${ZECD_VERSION}-linux-amd64.tar.gz$" SHA256SUMS > check.sha \
 && sha256sum -c check.sha \
 && mkdir -p extract \
 && tar -xzf "zecd-${ZECD_VERSION}-linux-amd64.tar.gz" -C extract \
 && find extract -type f -name zecd -exec cp {} /tmp/zecd-bin \; \
 && chmod +x /tmp/zecd-bin

# ---- Runtime -----------------------------------------------------------
# zebra's Debian image already has the zebra user (UID 10001) and the
# consensus node. We add Node (for the gateway + bootstrap), curl (wallet
# readiness), tini (child reaping), and setpriv (drop privileges for each
# process).
FROM zfnd/zebra:6.3.0

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tini util-linux libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=web /src/web/dist /app/web/dist
COPY --from=api /usr/local/bin/bidshield-api /usr/local/bin/bidshield-api
COPY --from=zecd /tmp/zecd-bin /usr/local/bin/zecd

COPY docker/railway/gateway.mjs /app/gateway.mjs
COPY docker/railway/bootstrap.mjs /app/bootstrap.mjs
COPY docker/railway/zecd-entrypoint.sh /usr/local/bin/zecd-entrypoint.sh
COPY docker/railway/allinone.zebrad.toml /etc/zebra/zebrad.toml
COPY docker/railway/allinone.funder.toml /etc/zecd/allinone.funder.toml
COPY docker/railway/allinone.auctioneer.toml /etc/zecd/allinone.auctioneer.toml

RUN chmod +x /usr/local/bin/zecd-entrypoint.sh \
 && mkdir -p /data /app/web/dist

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    API_PORT=8081 \
    ZECD_REGTEST_NU63_HEIGHT=8 \
    RUST_LOG=info,tower_http=warn

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/gateway.mjs"]
