import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, type Health, type NetworkEntry } from './api';
import { SessionProvider, useSession, friendlyWalletError, newMnemonic } from './session';
import Board from './pages/Board';
import Lot from './pages/Lot';
import Dashboard from './pages/Dashboard';
import Privacy from './pages/Privacy';
import Profile from './pages/Profile';
import Wallet from './pages/Wallet';

/** Seed-phrase sign-in. The phrase is used to sign here and never uploaded. */
function SignInDialog({ onClose }: { onClose: () => void }) {
  const { signIn } = useSession();
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await signIn(seed);
        onClose();
      } catch (e) {
        setError(friendlyWalletError(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div
      className="signin-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="signin-dialog panel" role="dialog" aria-modal="true" aria-label="Sign in">
        <h2 className="panel-title">Sign in with a seed phrase</h2>
        <p className="field-hint">
          Any 12- or 24-word BIP-39 phrase is your identity. You sign a one-time
          challenge with it locally; the phrase itself is never sent anywhere and
          never moves funds — Bidshield's hosted wallet holds the ZEC for this demo.
        </p>
        <div className="field">
          <label htmlFor="seed-input">Seed phrase</label>
          <textarea
            id="seed-input"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="twelve or twenty-four words, separated by spaces"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className="mono"
          />
          <div className="field-hint">
            Remembered in this browser only, so reloading the page keeps you signed in.
          </div>
        </div>
        {error && <div className="error-line">{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            disabled={busy || !seed.trim()}
            onClick={submit}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            className="btn"
            disabled={busy}
            title="Mint a fresh phrase and fill the field"
            onClick={() => {
              setSeed(newMnemonic());
              setError(null);
            }}
          >
            Create a new wallet
          </button>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function SignInButton() {
  const { identity, ephemeral, loading } = useSession();
  const [open, setOpen] = useState(false);

  // An auto-minted read session is not an identity the judge chose — keep
  // offering the seed dialog until they sign in for real.
  if (identity && !ephemeral) {
    return (
      <NavLink to="/profile" className="auth-chip" title={`Signed in as ${identity.pubkey}`}>
        <span className="chain-dot live" />
        <span className="mono">{identity.short}</span>
      </NavLink>
    );
  }

  return (
    <div className="signin-wrap">
      <button
        className="btn btn-primary btn-small"
        disabled={loading}
        title={loading ? 'Checking session…' : 'Sign in with a seed phrase'}
        onClick={() => setOpen(true)}
      >
        {loading ? '…' : 'Sign in'}
      </button>
      {open && <SignInDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

const KNOWN_NETWORKS = ['regtest', 'testnet', 'mainnet'] as const;

/** Header chain badge → network switcher dropdown (session-gated, ready-only). */
function NetworkSwitch({ health }: { health: Health | null }) {
  const { identity } = useSession();
  const [open, setOpen] = useState(false);
  const [nets, setNets] = useState<NetworkEntry[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .networks()
      .then((ns) => {
        if (alive) setNets(ns);
      })
      .catch(() => {
        if (alive) setNets([]);
      });
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Configured profiles first, then synthetic rows for the known networks
  // that have no profile yet (visible so operators know what to configure).
  const rows: { name: string; ready: boolean; active: boolean; configured: boolean }[] = (
    nets ?? []
  ).map((n) => ({
    name: n.name,
    ready: n.ready,
    active: n.active,
    configured: true,
  }));
  for (const name of KNOWN_NETWORKS) {
    if (!rows.some((r) => r.name === name)) {
      rows.push({ name, ready: false, active: false, configured: false });
    }
  }

  const pick = (n: { name: string; ready: boolean; active: boolean; configured: boolean }) => {
    if (n.active) {
      setOpen(false);
      return;
    }
    if (!n.ready) {
      setMsg(
        n.configured
          ? `${n.name} is configured but still syncing — try switching once its node is caught up.`
          : `No ${n.name} profile configured — set NETWORK_${n.name.toUpperCase()}_URL (plus _USER, _PASS, _DB_PATH) in .env and restart the api.`,
      );
      return;
    }
    if (!identity) {
      setMsg('Sign in to switch networks.');
      return;
    }
    setMsg(null);
    setBusyName(n.name);
    api
      .switchNetwork(n.name)
      .then(() => window.setTimeout(() => window.location.reload(), 600))
      .catch((e) => {
        setMsg(e instanceof Error ? e.message : String(e));
        setBusyName(null);
      });
  };

  const label = health
    ? `${health.network[0].toUpperCase()}${health.network.slice(1)}`
    : '…';

  return (
    <div className="net-switch" ref={ref}>
      <button
        type="button"
        className="chain-badge net-trigger"
        title={
          health
            ? `Escrow wallet: ${health.wallet_balance_zats / 1e8} ZEC — click to switch networks`
            : 'API unreachable — click to switch networks'
        }
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`chain-dot${health?.wallet_ready ? ' live' : ''}`} />
        {label}
        <span className="picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="net-menu" role="menu" aria-label="Switch network">
          {rows.map((n) => (
            <button
              key={n.name}
              type="button"
              role="menuitem"
              className="net-menu-item"
              disabled={busyName !== null}
              onClick={() => pick(n)}
            >
              <span className={`net-dot${n.ready ? ' ready' : ''}`} />
              <span className="net-name">{n.name}</span>
              <span className={`wm-status${n.active ? ' detected' : ''}`}>
                {busyName === n.name
                  ? 'switching…'
                  : n.active
                    ? 'active'
                    : n.ready
                      ? 'switch'
                      : n.configured
                        ? 'syncing'
                        : 'not configured'}
              </span>
            </button>
          ))}
          {msg && <div className="net-msg">{msg}</div>}
          <div className="net-msg" style={{ color: 'var(--ink-dim)', borderTop: '1px solid var(--line-soft)' }}>
            {health
              ? `Sign-in and the hosted wallet both target the ${health.network} network.`
              : 'API unreachable — sign-in unavailable until it is back.'}
          </div>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.health();
        if (alive) setHealth(h);
      } catch {
        if (alive) setHealth(null);
      }
    };
    poll();
    const id = setInterval(poll, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <NavLink to="/" className="wordmark">
            Bid<span>shield</span>
          </NavLink>
          <nav className="nav" aria-label="Primary">
            <NavLink to="/" end>
              Board
            </NavLink>
            <NavLink to="/dashboard">Dashboard</NavLink>
            <NavLink to="/wallet">Wallet</NavLink>
            <NavLink to="/privacy">Privacy</NavLink>
            <NavLink to="/profile">Profile</NavLink>
          </nav>
          <NetworkSwitch health={health} />
          <SignInButton />
        </div>
      </header>
      <main className="shell">
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/auctions/:id" element={<Lot />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}

/** Catches render-time crashes so a bug shows a panel, never a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="shell" style={{ paddingTop: 48 }}>
          <div className="error-line">
            <strong>Something broke rendering this page.</strong>
            <br />
            <span className="mono" style={{ fontSize: 12 }}>
              {this.state.error.message}
            </span>
            <br />
            <button
              className="btn btn-small"
              style={{ marginTop: 12 }}
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <SessionProvider>
        <Shell />
      </SessionProvider>
    </ErrorBoundary>
  );
}
