// Raising a sealed bid tops up the deposit the bidder already escrowed rather
// than opening a second competing position against itself. Covers: the same
// bid id + memo are reused, the invoice is for the increment only, the running
// total grows additively, the detector sums every payment under the memo, and
// a fully-funded bid refuses a further payment.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');

const BASE = 'http://127.0.0.1:8080';
const sha256d = (b) => sha256(sha256(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zats = (zec) => Math.round(Number(zec) * 1e8);

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

async function placeBid(cookie, auctionId, amountZec, refundAddress) {
  return api(
    `/api/auctions/${auctionId}/bids`,
    {
      method: 'POST',
      body: JSON.stringify({ refund_address: refundAddress, amount_zec: amountZec }),
    },
    cookie,
  );
}

// Waits until the bid is confirmed *and* its escrowed amount has reached the
// expected sum. Waiting only on `status === 'confirmed'` is not enough after a
// top-up: the bid is already confirmed from the prior deposit, so the check
// would pass before the detector has summed the new payment.
async function waitForConfirmedAmount(bidId, cookie, expectedZats, label) {
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const b = await api(`/api/bids/${bidId}`, {}, cookie);
    if (b.body?.status === 'confirmed' && b.body?.confirmed_amount_zats === expectedZats) {
      return b.body;
    }
  }
  const b = await api(`/api/bids/${bidId}`, {}, cookie);
  throw new Error(
    `${label}: never reached confirmed amount ${expectedZats} (status=${b.body?.status} amount=${b.body?.confirmed_amount_zats})`,
  );
}

async function main() {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check(health.ok, 'api ready', `conf_target=${health.conf_target}`);

  const seller = await signIn(randomBytes(32));
  const bidder = await signIn(randomBytes(32));

  const sw = await api('/api/wallet', {}, seller.cookie);
  const auction = (
    await api(
      '/api/auctions',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Top-up smoke lot',
          description: 'Proves raising a bid adds to the existing deposit.',
          reserve_zec: '0.05000000',
          duration_secs: 900,
          seller_address: sw.body.address,
        }),
      },
      seller.cookie,
    )
  ).body;
  check(auction?.status === 'open', 'auction created', auction?.id);

  const bw = await api('/api/wallet', {}, bidder.cookie);
  const bidderAddr = bw.body.address;
  const bf = await api('/api/wallet/faucet', { method: 'POST' }, bidder.cookie);
  check(bf.res.status === 200, 'bidder faucet claimed', `got ${bf.res.status}`);
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const w = await api('/api/wallet', {}, bidder.cookie);
    if (w.body?.balance_zats > 0) break;
  }

  // --- 1. initial bid ---
  const r1 = await placeBid(bidder.cookie, auction.id, '0.10000000', bidderAddr);
  check(r1.res.status === 201, 'initial bid registered', `got ${r1.res.status}`);
  const bidId = r1.body.bid_id;
  check(typeof bidId === 'string' && bidId.length > 0, 'bid id returned', bidId);
  check(r1.body.memo === `bid:${bidId}`, 'memo matches bid id', r1.body.memo);
  check(r1.body.amount_zats === zats('0.1'), 'invoice is for 0.1', `${r1.body.amount_zats}`);
  check(
    r1.body.registered_amount_zats === zats('0.1'),
    'registered total starts at 0.1',
    `${r1.body.registered_amount_zats}`,
  );

  let pay = await api(`/api/bids/${bidId}/pay`, { method: 'POST' }, bidder.cookie);
  check(pay.res.status === 200, 'initial pay 200', `got ${pay.res.status}`);
  let st = await waitForConfirmedAmount(bidId, bidder.cookie, zats('0.1'), 'initial');
  check(
    st.confirmed_amount_zats === zats('0.1'),
    'initial deposit confirmed at 0.1',
    `${st.confirmed_amount_zats}`,
  );

  // --- 2. top-up: same bid id + memo, invoice for the increment only ---
  const r2 = await placeBid(bidder.cookie, auction.id, '0.10000000', bidderAddr);
  check(r2.res.status === 201, 'top-up 1 accepted', `got ${r2.res.status}`);
  check(r2.body.bid_id === bidId, 'top-up reuses the SAME bid id', `${r2.body.bid_id} vs ${bidId}`);
  check(r2.body.memo === `bid:${bidId}`, 'top-up reuses the SAME memo', r2.body.memo);
  check(r2.body.amount_zats === zats('0.1'), 'top-up invoice is for the increment (0.1)', `${r2.body.amount_zats}`);
  check(
    r2.body.registered_amount_zats === zats('0.2'),
    'registered total grew to 0.2',
    `${r2.body.registered_amount_zats}`,
  );

  pay = await api(`/api/bids/${bidId}/pay`, { method: 'POST' }, bidder.cookie);
  check(pay.res.status === 200, 'top-up 1 pay 200', `got ${pay.res.status} ${JSON.stringify(pay.body)?.slice(0, 120)}`);
  st = await waitForConfirmedAmount(bidId, bidder.cookie, zats('0.2'), 'top-up 1');
  check(
    st.confirmed_amount_zats === zats('0.2'),
    'deposit is the SUM of both payments (0.2), not a replacement',
    `${st.confirmed_amount_zats}`,
  );

  // --- 3. second top-up, uneven amount ---
  const r3 = await placeBid(bidder.cookie, auction.id, '0.15000000', bidderAddr);
  check(r3.body.bid_id === bidId, 'second top-up reuses the SAME bid id');
  check(
    r3.body.registered_amount_zats === zats('0.35'),
    'registered total grew to 0.35',
    `${r3.body.registered_amount_zats}`,
  );
  pay = await api(`/api/bids/${bidId}/pay`, { method: 'POST' }, bidder.cookie);
  check(pay.res.status === 200, 'top-up 2 pay 200', `got ${pay.res.status}`);
  st = await waitForConfirmedAmount(bidId, bidder.cookie, zats('0.35'), 'top-up 2');
  check(
    st.confirmed_amount_zats === zats('0.35'),
    'deposit is the SUM of all three payments (0.35)',
    `${st.confirmed_amount_zats}`,
  );
  check(st.registered_amount_zats === zats('0.35'), 'registered total matches sum', `${st.registered_amount_zats}`);

  // --- 4. a fully-funded bid refuses another payment ---
  pay = await api(`/api/bids/${bidId}/pay`, { method: 'POST' }, bidder.cookie);
  check(
    pay.res.status === 409,
    'fully-funded bid rejects a further payment',
    `got ${pay.res.status} ${JSON.stringify(pay.body)?.slice(0, 120)}`,
  );

  // --- 5. only ONE bid row exists for this identity on this auction ---
  // The auction detail endpoint withholds `bids` until settlement (a privacy
  // property: sealed bids must not leak before the close). Enumerate this
  // identity's own bids instead and filter to this auction.
  const mineRes = await api('/api/me/bids', {}, bidder.cookie);
  const mineOnAuction = (mineRes.body ?? []).filter((b) => b.auction_id === auction.id);
  check(
    mineOnAuction.length === 1 && mineOnAuction[0].id === bidId,
    'exactly one bid row for this identity on this auction',
    `${mineOnAuction.length} rows; ids=${mineOnAuction.map((b) => b.id).join(',')}`,
  );
  check(
    mineOnAuction[0]?.registered_amount_zats === zats('0.35'),
    'that single row carries the full 0.35 registered total',
    `${mineOnAuction[0]?.registered_amount_zats}`,
  );

  // --- 6. a second identity on the same lot still gets its own bid ---
  const rival = await signIn(randomBytes(32));
  const rw = await api('/api/wallet', {}, rival.cookie);
  await api('/api/wallet/faucet', { method: 'POST' }, rival.cookie);
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const w = await api('/api/wallet', {}, rival.cookie);
    if (w.body?.balance_zats > 0) break;
  }
  const rr = await placeBid(rival.cookie, auction.id, '0.05000000', rw.body.address);
  check(rr.res.status === 201, 'rival identity can bid on the same lot', `got ${rr.res.status}`);
  check(rr.body.bid_id !== bidId, 'rival gets a DIFFERENT bid id', rr.body.bid_id);

  console.log(failures === 0 ? '\nTOP-UP SMOKE GREEN' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('topup smoke crashed:', e);
  process.exit(1);
});
