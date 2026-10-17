import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { API_BASE } from './apibase';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

export interface AuthIdentity {
  pubkey: string;
  short: string;
  first_seen: number;
  last_seen: number;
  sign_in_count: number;
  expires_at: number;
}

interface AuthMe {
  authenticated: boolean;
  identity: AuthIdentity | null;
}

/** Where this browser remembers a seed so a reload does not log you out. */
const SEED_KEY = 'bidshield:seed';

/** Zcash BIP-44 coin type. One account, no index juggling for the demo. */
const DERIVATION = "m/44'/133'/0'/0/0";

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Bitcoin-style CompactSize — the length prefix `auth.rs` reads. */
function compactSize(n: number): Uint8Array {
  if (n < 253) return Uint8Array.of(n);
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    new DataView(b.buffer).setUint16(1, n, true);
    return b;
  }
  const b = new Uint8Array(9);
  b[0] = 0xff;
  new DataView(b.buffer).setBigUint64(1, BigInt(n), true);
  return b;
}

/**
 * Sign `message` with a raw private key: same 65-byte `hex([31+recid, r…, s…])`
 * shape `verify_zcash_signature` expects.
 */
function signWithPriv(message: string, priv: Uint8Array): string {
  const prehash = sha256(sha256(messagePayload(message)));
  const sig = secp256k1.sign(prehash, priv, { prehash: false });
  const recid = sig.recovery;
  if (typeof recid !== 'number') {
    throw new Error('signature is missing its recovery id');
  }
  const compact = sig.toCompactRawBytes();
  const out = new Uint8Array(65);
  out[0] = 31 + recid;
  out.set(compact, 1);
  return toHex(out);
}

/**
 * The exact byte string the server recovers from:
 * `compact_size(22) || "Zcash Signed Message:\n" || compact_size(len) || msg`.
 */
function messagePayload(message: string): Uint8Array {
  const header = new TextEncoder().encode('Zcash Signed Message:\n');
  const body = new TextEncoder().encode(message);
  return concatBytes(compactSize(header.length), header, compactSize(body.length), body);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Split a pasted seed phrase into normalized words. */
export function normalizeSeed(input: string): string[] {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when the phrase is a well-formed BIP-39 mnemonic of this wordlist. */
export function isValidSeed(input: string): boolean {
  try {
    return validateMnemonic(normalizeSeed(input).join(' '), wordlist);
  } catch {
    return false;
  }
}

/** A fresh 12-word phrase for a judge who has no wallet yet. */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

/**
 * Derive the signing key and produce the 65-byte `hex([31+recid, r…, s…])`
 * signature `verify_zcash_signature` expects.
 *
 * `prehash: false` is essential: the server recovers from an already-hashed
 * payload, so noble must not hash again. Without it every sign-in mints a
 * different key and the identity silently changes each time.
 */
export function signMessage(message: string, seed: string): string {
  const mnemonic = normalizeSeed(seed).join(' ');
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('That does not look like a valid seed phrase.');
  }
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(DERIVATION);
  const priv = node.privateKey;
  if (!priv) throw new Error('could not derive a key from that seed');
  return signWithPriv(message, priv);
}

/** The identity pubkey this seed signs in as (stable across sign-ins). */
export function seedPubkey(seed: string): string {
  const mnemonic = normalizeSeed(seed).join(' ');
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('That does not look like a valid seed phrase.');
  }
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(DERIVATION);
  if (!node.publicKey) throw new Error('could not derive a key from that seed');
  return toHex(node.publicKey);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionState {
  identity: AuthIdentity | null;
  loading: boolean;
  /** True while the session is an auto-minted throwaway (not a real seed). */
  ephemeral: boolean;
  /** Hostname as the browser sees it — 127.0.0.1 vs localhost matters. */
  hostname: string;
  /** The seed this device remembers, or null when nothing is stored. */
  storedSeed: string | null;
  /** Sign in with a BIP-39 phrase. Also remembers it on this device. */
  signIn: (seed: string) => Promise<AuthIdentity>;
  signOut: () => Promise<void>;
  /** Stop remembering the seed on this device (the session stays open). */
  forgetSeed: () => void;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * Every API read now requires a signed-in session. Browsers that just want to
 * browse the board get an ephemeral throwaway key (never stored — the cookie
 * is the only handle), so the SPA works out of the box while anonymous curl
 * and scrapers face the Zcash-message handshake. Explicit seed sign-in
 * replaces this identity.
 */
export async function mintEphemeralSession(): Promise<AuthIdentity | null> {
  try {
    const nonceRes = await fetch(`${API_BASE}/api/auth/nonce`, {
      credentials: 'include',
    });
    if (!nonceRes.ok) return null;
    const { nonce, message } = await nonceRes.json();
    const priv = crypto.getRandomValues(new Uint8Array(32));
    const signature = signWithPriv(message, priv);
    const verifyRes = await fetch(`${API_BASE}/api/auth/verify`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, signature }),
    });
    if (!verifyRes.ok) return null;
    return (await verifyRes.json()) as AuthIdentity;
  } catch {
    return null;
  }
}

