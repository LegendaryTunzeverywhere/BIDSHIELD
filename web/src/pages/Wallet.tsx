import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  zatsToZec,
  type Health,
  type WalletView,
} from '../api';
import { useSession, friendlyWalletError } from '../session';
import TxidLink from '../components/TxidLink';

function amountToZats(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e8);
}

export default function Wallet() {
  const { identity, loading } = useSession();
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetTxid, setFaucetTxid] = useState<string | null>(null);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [sendBusy, setSendBusy] = useState(false);
  const [sendTxid, setSendTxid] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const inflight = useRef(false);
  const pending = useRef(false);
  const loadRef = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    if (!identity) return;
    // Coalesce rather than drop: a refresh requested while one is already in
    // flight must still run, or a post-claim/send update gets lost and the
    // balance sits stale until the next poll.
    if (inflight.current) {
      pending.current = true;
      return;
    }
    inflight.current = true;
    try {
      const w = await api.wallet();
      setWallet(w);
      setWait(w.faucet_ready ? 0 : Math.max(0, w.faucet_wait_secs));
      setLoadError(null);
    } catch (e) {
      setLoadError(friendlyWalletError(e));
    } finally {
      inflight.current = false;
      if (pending.current) {
        pending.current = false;
        loadRef.current();
      }
    }
  }, [identity]);

  useEffect(() => {
    loadRef.current = () => void load();
  }, [load]);

  useEffect(() => {
    if (!identity) {
      setWallet(null);
      return;
    }
    void load();
  }, [identity, load]);

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (alive) setHealth(h);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setInterval(() => setWait((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(t);
  }, [wait]);

  useEffect(() => {
    if (!identity) return;
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15000);
    return () => window.clearInterval(tick);
  }, [identity, load]);

  const claimFaucet = async () => {
    setFaucetBusy(true);
    setFaucetError(null);
    try {
      const res = await api.faucet();
      setFaucetTxid(res.txid);
      await load();
    } catch (e) {
      setFaucetError(friendlyWalletError(e));
    } finally {
      setFaucetBusy(false);
    }
  };

  const copyAddress = async () => {
    if (!wallet?.address) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setSendError('Clipboard blocked — select the address and copy it manually.');
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendError(null);
    setSendTxid(null);

    const destination = to.trim();
    if (destination.length <= 20 || !destination.startsWith('u')) {
      setSendError('Recipient must be a full shielded unified address (starts with "u").');
      return;
    }
    const zats = amountToZats(amount);
    if (zats === null) {
      setSendError('Amount must be a positive number of ZEC.');
      return;
    }
    if (wallet && zats > wallet.balance_zats) {
      setSendError(
        `Insufficient balance: you have ${zatsToZec(wallet.balance_zats)} ZEC and tried to send ${zatsToZec(zats)} ZEC.`,
      );
      return;
    }
    if (memo.length > 512) {
      setSendError('Memo exceeds 512 bytes.');
      return;
    }

    setSendBusy(true);
    try {
      const res = await api.walletSend({
        to: destination,
        amount_zec: amount.trim(),
        memo: memo.trim() || undefined,
      });
      setSendTxid(res.txid);
      setAmount('');
      setMemo('');
      await load();
    } catch (err) {
      setSendError(friendlyWalletError(err));
    } finally {
      setSendBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="panel">
        <h2 className="panel-title">Wallet</h2>
        <div className="field-hint">Checking your session…</div>
      </div>
    );
  }

  if (!identity) {
    return (
      <div className="panel">
        <h2 className="panel-title">Wallet</h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, margin: '0 0 12px' }}>
          Your hosted shielded wallet is tied to your identity. Sign in from the button in the
          top-right corner with any 12- or 24-word seed phrase, then come back here to claim the
          faucet, read your balance and send ZEC.
        </p>
        <p className="field-hint">
          New here? The sign-in dialog can mint a fresh phrase for you — write it down before you
          close the tab.
        </p>
        <div style={{ marginTop: 14 }}>
          <Link className="btn" to="/privacy">
            How the privacy model works
          </Link>
        </div>
      </div>
    );
  }

  if (wallet && !wallet.hosted) {
    return (
      <div className="panel">
        <h2 className="panel-title">Wallet</h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>
          The hosted wallet is not configured for the <strong>{wallet.network}</strong> network.
          Switch the network badge back to regtest to use the demo faucet.
        </p>
      </div>
    );
  }

  const backed =
    health && health.funder_shielded_zats >= health.wallet_ledger_zats
      ? {
          pool: zatsToZec(health.funder_shielded_zats),
          owed: zatsToZec(health.wallet_ledger_zats),
        }
      : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section className="panel">
        <h2 className="panel-title">Hosted wallet</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Shielded address on {wallet ? wallet.network : 'this'} network. This is a hosted,
          custodial demo wallet: the server&apos;s funder holds the notes and moves the ZEC, and
          your seed only authenticates you. Every transfer is a real shielded transaction.
        </p>

        {wallet?.address && (
          <div className="field">
            <label>Your address</label>
            <div className="mono" style={{ fontSize: 13, wordBreak: 'break-all', lineHeight: 1.7 }}>
              {wallet.address}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" className="btn btn-small" onClick={copyAddress}>
                {copied ? 'Copied' : 'Copy address'}
              </button>
            </div>
          </div>
        )}

        <div className="kv" style={{ marginTop: 18 }}>
          <dt>Balance</dt>
          <dd>
            <span className="mono" style={{ fontSize: 26, color: 'var(--amber)' }}>
              {wallet ? zatsToZec(wallet.balance_zats) : '0.00000000'}
            </span>{' '}
            <span className="field-hint">ZEC</span>
            {wallet && (
              <div className="field-hint mono" style={{ marginTop: 4 }}>
                {wallet.balance_zats} zats
              </div>
            )}
          </dd>
        </div>

        {loadError && <div className="error-line">{loadError}</div>}
        {backed && (
          <div className="field-hint" style={{ marginTop: 10 }}>
            Backed by {backed.pool} ZEC of unspent shielded notes covering {backed.owed} ZEC of
            user balances.
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Faucet</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Regtest ZEC for the demo. One claim per identity per cooldown.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={faucetBusy || wait > 0 || !wallet?.faucet_ready}
            onClick={claimFaucet}
          >
            {faucetBusy
              ? 'Sending…'
              : wait > 0
                ? `Available in ${wait}s`
                : `Claim ${wallet ? zatsToZec(wallet.faucet_zats) : ''} ZEC`}
          </button>
          {faucetTxid && (
            <span className="field-hint">
              sent · <TxidLink network={wallet?.network ?? null} txid={faucetTxid} />
            </span>
          )}
        </div>
        {faucetError && <div className="error-line">{faucetError}</div>}
      </section>

      <section className="panel">
        <h2 className="panel-title">Send</h2>
        <form onSubmit={send}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="send-to">Recipient</label>
              <input
                id="send-to"
                className="mono"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="uregtest1… or utest1…"
                spellCheck={false}
                autoComplete="off"
              />
              <span className="field-hint">A full shielded unified address.</span>
            </div>
            <div className="field">
              <label htmlFor="send-amount">Amount (ZEC)</label>
              <input
                id="send-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.05"
                inputMode="decimal"
              />
              <span className="field-hint">
                Available: {wallet ? zatsToZec(wallet.balance_zats) : '0'} ZEC
              </span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="send-memo">Memo (optional)</label>
            <input
              id="send-memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="encrypted on chain, readable only by the recipient"
              maxLength={512}
            />
          </div>
          <div className="btn-row" style={{ marginTop: 4 }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={sendBusy || faucetBusy || !to.trim() || !amount.trim()}
            >
              {sendBusy ? 'Sending…' : 'Send shielded'}
            </button>
            {sendTxid && (
              <span className="field-hint">
                sent · <TxidLink network={wallet?.network ?? null} txid={sendTxid} />
              </span>
            )}
          </div>
          {sendError && <div className="error-line">{sendError}</div>}
        </form>
      </section>
    </div>
  );
}
