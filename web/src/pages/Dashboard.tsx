import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, shortId, zatsToZec, type Dashboard as DashboardData } from '../api';
import FlapText from '../components/FlapText';
import TxidLink from '../components/TxidLink';
import { useSession } from '../session';

export default function Dashboard() {
  const { ready } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (alive) setNetwork(h.network);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setData(await api.dashboard());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [ready, refresh]);

  const act = async (auctionId: string, action: 'close' | 'settle') => {
    setBusyId(`${action}:${auctionId}`);
    setActionError(null);
    try {
      if (action === 'close') await api.closeAuction(auctionId);
      else await api.settleAuction(auctionId);
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Operations</h1>
          <p className="page-sub">
            Auctioneer view: escrow wallet, bid states, and the close/settle levers. This page is
            the operator's console — bidders never need it.
          </p>
        </div>
        <div className="cell-mono">
          Escrow: {data ? `${zatsToZec(data.wallet_balance_zats)} ZEC` : '…'}
        </div>
      </div>

      {error && <div className="error-line">Dashboard unreachable: {error}</div>}
      {actionError && <div className="error-line">{actionError}</div>}

      {!data && !error && <div className="empty-board">Connecting to auctioneer…</div>}

      {data?.auctions.map(({ auction, bids }) => (
        <div className="panel" key={auction.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div>
              <Link to={`/auctions/${auction.id}`} className="lot-name" style={{ fontSize: 19 }}>
                {auction.title} →
              </Link>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                Reserve {zatsToZec(auction.reserve_zats)} ZEC · {bids.length} bid record
                {bids.length === 1 ? '' : 's'} · closes{' '}
                {new Date(auction.closes_at * 1000).toLocaleTimeString()}
              </div>
            </div>
            <div className="btn-row" style={{ alignItems: 'center' }}>
              <FlapText text={auction.status} />
              {auction.status === 'open' && (
                <button
                  className="btn btn-small"
                  disabled={busyId != null}
                  onClick={() => act(auction.id, 'close')}
                >
                  {busyId === `close:${auction.id}` ? 'Closing…' : 'Close early'}
                </button>
              )}
              {(auction.status === 'closed' ||
                (auction.status === 'open' && auction.closes_at * 1000 < Date.now())) && (
                <button
                  className="btn btn-small btn-primary"
                  disabled={busyId != null}
                  onClick={() => act(auction.id, 'settle')}
                >
                  {busyId === `settle:${auction.id}` ? 'Settling…' : 'Settle'}
                </button>
              )}
              {auction.status === 'settled' && auction.settlement_txid && (
                <span className="cell-mono muted" style={{ fontSize: 12 }}>
                  tx <TxidLink network={network} txid={auction.settlement_txid} keep={10} />
                </span>
              )}
            </div>
          </div>

          {bids.length > 0 && (
            <table className="data-table" style={{ marginTop: 16 }}>
              <thead>
                <tr>
                  <th>Bid</th>
                  <th>Registered</th>
                  <th>Escrowed</th>
                  <th>Confs</th>
                  <th>State</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {bids.map((b) => (
                  <tr key={b.id}>
                    <td className="mono" data-label="Bid">{shortId(b.id)}</td>
                    <td className="mono" data-label="Registered">{zatsToZec(b.registered_amount_zats)}</td>
                    <td className="mono" data-label="Escrowed">
                      {b.confirmed_amount_zats != null ? zatsToZec(b.confirmed_amount_zats) : '—'}
                    </td>
                    <td className="mono" data-label="Confs">{b.confirmations}</td>
                    <td data-label="State">
                      <FlapText text={b.status} />
                    </td>
                    <td className="mono" data-label="Tx" style={{ fontSize: 12 }}>
                      {b.txid ? <TxidLink network={network} txid={b.txid} keep={10} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {bids.length === 0 && (
            <p className="muted" style={{ marginBottom: 0, marginTop: 14, fontSize: 14 }}>
              No bids escrowed yet. The detector sweeps the wallet every few seconds.
            </p>
          )}
        </div>
      ))}

      {data && data.auctions.length === 0 && (
        <div className="empty-board">
          <strong>No auctions yet</strong>
          Create one from the board to populate operations.
        </div>
      )}
    </>
  );
}
