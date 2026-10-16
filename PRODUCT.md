# Bidshield — PRODUCT.md

## Product truth

**One sentence:** Bidshield runs sealed-bid Vickrey auctions whose bids, escrow,
refunds and proceeds all move exclusively inside ZEC's shielded pool — the
auctioneer never holds transparent funds and chain observers never see an
amount, address, or winner.

**Mechanism that is meaningfully different:** Every bid is a plain shielded
payment (Ironwood pool) to one auctioneer UA with a bid-UUID memo. The
auctioneer's zecd wallet *is* the escrow: no smart contract, no transparent
multisig, no t-addr honeypot. Settlement is one batched shielded `z_sendmany`:
losers refunded (bid − fee), winner refunded (bid − second price − fee), seller
paid (second price − fee). The API never sees a bidder's *sending* address.

**Why now:** Zecathon 2026 "Private Markets" track. The gap: marketplaces
settle "in ZEC" through transparent legs that deanonymize every participant at
the moment of settlement. Bidshield removes the transparent leg entirely.

## Users and jobs

| User | Job | Success looks like |
|---|---|---|
| **Bidder** | Wants to bid on a lot without revealing who they are or what they'll pay until the auction closes | Scans a ZIP-321 QR, pays from any shielded wallet, watches confirmations, gets refund or win without ever creating an account |
| **Seller / operator** | Wants to list a lot, close it at a deadline, pay the second price, and know the chain actually moved | One dashboard: create, watch escrow land, close, settle, see the settlement txid |
| **Judge / reviewer** | Needs to believe the privacy claim | `e2e/lifecycle.sh` is green; THREAT_MODEL.md names every leak; the dashboard's privacy panel states what the chain can and cannot see |

## Platform

- **Web only** (React + Vite front, Axum API back, zecd + Zebra regtest chain
  in Docker Compose). No mobile app; the ZIP-321 QR is scanned by whatever
  shielded wallet the bidder already uses (Ecc, Aori, etc.).
- Demo target: `docker compose up` → open `http://localhost:8080` (API serves
  the built SPA). Judges run `e2e/lifecycle.sh` for the scripted green run.

## Capabilities (must ship)

1. Auction lifecycle: create (title, lot, reserve, close time, seller UA) →
   open → closed → settled; auto-close on deadline.
2. Per-bidder ZIP-321 QR with memo = `bid:<uuid>`; no accounts, capability-URL
   bid status.
3. Bid detection from the auctioneer wallet: `listtransactions` receive rows
   matched by memo; ≥10 confirmations before settlement eligibility.
4. Reserve price respected (below-reserve ⇒ all refunds, no sale).
5. Vickrey settlement: winner pays second price (or reserve if single bid);
   loser refunds; one batched shielded settlement tx; recorded txid.
6. Dashboard: live auctions, escrow balance, bid states, settlement results.
7. Privacy panel: what the chain sees, what the auctioneer sees, confirmation
   policy — rendered from live API state, not copy-paste.
8. Regtest compose + scripted e2e (`e2e/lifecycle.sh`) asserting shielded-only
   transactions and the full lifecycle.

## Constraints to preserve

- Shielded-only settlement (no transparent outputs anywhere in the lifecycle).
- Minimum bid 0.1 ZEC; fee 10 000 zats deducted from each outgoing payment.
- Auctioneer zecd RPC reachable only from the API container; never published.
- No client-IP logging; no third-party assets on the page.
- MIT license; open source at submission; single track (Private Markets).

## Terminology

- **Escrow** = the auctioneer zecd wallet's shielded notes (one wallet, many
  auctions; UUIDs separate them).
- **Ironwood** = the NU6.3 Orchard-successor pool; the pool every bid lives in
  on regtest (and would on mainnet).
- **Vickrey** = second-price sealed bid: winner pays the runner-up's bid.
- **Capability URL** = unguessable UUID path; possession is auth (own bid only).
- **Profile / identity** = seed-phrase sign-in: the browser derives a
  secp256k1 key from the 12/24-word seed on a path unlinkable to the funds
  address; the session binds bids to that account for the bidder's own
  history view.

## Open decisions (deliberate, labeled)

- Seller authentication on close/settle endpoints: **unauthenticated demo**
  (documented in THREAT_MODEL.md); production maps seller identity to keys.
- Cross-auction UA reuse: one auctioneer UA for all auctions in the demo;
  per-auction UAs noted as a production option.

## Assumptions made at init (labeled per skill substitution)

- Demo is judged live at Zecathon + repo review (not video-only) — drives the
  "one command, one green script" requirement.
- Seller and auctioneer may be the same operator (marketplace mode) or distinct
  (seller supplies own UA at create time; supported either way).
- Stack was pre-approved in the project brief (React+Vite, Axum, zecd, SQLite);
  no re-ask.
- Web platform confirmed by the stack itself.
