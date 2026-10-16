# Bidshield — DESIGN.md

Visual system of record for the Bidshield web surface. Direction seed:
`a368a2bd` (operate mode, grounded direction 3 — split-flap departure board).

## World

Auctions are departures. The board is a mechanical split-flap display: a
slatted charcoal ground, off-white flap cells with a visible seam, and amber
reserved exclusively for gate-change signals (closing soon, primary action).
Operational green/red mark settled/missed states — nothing else is colored.
The world refuses the crypto-dashboard default (near-black + neon tickers,
hero-metric cards, glassmorphism): there are no KPI tiles, no gradients on
text, no glow.

## Palette

| Token | Value | Role |
|---|---|---|
| `--ground` | `#15171a` | Page ground, 28px slat rhythm |
| `--slat` / `--panel` | `#1b1e22` / `#22262b` | Board and panel surfaces |
| `--flap` / `--seam` | `#31363e` / `#0e1013` | Flap cell face and hinge seam |
| `--ink` / `--ink-dim` / `--ink-faint` | `#eceae4` / `#a8a49c` / `#6f6b64` | Text ladder |
| `--amber` | `#ffb000` | Gate-change signal, primary action, OPEN flap |
| `--green` | `#43c463` | SETTLED / WON / confirmed (operational only) |
| `--red` | `#e5564b` | MISSED / CANCELED (operational only) |
| `--line` | `#343a42` | 1px structural rules |

## Type

- **Overpass** (400/600/700) — board voice; humanist signage sans. Display:
  uppercase, tracked 0.06–0.16em, weight 700.
- **IBM Plex Mono** (400/500) — every amount, address, UUID, countdown, txid.
  Tabular numerals everywhere a number ticks.
- Scale: page title `clamp(28px, 4vw, 40px)`; monumental countdown
  `clamp(40px, 8vw, 72px)`; body 16px/1.45; labels 11px uppercase 0.14em.

## Components

- **FlapText** — status words rendered as per-character flap cells
  (gradient face + seam pseudo-element). Text change triggers a 280ms
  rotateX flap; tone classes color the whole word. `aria-label` carries the
  plain status; cells are `aria-hidden`.
- **Countdown** — 1s tick, `HH:MM:SS` mono; amber under 10 minutes; flips to
  `CLOSED` text past deadline (no negative countdown).
- **Board table** — `LOT · RESERVE · CLOSES IN · STATUS · GATE` columns;
  rows are links; staggered 45ms entrance capped at 8 rows; mobile collapses
  to two columns with inline `col-label`s.
- **Monument band** — next-departure strip on the board; reserve/hammer
  strip on a lot.
- **QR invoice** — white quiet-zone panel (the one light surface; a QR must
  be scannable), mono URI, copy button; lives inside the bid form panel, not
  a modal.
- **Status track** — bidder's four stages (registered → detected →
  confirmed → settled) as a tick list; current stage amber, done green.
- **Data table** — settlement ledger and dashboard rows; winner marked with
  weight + green, never a pill.

## Motion

One authored moment: the flap. Everything else is a 100ms hover tint and a
360ms row entrance. `prefers-reduced-motion: reduce` disables flap and
entrance animations entirely. No parallax, no scroll-jacking, no glow.

## Responsive

Breakpoints are content-driven: **860px** (board/detail/table structures
break) and **480px** (header crowding, padding economy). Input method is
detected separately via `pointer: coarse`.

- ≤860px: header wraps (badge drops to its own row), board rows become
  two-column stacks with inline `col-label`s, detail grid single-columns,
  monumental countdown scales via clamp. QR stays 220px (scannable floor).
- **Data tables → stacked cards**: `thead` hidden; each row a bordered
  block; each cell a `label · value` pair fed by `data-label` (same
  uppercase-tracked label voice as board `col-label`s). Applies to the
  dashboard bid table, settlement ledger, and profile bids.
- ≤480px: wordmark/nav tighten, panels 16px, `kv` labels stack above
  values, toast goes full-width, single-column forms.
- `pointer: coarse`: all controls ≥44px touch floor; inputs bump to 16px
  (prevents iOS focus zoom).
- Safe areas: `viewport-fit=cover` + `env(safe-area-inset-*)` on the sticky
  header (top/sides), shell (sides/bottom), and toast (bottom).
- Desktop (≥1024px): content capped at 1120px; table rows gain a hover
  tint for scanability.

## Accessibility

- Contrast: ink `#eceae4` on ground `#15171a` ≈ 14:1; dim text ≈ 7:1; amber
  on ground ≈ 9:1. QR panel uses dark ink on `#f4f2ec`.
- Focus-visible: 2px amber outline, 2px offset on all interactive elements.
- Semantics: board is `role="table"` with columnheaders; flap words carry
  `aria-label`; countdown carries `aria-label` with human text.
- States present: hover, focus, disabled (busy buttons), error (red-bordered
  lines naming the recovery), empty (board/lot/dashboard empty states),
  loading (“Connecting…”, “Loading lot…”).

## Build conventions

- Fonts self-hosted via `@fontsource` (no runtime third-party requests —
  threat model forbids them).
- No CSS framework; tokens in `:root`; one stylesheet.
- SPA served by the Axum API from `web/dist`; dev via Vite proxy to `:8080`.
- The direction contract (seed `a368a2bd`) is embedded as a preserved legal
  comment in `index.html` and `src/main.tsx`; both survive `vite build`
  (verified by grep of `dist/`).
