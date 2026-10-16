# One-shot-ish bring-up job for the Railway stack: mines the regtest chain to
# the funder's miner address, shields the mature coinbase into the funder
# wallet, then idles as a liveness probe. No volumes needed (pure HTTP RPC).
FROM node:22-alpine
WORKDIR /app
COPY docker/railway/bootstrap.mjs .
CMD ["node", "bootstrap.mjs"]
