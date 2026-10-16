// Hosted-wallet endpoints the frontend's Wallet page and Lot BidPanel call.
// lifecycle.mjs drives zecd directly and never touches these, so this covers
// the gap: /api/wallet, /api/wallet/faucet, /api/wallet/send, /api/bids/:id/pay.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');

const BASE = 'http://127.0.0.1:8080';
const sha256d = (b) => sha256(sha256(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

async function api(path, opts = {}, cookie) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

function compactSize(n) {
  if (n < 253) return Buffer.from([n]);
  const b = Buffer.alloc(3);
  b[0] = 0xfd;
  b.writeUInt16LE(n, 1);
  return b;
}

async function signIn(priv) {
  const pub = secp256k1.getPublicKey(priv, true);
  let nonce, message;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/api/auth/nonce`);
    if (r.status === 429 && attempt < 30) {
      await sleep(3000);
      continue;
    }
    if (!r.ok) throw new Error(`nonce failed: ${r.status}`);
    ({ nonce, message } = await r.json());
    break;
  }
  const payload = Buffer.concat([
    compactSize(22),
    Buffer.from('Zcash Signed Message:\n', 'utf8'),
    compactSize(Buffer.byteLength(message)),
    Buffer.from(message, 'utf8'),
  ]);
  const sig = secp256k1.sign(sha256d(payload), priv);
  const sigBytes = Buffer.concat([
    Buffer.from([31 + sig.recovery]),
    Buffer.from(sig.toCompactRawBytes()),
  ]);
  const verifyRes = await fetch(`${BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, signature: sigBytes.toString('hex') }),
  });
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status}`);
  const cookie = (verifyRes.headers.get('set-cookie') ?? '').split(';')[0];
  return { cookie, pubkey: Buffer.from(pub).toString('hex') };
}

async function main() {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check(health.ok && health.wallet_ready, 'api ready');

  const seller = await signIn(randomBytes(32));
  const bidder = await signIn(randomBytes(32));
  check(true, 'both identities signed in');

  // --- GET /api/wallet ---
  const w0 = await api('/api/wallet', {}, seller.cookie);
  check(w0.res.status === 200, 'GET /api/wallet 200', `got ${w0.res.status}`);
  check(typeof w0.body?.address === 'string' && w0.body.address.startsWith('u'), 'wallet address is shielded UA', w0.body?.address?.slice(0, 12));
  check(typeof w0.body?.balance_zats === 'number', 'balance_zats present');
  check(w0.body?.hosted === true, 'hosted flag true');
  const bal0 = w0.body.balance_zats;

  // --- POST /api/wallet/faucet ---
  const f = await api('/api/wallet/faucet', { method: 'POST' }, seller.cookie);
  check(f.res.status === 200, 'POST /api/wallet/faucet 200', `got ${f.res.status} ${JSON.stringify(f.body)?.slice(0, 120)}`);
  check(typeof f.body?.txid === 'string' && f.body.txid.length >= 16, 'faucet returned txid', f.body?.txid?.slice(0, 16));

  // balance should rise (or faucet_wait_secs should engage on repeat)
  let bal1 = bal0;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const w1 = await api('/api/wallet', {}, seller.cookie);
    if (w1.body?.balance_zats > bal0) {
      bal1 = w1.body.balance_zats;
      break;
    }
  }
  check(bal1 > bal0, 'faucet credited the hosted balance', `${bal0} -> ${bal1}`);

  // --- POST /api/wallet/send (self-send, proves the hosted z_sendmany path) ---
  const s = await api(
    '/api/wallet/send',
    {
      method: 'POST',
      body: JSON.stringify({ to: w0.body.address, amount_zec: '0.01', memo: 'hosted-wallet smoke' }),
    },
    seller.cookie,
  );
  check(s.res.status === 200, 'POST /api/wallet/send 200', `got ${s.res.status} ${JSON.stringify(s.body)?.slice(0, 160)}`);
  check(typeof s.body?.txid === 'string' && s.body.txid.length >= 16, 'send returned txid', s.body?.txid?.slice(0, 16));

  // --- auction + bid + POST /api/bids/:id/pay (Lot "pay with hosted wallet") ---
  const auction = (
    await api(
      '/api/auctions',
      {
        method: 'POST',
        headers: { cookie: seller.cookie },
        body: JSON.stringify({
          title: 'Hosted-wallet pay smoke lot',
          description: 'Proves the rewritten BidPanel pay path.',
          reserve_zec: '0.10000000',
          duration_secs: 600,
          seller_address: w0.body.address,
        }),
      },
    )
  ).body;
  check(auction?.status === 'open', 'auction created', auction?.id);

  const bw0 = await api('/api/wallet', {}, bidder.cookie);
  const bidderAddr = bw0.body.address;
  check(typeof bidderAddr === 'string' && bidderAddr.startsWith('u'), 'bidder has a hosted address');

  // The hosted wallet is per-identity, so the bidder needs its own faucet
  // claim before /pay can move funds.
  const bf = await api('/api/wallet/faucet', { method: 'POST' }, bidder.cookie);
  check(bf.res.status === 200, 'bidder faucet 200', `got ${bf.res.status} ${JSON.stringify(bf.body)?.slice(0, 100)}`);
  let bidderBal = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const w = await api('/api/wallet', {}, bidder.cookie);
    if (w.body?.balance_zats > 0) {
      bidderBal = w.body.balance_zats;
      break;
    }
  }
  check(bidderBal > 0, 'bidder faucet credited', `${bidderBal} zats`);

  const bid = (
    await api(
      `/api/auctions/${auction.id}/bids`,
      {
        method: 'POST',
        headers: { cookie: bidder.cookie },
        body: JSON.stringify({ refund_address: bidderAddr, amount_zec: '0.25000000' }),
      },
    )
  ).body;
  check(typeof bid?.bid_id === 'string', 'bid registered', bid?.bid_id);
  check(typeof bid?.zip321_uri === 'string', 'ZIP-321 invoice returned');
  check(typeof bid?.memo === 'string' && bid.memo.startsWith('bid:'), 'memo is bid:<uuid>', bid?.memo);

  const pay = await api(`/api/bids/${bid.bid_id}/pay`, { method: 'POST' }, bidder.cookie);
  check(pay.res.status === 200, 'POST /api/bids/:id/pay 200', `got ${pay.res.status} ${JSON.stringify(pay.body)?.slice(0, 200)}`);
  check(typeof pay.body?.txid === 'string' && pay.body.txid.length >= 16, 'pay returned txid', pay.body?.txid?.slice(0, 16));

  // poll detection
  const tPaid = Date.now();
  let status = null;
  let confs = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const b = await api(`/api/bids/${bid.bid_id}`, {}, bidder.cookie);
    status = b.body?.status;
    confs = b.body?.confirmations ?? 0;
    if (status === 'confirmed') break;
  }
  const confirmMs = Date.now() - tPaid;
  check(status === 'confirmed', 'hosted-wallet payment reached confirmed', `status=${status} confs=${confs}`);
  check(confirmMs <= 30000, `confirmation within 30s (${(confirmMs / 1000).toFixed(1)}s)`);

  // --- faucet cooldown counts DOWN and re-arms ---
  // Fresh identity: the seller already claimed above and would still be
  // mid-cooldown, which would make these assertions meaningless.
  const cd = await signIn(randomBytes(32));
  const c0 = await api('/api/wallet', {}, cd.cookie);
  check(c0.body?.faucet_ready === true && (c0.body?.faucet_wait_secs ?? -1) === 0,
    'fresh identity: faucet ready, wait=0', `wait=${c0.body?.faucet_wait_secs}`);
  const fc = await api('/api/wallet/faucet', { method: 'POST' }, cd.cookie);
  check(fc.res.status === 200, 'faucet claim accepted', `got ${fc.res.status}`);
  const w1 = await api('/api/wallet', {}, cd.cookie);
  const wait1 = w1.body?.faucet_wait_secs ?? 0;
  check(w1.body?.faucet_ready === false && wait1 > 0, 'cooldown active after claim', `wait=${wait1}`);
  check(wait1 <= 60, 'wait capped at cooldown (60s)', `wait=${wait1}`);
  await sleep(3000);
  const w2 = await api('/api/wallet', {}, cd.cookie);
  const wait2 = w2.body?.faucet_wait_secs ?? 0;
  check(wait2 < wait1, `cooldown counts down (${wait1} -> ${wait2})`);
  check(!w2.body?.faucet_ready, 'still cooling (not spuriously ready)');
  const fc2 = await api('/api/wallet/faucet', { method: 'POST' }, cd.cookie);
  check(fc2.res.status === 429, 'claim inside cooldown still rejected', `got ${fc2.res.status}`);

  console.log(failures === 0 ? '\nHOSTED WALLET SMOKE GREEN' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
