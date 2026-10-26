# Cheap, portable Railway deployment (single service)

The original Railway topology runs five services (`zebra`, `funder`,
`auctioneer`, `bootstrap`, `BIDSHIELD`) permanently. The chain and two shielded
wallets alone hold roughly 1.5 GB resident even when nobody is bidding, and the
demo pays for that every minute.

This deployment keeps the same components but runs them **inside one Railway
service** under a small gateway:

```
internet :8080
   └── gateway.mjs
        ├── api       127.0.0.1:8081   (Rust, serves /api + the SPA)
        ├── zebra     127.0.0.1:18234  (regtest consensus)
        ├── funder    127.0.0.1:18242  (hosted-wallet reserve)
        ├── auctioneer 127.0.0.1:18232 (escrow wallet)
        └── bootstrap                  (mine + shield + refill)
```

The gateway starts the stack on the first request and stops it after
`IDLE_STOP_SECS` (default 15 minutes) with no requests. Only the gateway
(~50–80 MB Node process) stays resident while idle. A demo session pays for the
chain while it is being used plus the idle tail, not 24/7.

The frontend stays on Vercel and keeps using its `/api/*` rewrite to this
service, so the browser still sees first-party cookies and no CORS preflight.

## What is in the image

| Path | Purpose |
| --- | --- |
| `docker/railway/allinone.Dockerfile` | One image: SPA build, Rust API, static zecd, zebra base, Node gateway |
| `docker/railway/gateway.mjs` | On-demand supervisor + HTTP gateway + boot page |
| `docker/railway/allinone.zebrad.toml` | Zebra regtest config, cache in `/data/zebra`, loopback RPC |
| `docker/railway/allinone.funder.toml` | Funder zecd config, datadir `/data/funder` |
| `docker/railway/allinone.auctioneer.toml` | Auctioneer zecd config, datadir `/data/auctioneer` |
| `docker/railway/zecd-entrypoint.sh` | Wallet restore/init; now accepts `ZECD_DATADIR` and `ZECD_CONF` |
| `docker/railway/bootstrap.mjs` | Reused unchanged; points at loopback now |
| `scripts/deploy-railway-allinone.ps1` | New-project bootstrap through the Railway CLI |

One Railway volume is mounted at `/data`:

```
/data/zebra/          zebra state (owned by UID 10001)
/data/funder/         funder zecd datadir (UID 10002)
/data/auctioneer/     auctioneer zecd datadir (UID 10002)
/data/bidshield.db    SQLite (WAL) (UID 10002)
```

## Deploy to a new Railway account

> The current live project is deliberately not modified. These steps create a
> **new** project in whichever account the CLI is logged into.

1. Switch the CLI to the new account:

   ```powershell
   railway logout
   railway login
   railway whoami
   ```

2. From the repo root, dry-run the bootstrap script to see the exact commands:

   ```powershell
   .\scripts\deploy-railway-allinone.ps1
   ```

3. Apply it (it reads the auctioneer seed from `.env` when present):

   ```powershell
   .\scripts\deploy-railway-allinone.ps1 -Apply
   ```

4. Wait for the build, then check the deployment:

   ```powershell
   railway logs --service bidshield
   railway domain list --service bidshield
   ```

5. Point Vercel at the new domain. Update the `destination` in
   `web/vercel.json`, commit, and push (Vercel redeploys automatically):

   ```json
   {
     "rewrites": [
       {
         "source": "/api/:path*",
         "destination": "https://<new-service>.up.railway.app/api/:path*"
       }
     ]
   }
   ```

   A custom API domain (for example `api.example.com`) avoids editing this file
   on every migration: attach it to the new service and keep Vercel's rewrite
   stable.

6. Open the Vercel app. The first request after a cold stop shows the boot
   panel while the chain wakes. The first-ever boot on a fresh volume can take
   a couple of minutes (zebra start, 135 bring-up blocks, wallet restore/scan).
   Later wakes are much faster because `/data` persists.

## Manual dashboard setup (if the CLI config path changes)

1. Create a project and add a service from `cosmopolitanguru002/BIDSHIELD`
   (`main`).
2. Settings → Build → Dockerfile path:
   `docker/railway/allinone.Dockerfile`.
3. Add a volume mounted at `/data`.
4. Set the variables below.
5. Settings → Networking → generate a domain on port `8080`.
6. Settings → Deploy → healthcheck path `/__gateway/health`, timeout `120`,
   restart policy `Always`.
7. Deploy.

## Required variables

