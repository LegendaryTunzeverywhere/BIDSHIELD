# Bidshield

**Sealed-bid Vickrey auctions, settled entirely in shielded ZEC.**

Buyers place encrypted escrow bids straight from their wallet via ZIP-321
payment requests; the auctioneer never holds funds and never learns amounts
on-chain. At close, a single batched shielded transaction pays the winner
(second-price or buy-it-now), refunds every loser, pays the seller, and
returns any seller collateral — all in one `z_sendmany`, all Orchard notes,
no transparent leg.

Competition submission for **Zecathon 2026 — Private Markets**.

## Listing schema

Every lot is a full listing, not a one-line title:

- **Image gallery** — up to 6 https URLs (CSP `img-src` allows `https:`;
  no binary upload, no storage cost; IPFS gateway URLs work).
- **Category** — `whitelist`, `wallet`, `nft`, `alpha`, `collectible`,
  `other`; filterable chips on the board.
- **Tags** — up to 10 free-form labels shown as badges.
- **Full description** — 4 000 chars, newline-preserving; the intended home
  for wallet provenance, WL tier mechanics, condition notes.
- **Public reserve** — the floor every bidder sees.
- **Hidden reserve** (optional) — a second sealed floor known only to the
  seller and the settlement engine. Public API exposes just
  `has_hidden_reserve: bool`; the effective hammer floor is
  `max(public, hidden)`. A top sealed bid that clears the public floor but
  not the hidden one yields **no sale**.
- **Buy-it-now** (optional) — a public fixed price. A confirmed payment of
  exactly that amount (memo `bid:<id>`, flagged `is_buy_now`) **ends the
  Vickrey round immediately** and beats every sealed bid; the buyer pays the
  BIN price itself (no second-price discount). BIN must clear the public
  reserve; if it sits below the hidden reserve the lot still does not sell.
- **Seller collateral** (optional) — the seller escrows a skin-in-the-game
  amount via ZIP-321 memo `collateral:<auction_id>` (invoice at
  `GET /api/auctions/{id}/collateral`). The scanner matches exact amount +
  memo; sealed bids are rejected (`409`) until collateral confirms. The
  collateral rides home to the seller in the settlement batch
  (`collateral_refund`).
- **Delivery payload** (optional) — a server-held secret for the winner
  (WL registration code, wallet seed hand-off, invite link). Released only
  to the winning bid ID via `POST /api/auctions/{id}/payload` once the lot
  has settled and sold; the bid ID is the capability. Seller-visible in full
  via the signed `GET /api/auctions/{id}/seller` route (also returns the
  hidden reserve value).
- **Refund policy** (optional) — a plain-language promise shown publicly on
  the listing (`refund_policy`, ≤500 chars). Transparency only: Bidshield
  cannot enforce it on-chain. It is backed by the seller's escrowed
  collateral and their reputation, not by code — say so plainly rather than
  implying a guarantee.
