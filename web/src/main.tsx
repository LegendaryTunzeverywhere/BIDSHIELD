/*! BIDSHIELD DIRECTION CONTRACT (seed a368a2bd, mode operate, assigned 3)
 * THESIS: auctions are departures — a sealed bid boards (escrowed, confirmed)
 * or misses the gate; the board's only job is to flap state truthfully and
 * make the next action unmistakable. Refuses the crypto-dashboard default
 * (near-black + neon tickers, hero-metric cards, glassmorphism).
 * OWN-WORLD: mechanical split-flap board grammar — slatted charcoal ground,
 * off-white flap cells with a seam, amber reserved for gate-change signals,
 * operational green/red only; Overpass for board voice, IBM Plex Mono for
 * every amount, address, UUID and countdown.
 * STORY: visitor lands on the live board, opens a lot, registers a bid,
 * receives a ZIP-321 boarding pass, watches 10 confirmations, sees the board
 * flap to SETTLED with refund/winner rows.
 * FIRST VIEWPORT: full-width departure board of live auctions, monumental
 * countdown for nearest close, NEW LOT action in the header band.
 * FORM: split-flap departure board (assigned grounded direction #3).
 * FINISH: unreviewed and undocumented is unfinished; this build ends with
 * the finish review, the verdict, and DESIGN.md.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/overpass/400.css';
import '@fontsource/overpass/600.css';
import '@fontsource/overpass/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
