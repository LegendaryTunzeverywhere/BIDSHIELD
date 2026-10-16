# zecd static musl binary (released linux-amd64 artifact).
# Default ZECD_BIN=zecd is 0.8.2 (regtest/mainnet full mode), fetched+SHA256-verified
# by e2e/spike.mjs. The testnet profile builds with ZECD_BIN=zecd-0.9.0-rc1 (NU7-era,
# light-mode capable) — staged manually with the release SHA256SUMS.
FROM alpine:3.22
RUN addgroup -g 10001 zecd \
 && adduser -D -u 10001 -G zecd zecd \
 && mkdir -p /var/lib/zecd \
 && chown zecd:zecd /var/lib/zecd
ARG ZECD_BIN=zecd
COPY ${ZECD_BIN} /usr/local/bin/zecd
RUN chmod +x /usr/local/bin/zecd
USER zecd
WORKDIR /var/lib/zecd
EXPOSE 18232 9233
ENTRYPOINT ["zecd"]
CMD ["--datadir", "/var/lib/zecd", "--conf=/etc/zecd/zecd.toml"]