- **Contact exchange** (optional) — post-settlement hand-off channel. The
  seller escrows `seller_contact` (≤300 chars) at create time or later via
  `POST /api/auctions/{id}/contact` (signed session, seller only). After the
  hammer falls on a sold lot, the winning bidder posts their own
  `winner_contact` (capability = winning bid ID, passed in the body) and
  claims the seller's note via `POST /api/auctions/{id}/contact/claim`.
  Each note is readable only by the counterparty, written once
  (`contact_claimed` latches after the winner reads the seller's note), and
  never public. Neither field is ever returned by the public auction
  endpoints.

Closing time is an absolute wall-clock timestamp (native picker + presets);
the stored duration is derived at create time. Unix timestamps, not block
heights: Bidshield is a settlement engine, not a contract VM — and NU7's
block-time change (75 s → 25 s) makes height-based deadlines hostile to
reason about. There is also **no reveal window**: the shielded pool already
*is* the commit phase — bid amounts and memos are ciphertext the moment they
hit the chain, so nothing has to be committed and later revealed.

### No seller self-bids (anti-shill)

The bidder's sending address is hidden in the shielded pool, so the engine
cannot prove on-chain who funded a bid. It therefore binds every bid to a
**signed-in session** and rejects the two things it *can* verify:

- `401` if no session — anonymous bidding is closed; a bid must carry a
  first-party identity (a throwaway derived key, unlinkable to the funds).
- `403` if the session identity equals the lot's `seller_pubkey`.
- `400` if the bid's `refund_address` equals the lot's `seller_address`.

This stops the same key and the same address from shilling, but a determined
seller can still spin up a fresh identity. That residual is documented, not
pretended away: a shielded pool hides the funder by design, and the honest
mitigation is the escrowed collateral plus a public refund policy — not a
deanonymizing address check.

## Run it (one command)

```bash
node e2e/lifecycle.mjs
```

Brings up the regtest stack (assumes `docker compose up -d` has been run once
for the wallets), then runs the full product lifecycle — sign in, create lot,
three sealed ZIP-321 bids, detect, close, Vickrey settle, verify shielded-only
settlement — plus the security regression suite (authz boundaries, concurrent
settle race, sealed dashboard, rate limiting). The web UI is live at
**http://127.0.0.1:8080**.

Tear down: `docker compose down -v`.

## Architecture

```
bidder wallet ──ZIP-321 memo──▶ auctioneer zecd (orchard)
                                      │ detector sweep (listtransactions, memo match)
                                      ▼
   web UI ◀── HTTP ──▶ api (Axum + SQLite)
                                      │ close + Vickrey math
                                      ▼
                          z_sendmany batch settlement
                          (winner + price, loser refunds,
                           seller proceeds — one tx, all shielded)
```

- **Web** — React + Vite; split-flap departure-board design system
  (`DESIGN.md`); served as static files by the API. Sign-in is by seed
  phrase: the server issues a nonce challenge, the browser derives a secp256k1
  key from the 12/24-word seed (on a path unlinkable to the funds address)
  and signs the Zcash Signed Message payload, and the API issues an httpOnly
  session cookie. The profile page shows your identity, hosted wallet
  address, and your bids (`/api/me/bids`).
- **API** — Rust / Axum; SQLite (rusqlite, bundled); owns auction state
  machine, bid detection (≥1 conf), settlement batch construction, the
  ZIP-321 request the bidder scans, and signature-based auth (`/api/auth/*`).
  Hardened: per-IP rate limiting (three classes + auth-failure lockout),
  request body cap, timeout + concurrency limits, security headers (CSP,
  nosniff, DENY), no CORS, seller-identity binding on create/early-close,
  CAS-guarded single settlement, crash-recovering settlement ledger, and
  amount-exact memo matching (squat defense).
- **zecd** — regtest shielded wallet; the auctioneer's escrow wallet. Every
  dollar moves orchard→orchard only.
- **zebra** — regtest chain (`disable_pow`, genesis-pinned).

## Privacy

Full analysis: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

- Bids move orchard note→orchard note; amounts and addresses are
  cryptographically hidden on-chain.
- The settlement batch is a single `z_sendmany`: winner, refunds, seller,
  all shielded, indistinguishable from any other shielded payment.
- The auctioneer sees nothing on-chain it did not put there; it learns bids
  only because it is the operator running the detector (sealed
  bidder-vs-bidder, disclosed to the operator — the standard trust model).
- No IP logging, no analytics, no third-party resources (fonts are
  self-hosted). Session cookies are httpOnly + SameSite=Strict; the stored
  token is a SHA-256 hash. The `/api/privacy` endpoint returns the
  residual-leak inventory live.

## Repo layout

| Path | What |
|---|---|
| `compose.yml` | zebra + funder + auctioneer + api |
| `crates/api` | Axum API (routes, detector, settlement executor) |
| `crates/settlement` | Vickrey math (second price, reserve, ties, buy-it-now, collateral refund) — 12 unit tests |
| `crates/zecd-client` | zecd + zebra JSON-RPC clients (auth, chain sync probe) |
| `web/` | React SPA |
| `e2e/spike.mjs` | chain + wallet bring-up proof (23 checks) |
| `e2e/lifecycle.mjs` | full product lifecycle run |
| `e2e/testnet.mjs` | full product lifecycle run (public testnet, light mode) |
| `docs/THREAT_MODEL.md` | threat model |
| `docs/VIDEO_SCRIPT.md` | demo video shot list + script |
| `docs/SUBMISSION.md` | Zecathon submission text (paste-ready) |
| `PRODUCT.md` | product spec + assumptions |
| `DESIGN.md` | visual system of record |

## Development

Configuration lives in `.env` (copy `.env.example` and edit — never commit
`.env`; it is gitignored). Docker Compose interpolates it automatically; the
API binary loads it directly on the host. Real environment variables always
override the file.

```bash
cp .env.example .env   # once; edit as needed

# API (host, against running wallets — picks up ./.env)
cargo run -p api

# Web (dev server, proxies /api to :8080)
npm --prefix web run dev
```

### API configuration (.env / environment)

All variables below are read from the environment with `.env` as a fallback;
defaults shown apply when neither is set.

| Variable | Default | What |
|---|---|---|
| `ZECD_URL` | `http://127.0.0.1:18232/` | zecd JSON-RPC endpoint |
| `ZECD_HEALTH` | `http://127.0.0.1:9233/readyz` | zecd readiness probe |
| `ZECD_USER` / `ZECD_PASS` | — | HTTP basic auth for zecd |
| `BIND` | `0.0.0.0:8080` | API listen address |
| `DB_PATH` | `data/bidshield.db` | SQLite file |
| `WEB_DIST` | `web/dist` | built SPA to serve |
| `CONF_TARGET` | 10 | confirmation target for settlement |
| `FEE_ZATS` | 10 000 | per-output network fee (zats) |
| `MIN_BID_ZATS` | 100 000 | minimum bid (0.001 ZEC) |
| `MAX_BID_ZATS` | 10 000 000 000 000 | bid/reserve ceiling |
| `POLL_SECS` | 5 | detector / close sweep interval |
| `RATE_AUTH_PER_MIN` | 20 | auth-endpoint rate (covers secp256k1 recovery cost) |
| `RATE_WRITE_PER_MIN` | 30 | state-changing requests per IP |
| `RATE_READ_PER_MIN` | 240 | GET/HEAD per IP |
| `AUTH_FAIL_MAX` | 10 | failed verifies before lockout |
| `AUTH_LOCKOUT_SECS` | 60 | lockout duration |
| `MAX_CONCURRENT_REQUESTS` | 64 | in-flight cap (503 beyond) |
| `MISSED_GRACE_SECS` | 120 | time before an undetected bid is marked missed |
| `SESSION_TTL_SECS` | 604 800 | session cookie lifetime |
| `COOKIE_SECURE` | 0 | set `1` behind TLS |
| `NETWORK` | `regtest` | name of the default profile (chain itself is detected from zecd) |
| `NETWORK_TESTNET_URL` | — | enable a testnet profile (plus `_HEALTH`/`_USER`/`_PASS`/`_DB_PATH`) |
| `NETWORK_MAINNET_URL` | — | enable a mainnet profile (plus `_HEALTH`/`_USER`/`_PASS`/`_DB_PATH`) |

### Multi-network (testnet / mainnet)

The default profile talks to the regtest zecd in the compose stack.

**Testnet is an opt-in compose profile** — never started by default, so
`docker compose up -d` is a lean regtest-only stack that works offline in
minutes. The testnet profile needs **no local full node**: zecd 0.9.0-rc1
runs in light mode against the public zec.rocks lightwalletd (the `"zecrocks"`
backend alias in `testnet/zecd.*.toml`). Public testnet activated **NU7 on
2026-10-04 at height 4,465,026**; the light build is NU7-era, so no Zebra
sync is involved. Enable it by uncommenting the `NETWORK_TESTNET_*` block in
`.env` (commands in `.env.example`) and running
`docker compose --profile testnet up -d`, then initialize that profile's
auctioneer wallet. On testnet there is no miner: fund the escrow from a
faucet (e.g. faucet.testnet.valargroup.dev) or restore a TESTNET wallet
whose build predates NU7 (`zecd init --restore` accepts its BIP-39 seed) —
the active profile's escrow address is on Profile. A full lifecycle
(create → bid → detect → close → settle) has been executed green on public
testnet via `node e2e/testnet.mjs`.

**Mainnet is likewise opt-in** and *does* need a synced full node (tens of
GB, multi-day sync, real funds; mainnet NU7 targets ~2026-11-05). Enable the
`NETWORK_MAINNET_*` block the same way.

A profile reports **ready only when its chain is near the estimated network
tip** (zecd's `/readyz` alone goes green hours early on a syncing node — the
api also probes zebra's `getblockchaininfo` `verificationprogress`, floor
`SYNC_PROGRESS_MIN`, default 0.9999). Until then the header menu shows the
row as *syncing* and switching is refused.

Each profile keeps its own SQLite file, escrow wallet, detector loop, and
auction board. Switch from the header network pill (signed-in operator
action) or `POST /api/network` — the pill, escrow address, and board all
follow the active profile. The choice is process-local and resets to
`NETWORK` on restart. Sign-in and the hosted wallet both target the active
profile's chain: sign-in and payments are refused when that profile is not
configured or not yet synced.

## Verification

```bash
cargo test          # settlement + client unit tests
npm --prefix web run build
node e2e/spike.mjs  # chain primitives
bash e2e/lifecycle.sh  # full product path (regtest)
node e2e/testnet.mjs   # full product path (public testnet, light mode)
```

MIT licensed.
