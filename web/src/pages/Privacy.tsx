import { useEffect, useState } from 'react';
import { api, type PrivacyInfo } from '../api';

export default function Privacy() {
  const [info, setInfo] = useState<PrivacyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .privacy()
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Privacy panel</h1>
          <p className="page-sub">
            Rendered from the live API, not a brochure. Every value below is what the running
            system actually enforces right now.
          </p>
        </div>
      </div>

      {error && <div className="error-line">{error}</div>}

      <div className="privacy-grid">
        <div className="privacy-card">
          <h3>Chain observer sees</h3>
          <p>
            <span className="mono">{info?.onchain_view ?? '…'}</span> Shielded outputs to the
            auctioneer UA with indistinguishable ciphertext. Timing and count are visible; amounts,
            addresses and memos are not.
          </p>
        </div>
        <div className="privacy-card">
          <h3>Other bidders see</h3>
          <p>
            <span className="mono">{info?.bid_confidentiality ?? '…'}</span> The board hides bid
            count and amounts until settlement; after the hammer, the ledger is public — that is
            the Vickrey contract.
          </p>
        </div>
        <div className="privacy-card">
          <h3>Auctioneer sees</h3>
          <p>
            Each confirmed bid's amount, refund UA and memo UUID — it must, to escrow and refund.
            It never sees your <em>sending</em> UA: the incoming note is shielded.
          </p>
        </div>
        <div className="privacy-card">
          <h3>Memo channel</h3>
          <p>
            <span className="mono">{info?.memo_channel ?? '…'}</span> Fixed-shape{' '}
            <span className="mono">bid:&lt;uuid&gt;</span>, no free text.
          </p>
        </div>
        <div className="privacy-card">
          <h3>Confirmation policy</h3>
          <p>
            Settlement waits for <span className="mono">{info?.conf_target ?? '…'}</span>{' '}
            confirmations on every bid — matching zecd's stock untrusted depth, so a reorg cannot
            alter an outcome already acted on.
          </p>
        </div>
        <div className="privacy-card">
          <h3>Network posture</h3>
          <p>
            <span className="mono">{info?.ip_logging ?? '…'}</span> {info?.rpc_auth ?? ''} The
            auctioneer RPC never leaves the compose network.
          </p>
        </div>
        <div className="privacy-card">
          <h3>Economics</h3>
          <p>
            Minimum bid <span className="mono">{info?.min_bid_zec ?? '…'} ZEC</span>. Bidshield
            takes a commission of{' '}
            <span className="mono">
              {info ? (info.commission_bps / 100).toFixed(2) : '…'}%
            </span>{' '}
            of the hammer price, deducted from the seller's proceeds only. Every bidder is
            refunded in full — no fee is taken from refunds. The on-chain miner fee is paid
            separately by the auctioneer's own wallet.
          </p>
        </div>
        <div className="privacy-card">
          <h3>Auctioneer UA</h3>
          <p className="mono" style={{ wordBreak: 'break-all' }}>
            {info?.auctioneer_ua ?? '…'}
          </p>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <h2 className="panel-title">The honest residual</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14, maxWidth: '75ch' }}>
          Timing still leaks: an observer can count shielded inflows to the auctioneer UA while an
          auction is open, and correlate the settlement batch. Bidshield's answer is that those
          observations are identical to any other marketplace's shielded wallet activity — there is
          no transparent leg to deanonymize, no amount to read, and no winner to name until the
          auctioneer publishes the settled ledger. The full analysis, including what we deliberately
          do not defend against, lives in <span className="mono">docs/THREAT_MODEL.md</span>.
        </p>
      </div>
    </>
  );
}