/** Turn a raw sign-in failure into something a judge can act on. */
export function friendlyWalletError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/fetch|network|failed to fetch/i.test(raw)) {
    return 'Could not reach the Bidshield API — is the stack running?';
  }
  return raw;
}

function readStoredSeed(): string | null {
  try {
    const s = localStorage.getItem(SEED_KEY);
    return s && s.trim() ? s : null;
  } catch {
    return null;
  }
}

function rememberSeed(seed: string | null): void {
  try {
    if (seed) localStorage.setItem(SEED_KEY, seed.trim());
    else localStorage.removeItem(SEED_KEY);
  } catch {
    /* private mode */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [ephemeral, setEphemeral] = useState(false);
  const [storedSeed, setStoredSeed] = useState<string | null>(() => readStoredSeed());

  const refresh = useCallback(async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          credentials: 'include',
          signal: ctrl.signal,
        });
        const me: AuthMe = await res.json();
        setIdentity(me.authenticated ? me.identity : null);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      setIdentity(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signIn = useCallback(async (seed: string): Promise<AuthIdentity> => {
    const mnemonic = normalizeSeed(seed).join(' ');
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error('That does not look like a valid seed phrase.');
    }
    const nonceRes = await fetch(`${API_BASE}/api/auth/nonce`, {
      credentials: 'include',
    });
    if (!nonceRes.ok) throw new Error('could not obtain sign-in nonce');
    const { nonce, message } = await nonceRes.json();

    const signature = signMessage(message, mnemonic);

    const verifyRes = await fetch(`${API_BASE}/api/auth/verify`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, signature }),
    });
    if (!verifyRes.ok) {
      const body = await verifyRes.json().catch(() => ({}));
      throw new Error(body.error ?? `verification failed (${verifyRes.status})`);
    }
    const id: AuthIdentity = await verifyRes.json();
    rememberSeed(mnemonic);
    setStoredSeed(mnemonic);
    setIdentity(id);
    setEphemeral(false);
    return id;
  }, []);

  const signOut = useCallback(async () => {
    await fetch(`${API_BASE}/api/auth/logout`, {
      credentials: 'include',
      method: 'POST',
    }).catch(() => undefined);
    // An explicit sign-out detaches this device: keep remembering the phrase
    // and the next visit silently re-signs the same identity — the judge
    // signs out only to watch their wallet reappear.
    rememberSeed(null);
    setStoredSeed(null);
    setIdentity(null);
    // Reads are session-gated: mint a fresh throwaway so the board stays
    // browsable. It is never presented as an identity (the header chip and
    // both wallet panels hide while `ephemeral` is set).
    const id = await mintEphemeralSession();
    setIdentity(id);
    setEphemeral(!!id);
  }, []);

  const forgetSeed = useCallback(() => {
    rememberSeed(null);
    setStoredSeed(null);
  }, []);

  // Fetch the session once on mount (and on explicit refresh() calls).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A remembered seed means a reload should not log the judge out: re-open
  // the session silently, and only then. Cookies that are still valid skip
  // this entirely, so a normal refresh costs no sign-in requests.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (loading || identity || !storedSeed || resumedRef.current) return;
    resumedRef.current = true;
    void signIn(storedSeed).catch(() => {
      // Bad stored seed (or a rate limit): fall back to the signed-out view.
      rememberSeed(null);
      setStoredSeed(null);
    });
  }, [loading, identity, storedSeed, signIn]);

  // Every API read is session-gated. Browsers with no seed get an ephemeral
  // throwaway identity so the board still loads; the header keeps showing
  // "Sign in" (see SignInButton) until a real seed is used.
  const mintedRef = useRef(false);
  useEffect(() => {
    if (loading || identity || storedSeed || mintedRef.current) return;
    mintedRef.current = true;
    void mintEphemeralSession().then((id) => {
      setIdentity(id);
      setEphemeral(!!id);
    });
  }, [loading, identity, storedSeed]);

  const value = useMemo(
    () => ({
      identity,
      loading,
      ephemeral,
      hostname: window.location.hostname,
      storedSeed,
      signIn,
      signOut,
      refresh,
      forgetSeed,
    }),
    [identity, loading, ephemeral, storedSeed, signIn, signOut, refresh, forgetSeed],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
