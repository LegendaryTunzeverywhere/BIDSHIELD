# zecd for the Railway stack. The release binary is fetched and SHA256-verified
# at build time because binaries are deliberately not committed to the repo
# (same release + checksums as e2e/spike.mjs stages locally). The role (funder
# | auctioneer) is chosen at runtime via ZECD_ROLE, which also picks the config
# file. Runs as root so Railway volumes mounted at /var/lib/zecd stay writable.
FROM alpine:3.22 AS fetch
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

FROM alpine:3.22
# Same regtest NU6.3 height the compose stack sets: without it zecd's baked
# schedule has no NU6.3 on regtest and it cannot parse the block at height 8.
ENV ZECD_REGTEST_NU63_HEIGHT=8
RUN mkdir -p /var/lib/zecd /etc/zecd
COPY --from=fetch /tmp/zecd-bin /usr/local/bin/zecd
COPY regtest/zecd.funder.toml /etc/zecd/zecd.funder.toml
COPY regtest/zecd.auctioneer.toml /etc/zecd/zecd.auctioneer.toml
COPY docker/railway/zecd-entrypoint.sh /usr/local/bin/zecd-entrypoint.sh
RUN chmod +x /usr/local/bin/zecd-entrypoint.sh
WORKDIR /var/lib/zecd
EXPOSE 18232 18242 9233 9243
ENTRYPOINT ["zecd-entrypoint.sh"]
