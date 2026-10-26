import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
  api,
  categoryLabel,
  recallBid,
  rememberBid,
  shortId,
  zatsToZec,
  type Auction,
  type BidStatus,
  type SellerView,
} from '../api';
import { useSession, friendlyWalletError } from '../session';
import TxidLink from '../components/TxidLink';
import Countdown from '../components/Countdown';
import FlapText from '../components/FlapText';
import WinBanner from '../components/WinBanner';

const STEPS = ['registered', 'detected', 'confirmed', 'settled'] as const;

export default function Lot() {
  const { id = '' } = useParams();
  const { identity } = useSession();
  const [auction, setAuction] = useState<Auction | null>(null);
  const [bidId, setBidId] = useState<string | null>(() => recallBid(id));
  const [bidStatus, setBidStatus] = useState<BidStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [confTarget, setConfTarget] = useState<number | null>(null);
  const [sellerView, setSellerView] = useState<SellerView | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (alive) {
          setNetwork(h.network);
          setConfTarget(h.conf_target);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Recover this lot's bid ID from the identity's server-side binding when
  // localStorage is empty (cleared storage, private window, other device).
  // Without this a winner can never open the contact/payout panels.
  useEffect(() => {
    if (bidId || !identity) return;
    let alive = true;
    api
      .myBids()
      .then((rows) => {
        const mine = rows.find((b) => b.auction_id === id);
        if (alive && mine) {
          rememberBid(id, mine.id);
          setBidId(mine.id);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bidId, identity, id]);

  const refresh = useCallback(async () => {
    try {
      const a = await api.auction(id);
      setAuction(a);
      if (bidId) {
        const b = await api.bid(bidId);
        setBidStatus(b);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, bidId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Lightbox: Esc closes, arrows step through images, body scroll locked.
  useEffect(() => {
    if (lightbox == null) return;
    const count = auction?.images.length ?? 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      else if (e.key === 'ArrowRight' && count > 0)
        setLightbox((i) => (i == null ? i : (i + 1) % count));
      else if (e.key === 'ArrowLeft' && count > 0)
        setLightbox((i) => (i == null ? i : (i - 1 + count) % count));
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [lightbox, auction?.images.length]);

  if (error && !auction) {
    const booting = /boot|waking|starting|503|unavailable/i.test(error);
    const missing = /not found|404/i.test(error);
    return (
      <>
        <Link className="back-link" to="/">
          ← Board
        </Link>
        <div className={`load-panel panel${booting ? ' booting' : ''}`} role="alert">
          <div>
            <strong>
              {booting ? 'Waking the shielded stack' : missing ? 'Lot not found' : 'Lot unreachable'}
            </strong>
            <p className="page-sub">
              {booting
                ? 'The demo chain starts on demand. This lot will load automatically when it wakes.'
                : error}
            </p>
          </div>
          {!missing && (
            <button type="button" className="btn btn-small" onClick={() => void refresh()}>
              Retry
            </button>
          )}
        </div>
      </>
    );
  }

  if (!auction) {
    return (
      <div className="load-panel panel" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>Loading lot…</span>
      </div>
    );
  }

  const onBid = (newBidId: string) => {
    rememberBid(id, newBidId);
    setBidId(newBidId);
    refresh();
  };

  const settled = auction.status === 'settled';
  const winnerIsBuyNow =
    auction.bids?.find((b) => b.id === auction.winner_bid_id)?.is_buy_now === true;
  const stageIndex = (status: string | undefined) => {
    if (!status) return -1;
    // Terminal states complete the whole track (past the last index) so the
    // final "Settlement complete" step renders done/green, not current/amber.
    if (status === 'won' || status === 'refunded' || status === 'settled') {
      return STEPS.length;
    }
    const idx = STEPS.indexOf(status as (typeof STEPS)[number]);
    if (status === 'missed') return 0;
    return idx;
  };
  const currentStage = stageIndex(bidStatus?.status);

  // One row per outgoing settlement payment. The plan is the source of truth
  // (it is exactly what was sent); the bid rows supply the gross escrowed
  // amounts. Winner first, then losers by size, then the seller-side rows.
  const plan = auction.settlement;
  const bidById = new Map((auction.bids ?? []).map((b) => [b.id, b]));
  const kindOrder: Record<string, number> = {
    winner_excess_refund: 0,
    bid_refund: 1,
    seller_proceeds: 2,
    collateral_refund: 3,
  };
  const kindLabel: Record<string, string> = {
    winner_excess_refund: 'Winner excess refund',
    bid_refund: 'Bid refund',
    seller_proceeds: 'Seller proceeds',
    collateral_refund: 'Seller collateral returned',
  };
  const ledgerRows = (plan?.payments ?? [])
    .map((p) => {
      const bid = p.bid_id ? bidById.get(p.bid_id) : undefined;
      const gross = bid?.confirmed_amount_zats ?? null;
      const price = auction.price_zats ?? 0;
      // The commission is taken only from the seller's proceeds (the hammer
      // price). Every bidder refund is full — no fee on refunds — so the
      // "fee" column is non-zero only on the seller-proceeds row.
      const fee = p.kind === 'seller_proceeds' ? price - p.amount_zats : 0;
      return {
        key: p.bid_id ?? p.kind,
        bidId: p.bid_id,
        gross,
        net: p.amount_zats,
        fee,
        kind: p.kind,
        isWinner: p.kind === 'winner_excess_refund',
        sellerSide: p.kind === 'seller_proceeds' || p.kind === 'collateral_refund',
      };
    })
    .sort((a, b) => {
      const oa = kindOrder[a.kind] ?? 9;
      const ob = kindOrder[b.kind] ?? 9;
      if (oa !== ob) return oa - ob;
      return (b.gross ?? 0) - (a.gross ?? 0);
    });

  return (
    <>
      <Link className="back-link" to="/">
        ← Board
      </Link>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {auction.title}
            <span className="badge-row">
              <span className="badge">{categoryLabel(auction.category)}</span>
              {auction.tags.map((t) => (
                <span className="badge badge-dim" key={t}>
                  {t}
                </span>
              ))}
              {auction.bin_price_zats != null && (
                <span className="badge badge-buy">Buy now</span>
              )}
              {auction.has_hidden_reserve && (
                <span className="badge badge-secret">Hidden floor</span>
              )}
            </span>
          </h1>
          {auction.description && <p className="page-sub">{auction.description}</p>}
        </div>
        <FlapText text={auction.status} />
      </div>

      {auction.images.length > 0 && (
        <div className="gallery" role="group" aria-label="Lot gallery">
          {auction.images.map((u, i) => (
            <img
              key={`${u}-${i}`}
              src={u}
              alt={`${auction.title} — image ${i + 1}`}
              loading={i === 0 ? 'eager' : 'lazy'}
              onClick={() => setLightbox(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setLightbox(i);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`Maximize image ${i + 1}`}
            />
          ))}
        </div>
      )}

      {lightbox != null && auction.images[lightbox] && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Lot image viewer"
          onClick={() => setLightbox(null)}
        >
          <img
            src={auction.images[lightbox]}
            alt={`${auction.title} — image ${lightbox + 1}`}
            onClick={(e) => e.stopPropagation()}
          />
          {auction.images.length > 1 && (
            <>
              <button
                type="button"
                className="lightbox-nav lightbox-prev"
                aria-label="Previous image"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox(
                    (lightbox - 1 + auction.images.length) % auction.images.length,
                  );
                }}
              >
                ‹
              </button>
              <button
                type="button"
                className="lightbox-nav lightbox-next"
                aria-label="Next image"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((lightbox + 1) % auction.images.length);
                }}
              >
                ›
              </button>
            </>
          )}
          <button
            type="button"
            className="lightbox-close"
            aria-label="Close image viewer"
            onClick={(e) => {
              e.stopPropagation();
              setLightbox(null);
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div className="monument-band">
        <div>
          <div className="label">Reserve</div>
          <div className="countdown-monument" style={{ fontSize: 'clamp(24px, 4vw, 36px)' }}>
            {zatsToZec(auction.reserve_zats)}
          </div>
          <div className="label" style={{ marginTop: 4 }}>
            ZEC{auction.has_hidden_reserve ? ' + hidden floor' : ''}
          </div>
        </div>
        {auction.bin_price_zats != null && auction.status === 'open' && (
          <div>
            <div className="label">Buy-it-now</div>
            <div
              className="countdown-monument"
              style={{ fontSize: 'clamp(24px, 4vw, 36px)', color: 'var(--amber)' }}
            >
              {zatsToZec(auction.bin_price_zats)}
            </div>
            <div className="label" style={{ marginTop: 4 }}>
              ZEC — ends the round
            </div>
          </div>
        )}
        <div>
          <div className="label">
            {auction.status === 'open'
              ? 'Gate closes in'
              : settled
                ? 'Settled'
                : 'Closed at'}
          </div>
          <div className="countdown-monument">
            {settled ? (
              <span className="cell-mono muted">
                {auction.settled_at
                  ? new Date(auction.settled_at * 1000).toLocaleString()
                  : 'SETTLED'}
              </span>
            ) : (
              <Countdown closesAt={auction.closes_at} id={auction.id} stopped={!settled && auction.status !== 'open'} />
            )}
          </div>
        </div>
        {settled && (
          <div>
            <div className="label">Hammer price</div>
            <div className="countdown-monument" style={{ color: 'var(--green)' }}>
              {auction.sold ? zatsToZec(auction.price_zats ?? 0) : 'NO SALE'}
            </div>
            <div className="label" style={{ marginTop: 4 }}>
              {auction.sold
                ? winnerIsBuyNow
                  ? 'ZEC (buy-it-now)'
                  : 'ZEC (second price)'
                : 'reserve not met'}
            </div>
          </div>
        )}
      </div>

      {settled && auction.sold && bidId && auction.winner_bid_id === bidId && (
        <WinBanner auction={auction} />
      )}

      <div className="detail-grid">
        <div>
          {auction.collateral_zats > 0 && (
            <CollateralPanel auction={auction} onRefresh={refresh} />
          )}

          {auction.status === 'open' && (
            <BidPanel auction={auction} onBid={onBid} existingBid={bidStatus} />
          )}

          {bidId && (
            <div className="panel">
              <h2 className="panel-title">Your boarding pass</h2>
              <div className="status-track">
                {STEPS.map((step, i) => (
                  <div
                    key={step}
                    className={`status-step${i < currentStage ? ' done' : ''}${i === currentStage ? ' current' : ''}`}
                  >
                    <span className="tick">{i <= currentStage ? '●' : '○'}</span>
                    <span>
                      {step === 'registered'
                        ? 'Bid registered — pay the ZIP-321 invoice from any shielded wallet'
                        : step === 'detected'
                          ? 'Escrow saw your payment (mempool or early confirmations)'
                          : step === 'confirmed'
                            ? 'Escrowed at full confirmation depth — eligible for settlement'
                            : 'Settlement complete — refund or win paid back shielded'}
                    </span>
                  </div>
                ))}
              </div>
              {bidStatus && (
                <dl className="kv" style={{ marginTop: 18 }}>
                  <dt>Bid ID</dt>
                  <dd>{bidStatus.id}</dd>
                  <dt>Status</dt>
                  <dd>
                    <FlapText text={bidStatus.status} />
                  </dd>
                  <dt>Confirmations</dt>
                  <dd>
                    {bidStatus.confirmations} / {confTarget ?? 10}
                  </dd>
                  {bidStatus.txid && (
                    <>
                      <dt>Bid txid</dt>
                      <dd>
                        <TxidLink network={network} txid={bidStatus.txid} />
                      </dd>
                    </>
                  )}
                  {bidStatus.confirmed_amount_zats != null && (
                    <>
                      <dt>Escrowed</dt>
                      <dd>{zatsToZec(bidStatus.confirmed_amount_zats)} ZEC</dd>
                    </>
                  )}
                  {bidStatus.refund_amount_zats != null && (
                    <>
                      <dt>Paid back</dt>
                      <dd style={{ color: 'var(--green)' }}>
                        {zatsToZec(bidStatus.refund_amount_zats)} ZEC
                      </dd>
                    </>
                  )}
                  {bidStatus.refund_txid && (
                    <>
                      <dt>Settlement tx</dt>
                      <dd>
                        <TxidLink network={network} txid={bidStatus.refund_txid} />
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          )}

          {settled && auction.sold && auction.has_delivery_payload && bidId && auction.winner_bid_id === bidId && (
            <PayloadClaimPanel auctionId={auction.id} bidId={bidId} />
          )}

          {settled && auction.sold && auction.payout_state && (
            <PayoutPanel auction={auction} bidId={bidId} onRefresh={refresh} />
          )}

          {settled && auction.sold && bidId && auction.winner_bid_id === bidId && (
            <ContactPanel auction={auction} bidId={bidId} role="winner" />
          )}

          {settled && (plan || auction.bids) && (
            <div className="panel">
              <h2 className="panel-title">Settlement ledger</h2>
              <p className="muted ledger-note">
                The auctioneer paid every bidder row below in{' '}
                <strong>one shielded transaction</strong>, from its own unified address, to the
                shielded refund address each bidder registered. Each bidder got back their full
                escrowed deposit.{' '}
                {auction.sold
                  ? 'The seller\u2019s proceeds and collateral are held back until the winner confirms delivery.'
                  : 'Nothing was queued or held \u2014 it all left with the settlement itself.'}
              </p>
              {auction.sold && auction.payout_state && (
                <p className="ledger-note" style={{ margin: '0 0 12px' }}>
                  <span
                    className={`badge${auction.payout_state === 'held' ? '' : auction.payout_state === 'released' ? ' badge-won' : auction.payout_state === 'disputed' ? ' badge-buy' : ' badge-dim'}`}
                  >
                    {auction.payout_state === 'held'
                      ? 'Seller payout held — awaiting delivery confirmation'
                      : auction.payout_state === 'released'
                        ? 'Seller payout released'
                        : auction.payout_state === 'disputed'
                          ? 'Disputed — payout frozen under review'
                          : 'Sale voided — disputed'}
                  </span>
                </p>
              )}
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Bid</th>
                    <th>Outcome</th>
                    <th>Escrowed</th>
                    <th>Fee</th>
                    <th>Paid back</th>
                  </tr>
                </thead>
                <tbody>
                  {plan
                    ? ledgerRows.map((r) => (
                        <tr key={r.key} className={r.sellerSide ? 'ledger-seller' : undefined}>
                          <td className="mono" data-label="Bid">
                            {r.bidId ? shortId(r.bidId) : '—'}
                          </td>
                          <td data-label="Outcome">
                            {r.isWinner ? (
                              <span className="winner-mark">
                                WINNER — pays {zatsToZec(auction.price_zats ?? 0)}
                              </span>
                            ) : (
                              <span className={r.sellerSide ? 'ledger-kind' : undefined}>
                                {kindLabel[r.kind] ?? r.kind}
                              </span>
                            )}
                          </td>
                          <td className="mono" data-label="Escrowed">
                            {r.gross != null ? `${zatsToZec(r.gross)} ZEC` : '—'}
                          </td>
                          <td className="mono ledger-fee" data-label="Fee">
                            {r.gross != null || r.sellerSide ? `${zatsToZec(r.fee)} ZEC` : '—'}
                          </td>
                          <td className="mono" data-label="Paid back">
                            {r.net > 0 ? `${zatsToZec(r.net)} ZEC` : '—'}
                          </td>
                        </tr>
                      ))
                    : (auction.bids ?? []).map((b) => (
                        <tr key={b.id}>
                          <td className="mono" data-label="Bid">{shortId(b.id)}</td>
                          <td data-label="Outcome">
                            {b.id === auction.winner_bid_id ? (
                              <span className="winner-mark">
                                WINNER — pays {zatsToZec(auction.price_zats ?? 0)}
                              </span>
                            ) : (
                              <FlapText text={b.status} />
                            )}
                          </td>
                          <td className="mono" data-label="Escrowed">
                            {b.confirmed_amount_zats != null
                              ? `${zatsToZec(b.confirmed_amount_zats)} ZEC`
                              : '—'}
                          </td>
                          <td className="mono ledger-fee" data-label="Fee">—</td>
                          <td className="mono" data-label="Paid back">
                            {b.refund_amount_zats != null
                              ? `${zatsToZec(b.refund_amount_zats)} ZEC`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
              {auction.settlement_txid && (
                <dl className="kv" style={{ marginTop: 16 }}>
                  <dt>Settlement tx</dt>
                  <dd>
                    <TxidLink network={network} txid={auction.settlement_txid} />
                  </dd>
                  <dt>Who paid</dt>
                  <dd>
                    The auctioneer — the shielded address that held every escrowed deposit for
                    this lot. It paid everyone out of that escrow in one go.
                  </dd>
                  <dt>How it split</dt>
                  <dd>
                    Each loser received their full escrowed deposit back. The winner received
                    only their overbid — the part of their bid above the hammer price — since
                    the hammer portion is held for the seller. No fee is taken from any bidder
                    refund. The seller&apos;s proceeds (hammer less Bidshield&apos;s commission)
                    and collateral stay in escrow until the winner confirms delivery.
                  </dd>
                  <dt>Bidshield commission</dt>
                  <dd>
                    {ledgerRows.length > 0
                      ? `${zatsToZec(ledgerRows.reduce((s, r) => s + r.fee, 0))} ZEC retained by Bidshield`
                      : 'a percentage of the hammer price'}{' '}
                    — a commission on the seller's proceeds only, shown on the seller row above.
                    The on-chain miner fee for the settlement transaction is paid separately by
                    the auctioneer's own wallet, not by any bidder or the seller.
                  </dd>
                </dl>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="panel">
            <h2 className="panel-title">Lot record</h2>
            <dl className="kv">
              <dt>Lot ID</dt>
              <dd>{auction.id}</dd>
              <dt>Reserve</dt>
              <dd>{zatsToZec(auction.reserve_zats)} ZEC</dd>
              {auction.has_hidden_reserve && (
                <>
                  <dt>Hidden reserve</dt>
                  <dd>set (value sealed until settlement)</dd>
                </>
              )}
              {auction.bin_price_zats != null && (
                <>
                  <dt>Buy-it-now</dt>
                  <dd>{zatsToZec(auction.bin_price_zats)} ZEC</dd>
                </>
              )}
              {auction.collateral_zats > 0 && (
                <>
                  <dt>Seller collateral</dt>
                  <dd>
                    {zatsToZec(auction.collateral_zats)} ZEC —{' '}
                    {auction.collateral_txid ? 'escrowed' : 'awaiting payment'}
                  </dd>
                </>
              )}
              {auction.has_delivery_payload && (
                <>
                  <dt>Delivery payload</dt>
                  <dd>{auction.payload_claimed ? 'claimed by winner' : 'sealed for winner'}</dd>
                </>
              )}
              {auction.refund_policy && (
                <>
                  <dt>Refund policy</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{auction.refund_policy}</dd>
                </>
              )}
              {settled && auction.sold && (
                <>
                  <dt>Contact exchange</dt>
                  <dd>
                    {auction.contact_claimed
                      ? 'winner has claimed the seller contact'
                      : 'escrowed — open only to winner and seller'}
                  </dd>
                </>
              )}
              <dt>Seller</dt>
              <dd>{auction.seller_address}</dd>
              <dt>Closes</dt>
              <dd>{new Date(auction.closes_at * 1000).toLocaleString()}</dd>
              {settled && (
                <>
                  <dt>Settlement tx</dt>
                  <dd>
                    {auction.settlement_txid ? (
                      <TxidLink network={network} txid={auction.settlement_txid} />
                    ) : (
                      '—'
                    )}
                  </dd>
                </>
              )}
            </dl>
          </div>

          <SellerPanel
            auction={auction}
            sellerView={sellerView}
            onLoad={setSellerView}
          />

          <div className="panel">
            <h2 className="panel-title">What the chain sees</h2>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              One shielded payment per bid to the auctioneer UA, indistinguishable from any other
              Ironwood output. Amounts, memos and winners live inside the ciphertext — only the
              auctioneer receiver can read the bid UUID memo. See the{' '}
              <Link to="/privacy" style={{ color: 'var(--amber)' }}>
                privacy panel
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/** Seller-collateral status + payment (visible to all; only the seller pays it). */
function CollateralPanel({
  auction,
  onRefresh,
}: {
  auction: Auction;
  onRefresh: () => void;
}) {
  const [invoice, setInvoice] = useState<{ uri: string; memo: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [paidTxid, setPaidTxid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { identity } = useSession();

  const loadInvoice = async () => {
    try {
      const inv = await api.collateralInvoice(auction.id);
      setInvoice({ uri: inv.zip321_uri, memo: inv.memo });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (auction.collateral_txid === null && auction.collateral_zats > 0 && !invoice) {
      void loadInvoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auction.collateral_txid, auction.id]);

  const copy = async () => {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setErr('Clipboard blocked — select the URI and copy manually.');
    }
  };

  const payHosted = async () => {
    setPayBusy(true);
    setErr(null);
    try {
      const res = await api.payCollateral(auction.id);
      setPaidTxid(res.txid);
    } catch (e) {
      setErr(friendlyWalletError(e));
    } finally {
      setPayBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel-title">Seller collateral</h2>
      <div className="collateral-status">
        <span className={`dot ${auction.collateral_txid ? 'paid' : 'pending'}`} />
        <span>
          {zatsToZec(auction.collateral_zats)} ZEC —{' '}
          {auction.collateral_txid ? (
            <>
              escrowed, tx <TxidLink network={null} txid={auction.collateral_txid} />; returned to
              the seller with settlement
            </>
          ) : paidTxid ? (
            <>
              payment sent, tx <TxidLink network={null} txid={paidTxid} />; waiting for the
              escrow detector to confirm it
            </>
          ) : (
            'awaiting seller payment; sealed bids cannot be registered until it confirms'
          )}
        </span>
      </div>
      {auction.collateral_txid === null && !paidTxid && (
        <>
          {identity && (
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={payBusy}
                onClick={() => void payHosted()}
              >
                {payBusy ? 'Escrowing…' : 'Pay collateral with hosted wallet'}
              </button>
            </div>
          )}
          {invoice && (
            <div style={{ marginTop: 14 }}>
              <div className="field-hint" style={{ display: 'block', marginBottom: 8 }}>
                Or pay from an external ZEC wallet: scan the QR or open the invoice URI. It
                already carries the exact amount, the auctioneer&apos;s escrow address, and the
                memo — a ZIP-321 wallet fills them in automatically.
              </div>
              <div className="qr-wrap">
                <QRCodeSVG value={invoice.uri} size={180} level="M" includeMargin={false} />
                <div className="uri-line">{invoice.uri}</div>
                <button type="button" className="copy-btn" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy invoice URI'}
                </button>
              </div>
              <span className="field-hint" style={{ display: 'block', marginTop: 8 }}>
                If your wallet does not auto-fill the memo, set it to{' '}
                <span className="mono">{invoice.memo}</span> and send the exact amount. This
                escrows your collateral with the auctioneer; it is returned to you with your
                proceeds at settlement.
              </span>
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn btn-small" onClick={() => void onRefresh()}>
              Re-check status
            </button>
          </div>
        </>
      )}
      {err && <div className="error-line">{err}</div>}
    </div>
  );
}

/** Winner-only claim of the seller's sealed delivery payload. */
function PayloadClaimPanel({ auctionId, bidId }: { auctionId: string; bidId: string }) {
  const [payload, setPayload] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const claim = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.claimPayload(auctionId, bidId);
      setPayload(res.payload);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel-title">Delivery payload</h2>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 14 }}>
        You hold the winning bid. The seller escrowed a sealed payload with this lot — claim it
        with your bid ID (the only capability that can read it).
      </p>
      {payload === null ? (
        <button className="btn btn-primary" onClick={() => void claim()} disabled={busy}>
          {busy ? 'Claiming…' : 'Claim delivery payload'}
        </button>
      ) : (
        <div className="payload-box">{payload}</div>
      )}
      {err && <div className="error-line">{err}</div>}
    </div>
  );
}

/** Winner's delivery gate: confirm to release the seller's held payout, or
 *  dispute to void the sale (full hammer refund + collateral to the winner). */
function PayoutPanel({
  auction,
  bidId,
  onRefresh,
}: {
  auction: Auction;
  bidId: string | null;
  onRefresh: () => void;
}) {
  const { identity } = useSession();
  const [busy, setBusy] = useState<'confirm' | 'dispute' | 'proof' | 'release' | 'slash' | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [proof, setProof] = useState('');

  const isSeller = !!identity && auction.seller_pubkey === identity.pubkey;
  const winnerBid = (auction.bids ?? []).find((b) => b.id === auction.winner_bid_id);
  const isWinnerIdentity = !!identity && winnerBid?.user_pubkey === identity.pubkey;
  const canResolve = !!identity && !isSeller && !isWinnerIdentity;

  const deadline = auction.payout_deadline
    ? new Date(auction.payout_deadline * 1000).toLocaleString()
    : null;
  const openedAt = auction.dispute_opened_at
    ? new Date(auction.dispute_opened_at * 1000).toLocaleString()
    : null;

  const run = async (fn: () => Promise<unknown>, key: typeof busy) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (auction.payout_state === 'released') {
    return (
      <div className="panel">
        <h2 className="panel-title">Delivery confirmed</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          The seller&apos;s proceeds and collateral have been released. Thank you.
        </p>
      </div>
    );
  }
  if (auction.payout_state === 'slashed') {
    return (
      <div className="panel">
        <h2 className="panel-title">Sale voided</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          The dispute was resolved in the buyer&apos;s favour: the hammer price was refunded in
          full and the seller&apos;s collateral was forfeited to the buyer.
        </p>
      </div>
    );
  }

  if (auction.payout_state === 'disputed') {
    return (
      <div className="panel">
        <h2 className="panel-title">Dispute under review</h2>
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 14 }}>
          The winner reports the lot was not delivered. The seller&apos;s proceeds and collateral
          are frozen — no money moves until a neutral reviewer resolves this, or the digital-lot
          auto-rule fires.
        </p>
        <dl className="kv">
          <dt>Buyer&apos;s claim</dt>
          <dd>{auction.dispute_reason || <span className="muted">No reason given</span>}</dd>
          <dt>Opened</dt>
          <dd className="mono">{openedAt}</dd>
          <dt>Seller&apos;s delivery proof</dt>
          <dd>{auction.delivery_proof || <span className="muted">not submitted</span>}</dd>
          <dt>Auto-resolution</dt>
          <dd>
            {auction.delivery_kind === 'digital'
              ? deadline
                ? `Digital lot — if the winner already claimed the payload, this releases to the seller after ${deadline}.`
                : 'Digital lot — releases to the seller once the payload claim passes its evidence window.'
              : deadline
                ? `Physical lot — a neutral reviewer must resolve before ${deadline}.`
                : 'Physical lot — awaiting a neutral reviewer.'}
          </dd>
        </dl>
        {isSeller && !auction.delivery_proof && (
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="delivery-proof">Submit delivery proof</label>
            <textarea
              id="delivery-proof"
              value={proof}
              onChange={(e) => setProof(e.target.value)}
              placeholder="Tracking number, message log, or payload hash proving delivery"
              rows={3}
            />
            <span className="field-hint">One submission, permanent — shown to the reviewer.</span>
          </div>
        )}
        <div className="chip-row" style={{ marginTop: 12 }}>
          {isSeller && !auction.delivery_proof && (
            <button
              className="btn"
              onClick={() =>
                void run(() => api.submitDeliveryProof(auction.id, proof.trim()), 'proof')
              }
              disabled={busy !== null || !proof.trim()}
            >
              {busy === 'proof' ? 'Submitting…' : 'Submit proof'}
            </button>
          )}
          {canResolve && (
            <>
              <button
                className="btn btn-primary"
                onClick={() =>
                  void run(() => api.resolvePayout(auction.id, 'release'), 'release')
                }
                disabled={busy !== null}
              >
                {busy === 'release' ? 'Releasing…' : 'Release to seller'}
              </button>
              <button
                className="btn"
                onClick={() => void run(() => api.resolvePayout(auction.id, 'slash'), 'slash')}
                disabled={busy !== null}
              >
                {busy === 'slash' ? 'Slashing…' : 'Slash to winner'}
              </button>
            </>
          )}
        </div>
        {err && <div className="error-line">{err}</div>}
      </div>
    );
  }

  if (!bidId || auction.winner_bid_id !== bidId) {
    return (
      <div className="panel">
        <h2 className="panel-title">Payout held</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          The seller&apos;s proceeds and collateral are held until the winner confirms delivery
          {deadline ? ` (auto-releases after ${deadline}).` : '.'}
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2 className="panel-title">Confirm delivery</h2>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 14 }}>
        You won this lot. The seller&apos;s proceeds and collateral are held until you confirm you
        received the goods. Confirm to release them; dispute if the lot never arrived — the payout
        freezes and a neutral reviewer decides.
      </p>
      {deadline && (
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
          If you take no action, the payout releases automatically after{' '}
          <span className="mono">{deadline}</span>.
        </p>
      )}
      <div className="field">
        <label htmlFor="dispute-reason">Reason (only if disputing)</label>
        <input
          id="dispute-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. package marked delivered but nothing arrived"
        />
      </div>
      <div className="chip-row">
        <button
          className="btn btn-primary"
          onClick={() => void run(() => api.confirmPayout(auction.id, bidId), 'confirm')}
          disabled={busy !== null}
        >
          {busy === 'confirm' ? 'Confirming…' : 'Confirm received'}
        </button>
        <button
          className="btn"
          onClick={() =>
            void run(() => api.disputePayout(auction.id, bidId, reason.trim()), 'dispute')
          }
          disabled={busy !== null}
        >
          {busy === 'dispute' ? 'Disputing…' : 'Dispute — not received'}
        </button>
      </div>
      {err && <div className="error-line">{err}</div>}
    </div>
  );
}

/** Seller tools: view hidden reserve + delivery payload via the signed session. */
function SellerPanel({
  auction,
  sellerView,
  onLoad,
}: {
  auction: Auction;
  sellerView: SellerView | null;
  onLoad: (v: SellerView) => void;
}) {
  const { identity } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Only surface the button when the signed-in identity is the listing seller.
  if (!identity || auction.seller_pubkey !== identity.pubkey) {
    return null;
  }

  const load = async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await api.sellerView(auction.id);
      onLoad(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel-title">Seller tools</h2>
      {!open && !sellerView && (
        <button
          className="btn"
          onClick={() => {
            setOpen(true);
            void load();
          }}
          disabled={busy}
        >
          {busy ? 'Verifying…' : 'View sealed seller record'}
        </button>
      )}
      {open && sellerView && (
        <dl className="kv">
          {sellerView.hidden_reserve_zats != null && (
            <>
              <dt>Hidden reserve</dt>
              <dd className="mono">{zatsToZec(sellerView.hidden_reserve_zats)} ZEC</dd>
            </>
          )}
          {sellerView.delivery_payload != null && (
            <>
              <dt>Delivery payload</dt>
              <dd style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {sellerView.delivery_payload}
              </dd>
            </>
          )}
          {sellerView.hidden_reserve_zats == null && sellerView.delivery_payload == null && (
            <>
              <dt>Status</dt>
              <dd>No hidden reserve or delivery payload on this lot.</dd>
            </>
          )}
        </dl>
      )}
      {open && !sellerView && !err && (
        <span className="field-hint" style={{ display: 'block', marginTop: 8 }}>
          {busy ? 'Checking signed session…' : 'Load failed — try again.'}
        </span>
      )}
      {err && <div className="error-line">{err}</div>}
      {auction.status === 'settled' && auction.sold && (
        <ContactPanel auction={auction} role="seller" />
      )}
    </div>
  );
}

/**
 * Post-settlement contact exchange. Each side escrows a contact note that
 * only the counterparty can read: the seller writes and reads via their
 * signed session, the winning bidder via the winning bid ID (the
 * capability). One-shot per side, so neither party can swap details after
 * the other has seen them.
 */
function ContactPanel({ auction, bidId, role }: {
  auction: Auction;
  bidId?: string;
  role: 'seller' | 'winner';
}) {
  const [note, setNote] = useState('');
  const [counterparty, setCounterparty] = useState<string | null>(null);
  const [escrowed, setEscrowed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = role === 'seller'
        ? await api.getSellerContact(auction.id)
        : await api.claimContact(auction.id, bidId!);
      setCounterparty(res.counterparty_contact);
      setEscrowed(
        role === 'seller'
          ? res.seller_contact_escrowed ?? false
          : res.winner_contact_escrowed ?? false,
      );
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = role === 'seller'
        ? await api.setSellerContact(auction.id, note.trim())
        : await api.setWinnerContact(auction.id, bidId!, note.trim());
      setCounterparty(res.counterparty_contact);
      setEscrowed(true);
      setLoaded(true);
      setNote('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel-title">Contact exchange</h2>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 14 }}>
        A private channel that opens once the hammer falls. Escrow a note the{' '}
        {role === 'seller' ? 'winner' : 'seller'} can read — and read theirs in return.
        Never public. One-shot: it cannot be changed once seen.
      </p>
      {!loaded && (
        <button className="btn" onClick={() => void load()} disabled={busy}>
          {busy ? 'Checking…' : 'Read counterparty contact'}
        </button>
      )}
      {loaded && counterparty && (
        <div className="payload-box">{counterparty}</div>
      )}
      {loaded && !counterparty && (
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 14 }}>
          The {role === 'seller' ? 'winner' : 'seller'} has not escrowed a contact note yet.
        </p>
      )}
      {(!escrowed || !counterparty) && (
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor={`contact-${role}`}>Your contact note</label>
          <input
            id={`contact-${role}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Telegram @handle, email, or Signal number"
            maxLength={300}
            disabled={busy}
          />
          <button
            className="btn btn-primary"
            style={{ marginTop: 10 }}
            onClick={() => void save()}
            disabled={busy || !note.trim()}
          >
            {busy ? 'Escrowing…' : 'Escrow contact note'}
          </button>
        </div>
      )}
      {err && <div className="error-line">{err}</div>}
    </div>
  );
}

function BidPanel({
  auction,
  onBid,
  existingBid,
}: {
  auction: Auction;
  onBid: (bidId: string) => void;
  existingBid?: BidStatus | null;
}) {
  const { identity } = useSession();
  const auctionId = auction.id;
  const binPriceZats = auction.bin_price_zats;
  const [amount, setAmount] = useState('');
  const [refundAddress, setRefundAddress] = useState('');
  const [refundDirty, setRefundDirty] = useState(false);
  const [buyNow, setBuyNow] = useState(false);
  const [invoice, setInvoice] = useState<{ bidId: string; uri: string; memo: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [paidTxid, setPaidTxid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [net, setNet] = useState<string | null>(null);
  // A live bid on this lot means the amount field adds to the deposit the
  // identity already escrowed rather than opening a second position.
  const liveBid =
    existingBid && ['registered', 'detected', 'confirmed'].includes(existingBid.status)
      ? existingBid
      : null;
  const escrowedZats = liveBid
    ? (liveBid.confirmed_amount_zats ?? liveBid.registered_amount_zats)
    : 0;

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (!cancelled) setNet(h.network);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Default the refund address to this identity's hosted address, so a judge
  // never has to paste an address they do not have anywhere else to read.
  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    api
      .wallet()
      .then((w) => {
        if (!cancelled && w.address && !refundDirty) setRefundAddress(w.address);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [identity, refundDirty]);

  const collateralPending = auction.collateral_zats > 0 && auction.collateral_txid === null;

  const registerBid = async (isBuyNow = false) => {
    const res = await api.placeBid(auctionId, {
      refund_address: refundAddress.trim(),
      amount_zec: isBuyNow && binPriceZats != null ? zatsToZec(binPriceZats) : amount.trim(),
      buy_now: isBuyNow || undefined,
    });
    setInvoice({ bidId: res.bid_id, uri: res.zip321_uri, memo: res.memo });
    onBid(res.bid_id);
    return res;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerBid(buyNow);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const payWithHosted = async () => {
    if (!invoice) return;
    setPayBusy(true);
    setPayError(null);
    try {
      const res = await api.payBid(invoice.bidId);
      setPaidTxid(res.txid);
    } catch (err) {
      setPayError(friendlyWalletError(err));
    } finally {
      setPayBusy(false);
    }
  };

  const copy = async () => {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Clipboard blocked — select the URI below and copy manually.');
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2 className="panel-title">
        {liveBid
          ? 'Add to your bid'
          : binPriceZats != null
            ? 'Place a sealed bid or buy it now'
            : 'Place a sealed bid'}
      </h2>

      {liveBid && (
        <div
          style={{
            marginBottom: 14,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(245,158,11,0.10)',
            border: '1px solid rgba(245,158,11,0.35)',
            fontSize: 14,
          }}
        >
          You already have <strong>{zatsToZec(escrowedZats)} ZEC</strong> escrowed on this lot.
          Anything you add below is added to that same sealed bid — it does not open a second
          bid, and your existing deposit is never refunded or replaced while the auction is open.
        </div>
      )}

      {collateralPending && (
        <div className="error-line" style={{ marginTop: 0, marginBottom: 14 }}>
          This lot requires seller collateral which has not confirmed yet — sealed bids cannot be
          registered until the seller pays it (panel above).
        </div>
      )}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="bid-amount">{liveBid ? 'Add (ZEC)' : 'Amount (ZEC)'}</label>
          <input
            id="bid-amount"
            value={buyNow && binPriceZats != null ? zatsToZec(binPriceZats) : amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={liveBid ? '0.50' : '1.50'}
            required
            readOnly={buyNow && binPriceZats != null}
            disabled={collateralPending}
          />
          <span className="field-hint">
            {buyNow && binPriceZats != null
              ? 'Buy-it-now price — fixed, no second-price discount.'
              : liveBid
                ? `Added to your existing ${zatsToZec(escrowedZats)} ZEC bid. Minimum 0.1 ZEC. Your wallet pays the network fee on top.`
                : 'Minimum 0.1 ZEC. Your wallet pays the network fee on top.'}
          </span>
        </div>
        <div className="field">
          <label htmlFor="bid-refund">Refund shielded UA</label>
          <input
            id="bid-refund"
            value={refundAddress}
            onChange={(e) => {
              setRefundDirty(true);
              setRefundAddress(e.target.value);
            }}
            placeholder="uregtest1… (receives refund if you lose)"
            required
            disabled={collateralPending}
          />
          <span className="field-hint">
            A shielded UA you control — sealed refunds land here if you lose. Prefilled with your
            hosted wallet address; change it if you would rather be refunded elsewhere.
          </span>
        </div>
      </div>

      {binPriceZats != null && (
        <label
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            margin: '14px 0 0',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          <input
            type="checkbox"
            checked={buyNow}
            onChange={(e) => setBuyNow(e.target.checked)}
            disabled={collateralPending}
            style={{ marginTop: 3 }}
          />
          <span>
            Buy it now for{' '}
            <strong style={{ color: 'var(--amber)' }}>{zatsToZec(binPriceZats)} ZEC</strong> —
            ends the auction immediately, beats every sealed bid, no second-price discount.
          </span>
        </label>
      )}

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || payBusy || collateralPending}
        >
          {busy
            ? 'Issuing…'
            : buyNow && binPriceZats != null
              ? 'Issue buy-it-now invoice'
              : liveBid
                ? 'Issue top-up invoice'
                : 'Issue ZIP-321 invoice'}
        </button>
        {identity && !invoice && (
          <button
            type="button"
            className="btn"
            disabled={busy || payBusy || !refundAddress || (!amount && !buyNow) || collateralPending}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const res = await registerBid(buyNow);
                const paid = await api.payBid(res.bid_id);
                setPaidTxid(paid.txid);
              } catch (err) {
                setError(friendlyWalletError(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Issuing…' : liveBid ? 'Add + pay with hosted wallet' : 'Register + pay with hosted wallet'}
          </button>
        )}
      </div>
      {error && <div className="error-line">{error}</div>}
      {invoice && (
        <div style={{ marginTop: 18 }}>
          {paidTxid ? (
            <div className="success-line">
              Paid from your hosted wallet — tx <TxidLink network={net} txid={paidTxid} />. The
              escrow detector will pick up the memo and confirm your bid.
              {liveBid && ' Your running total on this lot now includes this payment.'}
            </div>
          ) : (
            <>
              <div className="qr-wrap">
                <QRCodeSVG value={invoice.uri} size={220} level="M" includeMargin={false} />
                <div className="uri-line">{invoice.uri}</div>
                <button type="button" className="copy-btn" onClick={copy}>
                  {copied ? 'Copied' : 'Copy invoice'}
                </button>
              </div>
              <div className="success-line">
                Invoice issued for bid <span className="mono">{invoice.bidId}</span>. Pay it from
                any shielded ZEC wallet — the memo carries your bid ID and nothing else.
                {liveBid && ' This payment tops up the sealed bid you already have on this lot.'}
              </div>
              {identity && (
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={payBusy}
                    onClick={payWithHosted}
                  >
                    {payBusy ? 'Sending…' : 'Pay with hosted wallet'}
                  </button>
                </div>
              )}
              {!identity && (
                <span className="field-hint" style={{ display: 'block', marginTop: 8 }}>
                  Sign in to pay this invoice from your hosted wallet — or pay it from any shielded
                  ZEC wallet with the same memo.
                </span>
              )}
              {payError && <div className="error-line">{payError}</div>}
            </>
          )}
        </div>
      )}
    </form>
  );
}