| Variable | Value |
| --- | --- |
| `FUNDER_MNEMONIC` | BIP-39 seed for the funder wallet. Defaults to the public all-zero regtest test vector. |
| `AUCTIONEER_MNEMONIC` | BIP-39 seed for the escrow wallet. **Set this explicitly.** The public regtest demo uses the “legal winner…” test vector. |
| `CORS_ORIGIN` | The Vercel origin, e.g. `https://bidshield-demo.vercel.app`. |
| `COOKIE_SECURE` | `1` (the Vercel app is HTTPS; the gateway is HTTPS). |
| `TRUST_PROXY` | `1` (the gateway is the only ingress and sets `X-Forwarded-For`). |
| `IDLE_STOP_SECS` | `900` (stop the chain after 15 idle minutes). |
| `MINER_INTERVAL_SECS` | `1` (regtest confirms quickly). |
| `FUNDER_TARGET_ZATS` | `10000000000` (100 ZEC reserve; 200 faucet claims of 0.5 ZEC). |
| `TOPUP_BLOCKS` | `120`. |
| `WARM_ON_BOOT` | `0` by default. Set `1` to pre-warm after a deploy (costs one idle window). |
| `RUST_LOG` | `info,tower_http=warn`. |

The gateway supplies the internal URLs and zecd credentials; do not set
`ZECD_URL`/`FUNDER_URL`/`DB_PATH` yourself.

## Cost model

- The chain consumes memory only while `state=ready` (plus the idle tail).
- The gateway returns the stack to `stopped` after `IDLE_STOP_SECS`; the
  container itself stays alive with a small Node process. Railway can also put
  the container to sleep if you enable Serverless/App Sleeping; see below.
- The volume is billed by allocated size, not by whether the chain is running.
- The first request in a new session waits for zebra/zecd; the SPA shows a boot
  panel and retries automatically.

Keep the UI tab closed when you are not demoing: while a tab is open, the SPA’s
health/auction polling is activity, so the gateway keeps the stack awake.

## Optional: let the gateway sleep too

Railway’s Serverless/App Sleeping can suspend the whole container when it sees
no outbound traffic. After `IDLE_STOP_SECS` the gateway stops every child, so
there is no polling traffic and Railway can suspend the gateway as well. The
next Vercel `/api/*` request wakes the container, the gateway starts the stack,
and the SPA retries.

This is optional. Wake latency and Serverless availability vary by plan; the
gateway’s own idle stop already removes the dominant chain cost without it.

## Operating

- `GET /__gateway/health` — Railway healthcheck. `200` while starting/ready/
  stopped; `503` only when the stack crashed and needs a restart.
- `GET /__gateway/status` — state, child processes, idle time (no auth; it
  leaks no secrets, but you can keep the Railway domain private if you prefer).
- Logs are prefixed with `[zebra]`, `[funder]`, `[auctioneer]`, `[bootstrap]`,
  `[api]`, so one Railway log stream is still readable.

If a child exits unexpectedly, the gateway marks the stack `broken`, tears down
the remaining children, and restarts the whole stack on the next request
(with a 15-second backoff). This is intentional: a half-dead chain is worse
than a short boot screen.

## First boot / troubleshooting

**Stuck on “Waking the shielded stack”**

```powershell
railway logs --service bidshield
```

Look for the first failing child. Common causes:

- `ZECD_MNEMONIC not set` — set `FUNDER_MNEMONIC` and `AUCTIONEER_MNEMONIC`.
- `zebra never reached height 2` — zebra did not start; check the `[zebra]`
  lines and the cache ownership (`/data/zebra` must be writable by UID 10001;
  the gateway fixes this on start).
- `api wallet_ready` timeout — inspect `[funder]` / `[auctioneer]` for RPC auth
  or backend errors.
- `origin mismatch` on sign-in — `CORS_ORIGIN` does not match the Vercel
  origin exactly (scheme + host, no trailing slash).
- Sign-in works but the cookie does not persist on a local HTTP test — set
  `COOKIE_SECURE=0` locally.

**The build used the wrong Dockerfile**

Railway may fall back to the repository root `Dockerfile` if the service build
settings were not applied. Set Settings → Build → Dockerfile path to
`docker/railway/allinone.Dockerfile` and redeploy. The deploy script sets
`RAILWAY_DOCKERFILE_PATH` as a second safety net.

## Migrating the old demo state

The old project’s four volumes are not attached to its services, so there is no
live wallet/DB state to preserve. The all-in-one starts a fresh regtest chain.
If you do have a volume to keep, download it from the old project and copy
`zebra/`, `funder/`, `auctioneer/`, and `bidshield.db` into `/data` before the
first start.

## Scope and safety

This is a **regtest demo**: `disable_pow = true`, blocks are mined on demand,
and the seeds above are public test vectors. Do not point this image at
mainnet or use it to custody real funds. The API is the same one described in
`docs/RAILWAY.md`; only the process topology and persistence layout change.
