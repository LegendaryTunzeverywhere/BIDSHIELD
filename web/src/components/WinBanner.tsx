import { useEffect, useMemo, useRef, useState } from 'react';
import { zatsToZec, type Auction } from '../api';
import FlapText from './FlapText';

interface WinBannerProps {
  auction: Auction;
}

/** Confetti particle: a slat-coloured flake that falls and tumbles once. */
interface Flake {
  id: number;
  left: number;
  delay: number;
  duration: number;
  drift: number;
  tone: 'amber' | 'green' | 'ink';
  size: number;
}

const FLAKE_COUNT = 46;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * One-shot celebration shown to the winning bidder once the lot settles.
 * Built from the board's own grammar: a split-flap WON that flips in, amber
 * reserved for the gate-change moment, green for the operational win mark,
 * and a single burst of slat-coloured flakes. The burst is suppressed under
 * prefers-reduced-motion; the banner itself still renders.
 */
export default function WinBanner({ auction }: WinBannerProps) {
  const reduced = usePrefersReducedMotion();
  const settledOnce = useRef(false);
  const [bursting, setBursting] = useState(false);

  const flakes = useMemo<Flake[]>(() => {
    const tones: Flake['tone'][] = ['amber', 'green', 'ink', 'amber', 'green'];
    return Array.from({ length: FLAKE_COUNT }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 2.4 + Math.random() * 1.8,
      drift: (Math.random() - 0.5) * 60,
      tone: tones[i % tones.length],
      size: 6 + Math.random() * 8,
    }));
  }, []);

  // Fire the burst exactly once, the first time we observe a settled win.
  useEffect(() => {
    if (settledOnce.current || reduced) return;
    settledOnce.current = true;
    setBursting(true);
    const t = window.setTimeout(() => setBursting(false), 4600);
    return () => window.clearTimeout(t);
  }, [reduced]);

  const price = auction.price_zats ?? 0;
  // The plan's excess refund is the winner's full overbid (bid - hammer).
  // Bidshield's commission comes out of the seller's side, not the refund,
  // so this amount is returned to the winner in full.
  const excess = auction.settlement?.payments.find(
    (p) => p.kind === 'winner_excess_refund',
  );

  return (
    <div className="win-banner" role="status" aria-live="polite">
      {bursting && !reduced && (
        <div className="win-burst" aria-hidden="true">
          {flakes.map((f) => (
            <span
              key={f.id}
              className={`win-flake win-flake-${f.tone}`}
              style={
                {
                  left: `${f.left}%`,
                  width: f.size,
                  height: f.size * 0.5,
                  animationDelay: `${f.delay}s`,
                  animationDuration: `${f.duration}s`,
                  '--win-drift': `${f.drift}px`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      )}

      <div className="win-head">
        <span className="win-kicker">Board gate change</span>
        <FlapText text="YOU WON" tone="won" className="win-flap" />
      </div>

      <p className="win-lede">
        Your sealed bid was the highest on the hammer. Vickrey rules: you pay the{' '}
        <strong>second price</strong>, not your own — so the hammer price is held for the seller,
        and only your overbid comes back to you.
      </p>

      <dl className="kv win-kv">
        <dt>Hammer price — held for the seller</dt>
        <dd className="win-price">{zatsToZec(price)} ZEC</dd>
        {excess && (
          <>
        <dt>Your overbid — refunded to you in full</dt>
        <dd className="win-refund">
          {zatsToZec(excess.amount_zats)} ZEC — your bid above the hammer price, returned
          shielded with the settlement. No fee is taken from refunds.
        </dd>
          </>
        )}
        <dt>Settlement</dt>
        <dd>
          {auction.payout_state === 'held'
            ? 'your overbid left with the settlement; the seller\u2019s hammer and collateral stay held until you confirm delivery below'
            : auction.settlement_txid
              ? 'your overbid left with the settlement transaction below'
              : 'your overbid left with the settlement'}
        </dd>
      </dl>
    </div>
  );
}
