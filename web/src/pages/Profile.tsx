import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  zatsToZec,
  shortId,
  type Bid,
  type Health,
  type NetworkEntry,
  type WalletView,
} from '../api';
import { useSession, isValidSeed, newMnemonic, friendlyWalletError } from '../session';
import FlapText from '../components/FlapText';

export default function Profile() {
  const { identity, loading, storedSeed, signIn, signOut, forgetSeed } = useSession();
  const [bids, setBids] = useState<Bid[] | null>(null);
  const [seedInput, setSeedInput] = useState('');
  const [signInError, setSignInError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBids = useCallback(async () => {
    if (!identity) return;
    try {
      const res = await fetch('/api/me/bids');
      if (res.ok) setBids((await res.json()) as Bid[]);
    } catch {
      setBids([]);
    }
  }, [identity]);

  useEffect(() => {
    loadBids();
  }, [loadBids]);

  if (loading) {
    return <div className="empty-board">Loading session…</div>;
  }

  if (!identity) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">
              <FlapText text="Profile" />
            </h1>
            <p className="page-sub">
              Bidshield identities are self-asserted from a seed phrase. No emails, no
              passwords — any 12- or 24-word BIP-39 phrase is an identity. The browser
              signs a one-time nonce locally; the phrase is never uploaded and never
              controls funds.
            </p>
          </div>
        </div>

        <div className="panel">
          <h2 className="panel-title">Sign in</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Paste your phrase below. The browser derives the signing key, signs a one-time
            challenge, and the server verifies the signature and issues a session cookie.
            The phrase itself never leaves this page.
          </p>
          <div className="field">
            <label htmlFor="seed-input">Seed phrase</label>
            <textarea
              id="seed-input"
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value)}
              placeholder="twelve or twenty-four words, separated by spaces"
              rows={4}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              className="mono"
            />
            <div className="field-hint">
              The phrase is remembered in this browser (localStorage key{' '}
              <code className="mono">bidshield:seed</code>), so reloading the page keeps
              you signed in.
            </div>
          </div>
          {seedInput.trim() !== '' && !isValidSeed(seedInput) && (
            <div className="error-line">
              Not a valid BIP-39 phrase — check the spelling and the word count.
            </div>
          )}
          {signInError && <div className="error-line">{signInError}</div>}
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button
              className="btn btn-primary"
              disabled={busy || !isValidSeed(seedInput)}
              onClick={async () => {
                setBusy(true);
                setSignInError(null);
                try {
                  await signIn(seedInput);
                } catch (e) {
                  setSignInError(friendlyWalletError(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              className="btn"
              disabled={busy}
              title="Mint a fresh phrase into the box above"
              onClick={() => {
                setSeedInput(newMnemonic());
                setSignInError(null);
              }}
            >
              Create a new wallet
            </button>
          </div>
          <p className="field-hint" style={{ marginTop: 14 }}>
            &quot;Create a new wallet&quot; mints a fresh phrase into the box above — write
            it down before you sign in. It is the only way back into this identity.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <FlapText text="Profile" tone="open" />
          </h1>
          <p className="page-sub">
            Your session is bound to a seed-phrase identity. The phrase authenticates you;
            the ZEC lives in the hosted wallet on the Wallet page.
          </p>
        </div>
        <button className="btn btn-ghost btn-small" onClick={() => signOut()}>
          Sign out
        </button>
      </div>

      <div className="panel">
        <h2 className="panel-title">Identity</h2>
        <dl className="kv">
          <dt>Short id</dt>
          <dd>
            <span className="badge mono">{identity.short}</span>
          </dd>
          <dt>Public key</dt>
          <dd className="mono" style={{ wordBreak: 'break-all' }}>
            {identity.pubkey}
          </dd>
          <dt>First seen</dt>
          <dd>{new Date(identity.first_seen * 1000).toLocaleString()}</dd>
          <dt>Last seen</dt>
          <dd>{new Date(identity.last_seen * 1000).toLocaleString()}</dd>
          <dt>Sign-ins</dt>
          <dd>{identity.sign_in_count}</dd>
          <dt>Session expires</dt>
          <dd>{new Date(identity.expires_at * 1000).toLocaleString()}</dd>
        </dl>
        <p className="field-hint" style={{ marginTop: 14 }}>
          The phrase signed a one-time nonce locally to open this session. The server
          stores only the derived public key and session metadata — no IP addresses, no
          analytics, and never the phrase itself.
        </p>
      </div>

      <SeedSecurityPanel
        storedSeed={storedSeed}
        forgetSeed={forgetSeed}
        signOut={signOut}
      />

      <HostedWalletPanel />

      <div className="panel">
        <h2 className="panel-title">Your bids</h2>
        {bids === null ? (
          <p className="muted">Loading…</p>
        ) : bids.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No bids registered under this identity yet. Open the{' '}
            <Link to="/" style={{ color: 'var(--amber)' }}>
              board
            </Link>{' '}
            to find a lot.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Auction</th>
                <th>Bid</th>
                <th>Status</th>
                <th>Refund</th>
              </tr>
            </thead>
            <tbody>
              {bids.map((b) => (
                <tr key={b.id}>
                  <td data-label="Auction">
                    <Link
                      to={`/auctions/${b.auction_id}`}
                      className="mono"
                      style={{ color: 'var(--amber)' }}
                    >
                      {shortId(b.auction_id)}
                    </Link>
                  </td>
                  <td className="mono" data-label="Bid">
                    {zatsToZec(b.registered_amount_zats)} ZEC
                  </td>
                  <td data-label="Status">
                    <FlapText text={b.status} />
                    {b.status === 'won' && (
                      <span className="you-won-mark" role="status">
                        YOU WON
                      </span>
                    )}
                  </td>
                  <td className="mono" data-label="Refund">
                    {b.refund_amount_zats != null
                      ? `${zatsToZec(b.refund_amount_zats)} ZEC`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <NetworkCard />
    </>
  );
}

function SeedSecurityPanel({
  storedSeed,
  forgetSeed,
  signOut,
}: {
  storedSeed: string | null;
  forgetSeed: () => void;
  signOut: () => Promise<void>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const copySeed = async () => {
    if (!storedSeed) return;
    try {
      await navigator.clipboard.writeText(storedSeed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel-title">Seed security</h2>
      {storedSeed ? (
        <dl className="kv" style={{ marginTop: 0 }}>
          <dt>Remembered on this device</dt>
          <dd>
            <span className="badge">stored</span>{' '}
            <span className="field-hint" style={{ display: 'inline' }}>
              {storedSeed.trim().split(/\s+/).length} words
            </span>
          </dd>
        </dl>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          No seed is remembered on this device. The next visit will ask for the phrase
          again.
        </p>
      )}

      {storedSeed && (
        <>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button
              className="btn btn-small"
              onClick={() => {
                setRevealed((v) => !v);
                setCopied(false);
              }}
            >
              {revealed ? 'Hide phrase' : 'Reveal phrase'}
            </button>
            {revealed && (
              <button className="btn btn-small" onClick={copySeed}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          {revealed && (
            <code
              className="mono"
              style={{
                display: 'block',
                marginTop: 12,
                padding: '12px 14px',
                background: 'var(--seam)',
                border: '1px solid var(--line-soft)',
                borderRadius: 6,
                fontSize: 13,
                lineHeight: 1.6,
                wordBreak: 'break-word',
                color: 'var(--ink)',
              }}
            >
              {storedSeed}
            </code>
          )}
        </>
      )}

      <div className="btn-row" style={{ marginTop: 16 }}>
        {storedSeed && (
          <button
            className="btn"
            onClick={() => {
              forgetSeed();
              setRevealed(false);
              setCopied(false);
            }}
          >
            Forget on this device
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => signOut()}>
          Sign out
        </button>
      </div>

      {storedSeed && (
        <p className="field-hint" style={{ marginTop: 12 }}>
          Forgetting stops this browser from remembering the phrase. The current session
          stays open; the next visit will ask for the phrase again.
        </p>
      )}

      <p className="field-hint" style={{ marginTop: 12 }}>
        Honest note: the remembered phrase is stored unencrypted in this browser&apos;s
        localStorage. Anyone with access to this browser profile can read it. That is
        acceptable for a regtest demo; it would not be for real funds.
      </p>
    </div>
  );
}

function HostedWalletPanel() {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .wallet()
      .then((w) => {
        if (alive) setWallet(w);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="panel">
      <h2 className="panel-title">Hosted wallet</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Funds for this identity live at a shielded address the server mints, moved by a
        hosted funder zecd — the seed phrase only authenticates you; it never controls
        funds. Balance, faucet and sends are managed on the{' '}
        <Link to="/wallet" style={{ color: 'var(--amber)' }}>
          Wallet
        </Link>{' '}
        page.
      </p>
      <dl className="kv">
        <dt>Shielded address</dt>
        <dd className="mono" style={{ wordBreak: 'break-all' }}>
          {wallet?.address ?? '…'}
        </dd>
        <dt>Balance</dt>
        <dd className="mono">
          {wallet ? `${zatsToZec(wallet.balance_zats)} ZEC` : '…'}
        </dd>
      </dl>
      {error && <div className="error-line">{error}</div>}
      <div className="btn-row" style={{ marginTop: 14 }}>
        <Link to="/wallet" className="btn btn-primary">
          Open Wallet
        </Link>
      </div>
    </div>
  );
}

function NetworkCard() {
  const { identity } = useSession();
  const [networks, setNetworks] = useState<NetworkEntry[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nets, h] = await Promise.all([api.networks(), api.health()]);
      setNetworks(nets);
      setHealth(h);
      setSelected(nets.find((n) => n.active)?.name ?? '');
    } catch {
      setErr('Could not load network profiles.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doSwitch = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await api.switchNetwork(selected);
      setMsg(`Switched to ${res.active} (${res.chain}). Reloading…`);
      // Auctioneer address, balances, and board data are all per-network —
      // a clean reload is the honest way to pick up the new chain.
      window.setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel-title">Network</h2>
      <dl className="kv">
        <dt>Active chain</dt>
        <dd>
          {health ? (
            <span className="mono">
              {health.network} · {health.chain}
            </span>
          ) : (
            '…'
          )}
        </dd>
        <dt>Escrow address</dt>
        <dd className="mono" style={{ wordBreak: 'break-all' }}>
          {health?.auctioneer_ua ?? '…'}
        </dd>
        <dt>Configured profiles</dt>
        <dd>
          {networks === null
            ? '…'
            : networks.map((n) => (
                <span
                  key={n.name}
                  style={{
                    marginRight: 10,
                    color: n.active ? 'var(--green)' : n.ready ? undefined : '#888',
                  }}
                >
                  {n.name}
                  {n.active ? ' (active)' : ''}
                  {!n.ready ? ' — syncing' : ''}
                </span>
              ))}
        </dd>
      </dl>

      {networks !== null && networks.length > 1 && (
        <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
          <label htmlFor="net-switch" style={{ fontSize: '0.9em' }}>
            Switch to
          </label>
          <select
            id="net-switch"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{
              background: 'var(--panel, #14171c)',
              color: 'inherit',
              border: '1px solid var(--line-soft, #2a2f36)',
              borderRadius: 6,
              padding: '7px 10px',
            }}
          >
            {networks.map((n) => (
              <option key={n.name} value={n.name} disabled={!n.ready}>
                {n.name} ({n.chain}){n.ready ? '' : ' — syncing'}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={busy || !identity} onClick={doSwitch}>
            {busy ? 'Switching…' : 'Switch network'}
          </button>
          {!identity && (
            <span className="field-hint">Sign in to switch — it is an operator action.</span>
          )}
        </div>
      )}
      {msg && <div className="success-line" style={{ marginTop: 10 }}>{msg}</div>}
      {err && <div className="error-line">{err}</div>}
      <p className="field-hint" style={{ marginTop: 12 }}>
        Regtest ships with the stack. Testnet and mainnet are opt-in compose profiles —
        enable them via <code>NETWORK_TESTNET_URL</code> / <code>NETWORK_MAINNET_URL</code>{' '}
        in <code>.env</code> (plus RPC credentials and a separate database per chain; see
        the README), then a row appears here and shows <em>syncing</em> until its node
        finishes the initial sync, then becomes switchable. Each chain keeps its own
        escrow wallet and auction board.
      </p>
    </div>
  );
}
