# Zebra regtest for the Railway stack. The miner address inside the config is
# the deterministic transparent address (index 0) of the public all-zero BIP-39
# test vector used by the funder wallet, so mining rewards are shieldable by
# the funder service. See docs/RAILWAY.md.
FROM zfnd/zebra:6.3.0
ENV ZEBRA_STATE__CACHE_DIR=/var/cache/zebra
COPY regtest/zebrad.railway.toml /etc/zebra/zebrad.toml
CMD ["zebrad", "-c", "/etc/zebra/zebrad.toml", "start"]
