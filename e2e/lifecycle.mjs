import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');

const ROOT = process.cwd();
const COMMISSION_BPS = 500n;
const commission = (priceZats) => (priceZats * COMMISSION_BPS) / 10000n;
const toZats = (zec) => BigInt(Math.round(Number(zec) * 1e8));
const toZec = (zats) => (Number(zats) / 1e8).toFixed(8);
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

async function rpc(port, method, params = [], auth = null, timeoutMs = 30000) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.password}`).toString('base64');
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '1.0', id: 'bidshield', method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const funderAuth = { user: 'funder', password: 'regtest-funder-pw' };
const funderRpc = (m, p = [], t) => rpc(18242, m, p, funderAuth, t);
// Reads are session-gated (anonymous curl must get 401). api() attaches the
// bootstrap identity's cookie to any call that does not pass one explicitly.
let READ_COOKIE = null;
const api = async (path, opts = {}) => {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (!headers.cookie && READ_COOKIE) headers.cookie = READ_COOKIE;
  const res = await fetch(`http://127.0.0.1:8080${path}`, {
    ...opts,
    headers,
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${opts.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
};
let SESSION = null; // set after auth flow; used to bind bids to the identity

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const expect = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`PASS  ${msg}`);
};

async function waitFor(fn, label, timeoutMs = 120000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr}` : ''}`);
}

async function awaitOpid(call, opid, label) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const entries = await call('z_getoperationresult', [[opid]]);
    if (entries.length) {
      const e = entries[0];
      if (e.status === 'success') return e.result.txid;
      if (e.status === 'failed' || e.status === 'invalid') {
        throw new Error(`${label} failed: ${JSON.stringify(e.error)}`);
      }
    }
    await sleep(1000);
  }
  throw new Error(`${label} timed out`);
}

async function main() {
  console.log('=== lifecycle: waiting for api + wallets ===');
  await waitFor(async () => {
    const h = await api('/api/health');
    return h.ok && h.wallet_ready;
  }, 'api health', 300000, 3000);

  const compactSize = (n) => {
    if (n < 253) return Buffer.from([n]);
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  };

  // Sign in with a synthetic derived key (same crypto path as the browser).
  // Retries on 429: the final rate-limit burst drains the auth bucket, and a
  // fast re-run must still be able to sign in once tokens refill. Each retry
  // needs a FRESH nonce (single-use).
  const signIn = async (priv) => {
    const pub = secp256k1.getPublicKey(priv, true);
    let nonce, message, sigBytes;
    for (let attempt = 0; ; attempt++) {
      const nonceRes = await fetch('http://127.0.0.1:8080/api/auth/nonce');
      if (nonceRes.status === 429 && attempt < 60) {
        await sleep(3000);
        continue;
      }
      if (!nonceRes.ok) throw new Error(`nonce fetch failed: ${nonceRes.status}`);
      ({ nonce, message } = await nonceRes.json());
      const payload = Buffer.concat([
        compactSize(22),
        Buffer.from('Zcash Signed Message:\n', 'utf8'),
        compactSize(Buffer.byteLength(message)),
        Buffer.from(message, 'utf8'),
      ]);
      const prehash = sha256(sha256(payload));
      const sig = secp256k1.sign(prehash, priv);
      sigBytes = Buffer.concat([
        Buffer.from([31 + sig.recovery]),
        Buffer.from(sig.toCompactRawBytes()),
      ]);
      const verifyRes = await fetch('http://127.0.0.1:8080/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, signature: sigBytes.toString('hex') }),
      });
      if (verifyRes.status === 429 && attempt < 60) {
        await sleep(3000);
        continue;
      }
      if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status}`);
      const setCookie = verifyRes.headers.get('set-cookie') ?? '';
      return { cookie: setCookie.split(';')[0], pubkey: Buffer.from(pub).toString('hex'), nonce, sigBytes, message };
    }
  };

  console.log('=== auth flow (synthetic derived-key signature) ===');
  const priv = new Uint8Array(32).fill(9);
  const hex = (u8) => Buffer.from(u8).toString('hex');

  const session = await signIn(priv);
  SESSION = session.cookie;
  READ_COOKIE = session.cookie;
  const pub = secp256k1.getPublicKey(priv, true);
  expect(session.pubkey === hex(pub), 'identity pubkey matches recovered signer');

  const meRes = await fetch('http://127.0.0.1:8080/api/auth/me', {
    headers: { cookie: SESSION },
  });
  const me = await meRes.json();
  expect(me.authenticated === true && me.identity.pubkey === session.pubkey, 'session restores identity');

  const replay = await fetch('http://127.0.0.1:8080/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: session.nonce, signature: session.sigBytes.toString('hex') }),
  });
  expect(!replay.ok, 'nonce single-use: replay rejected');

  const health = await api('/api/health');
  const auctioneerUa = health.auctioneer_ua;
  const funderUa = await funderRpc('getnewaddress', []);
  expect(funderUa.startsWith('u'), `funder shielded UA (${funderUa.slice(0, 24)}…)`);
  // Seller payout address must NOT belong to the auctioneer wallet (API
  // rejects ismine addresses so proceeds cannot silently circle into escrow).
  const sellerUa = await funderRpc('getnewaddress', []);
  expect(sellerUa.startsWith('u'), `seller UA (${sellerUa.slice(0, 24)}…)`);

  console.log('=== authorization boundaries ===');
  const noAuth = await fetch('http://127.0.0.1:8080/api/auctions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'unsigned',
      reserve_zec: '0.1',
      duration_secs: 60,
      seller_address: sellerUa,
    }),
  });
  expect(noAuth.status === 401, 'create auction without session rejected (401)');

  const badAddr = await fetch('http://127.0.0.1:8080/api/auctions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: SESSION },
    body: JSON.stringify({
      title: 'bad seller',
      reserve_zec: '0.1',
      duration_secs: 60,
      seller_address: auctioneerUa, // ismine: belongs to auctioneer wallet
    }),
  });
  expect(badAddr.status === 400, 'seller_address inside auctioneer wallet rejected (400)');

  console.log('=== create auction (seller session) ===');
  const auction = await api('/api/auctions', {
    method: 'POST',
    headers: { cookie: SESSION },
    body: JSON.stringify({
      title: 'Zecathon judged lot — sealed Zcomputer',
      description: 'Full-lifecycle proof lot: three shielded bids, Vickrey settlement.',
      reserve_zec: '0.50000000',
      // Long enough that the auction cannot auto-close mid-bid-phase;
      // the seller closes it explicitly below.
      duration_secs: 300,
      seller_address: sellerUa,
      // Escrowed at create; only the winning bid may read it after settle.
      seller_contact: 'seller@zecathon — contact-escrow proof',
    }),
  });
  expect(auction.status === 'open', `auction open (${auction.id})`);
  expect(typeof auction.seller_pubkey === 'string' && auction.seller_pubkey.length > 0, 'seller identity bound to auction');

  // Early close is seller-only: a different identity must get 403.
  const privOther = new Uint8Array(32).fill(10);
  const other = await signIn(privOther);
  const earlyClose = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/close`, {
    method: 'POST',
    headers: { cookie: other.cookie },
  });
  expect(earlyClose.status === 403, 'early close by non-seller rejected (403)');
  const anonClose = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/close`, {
    method: 'POST',
  });
  expect(anonClose.status === 401, 'early close without session rejected (401)');

  console.log('=== anti-shill: sellers cannot bid on their own lot ===');
  // Session identity matches the listing seller's pubkey -> 403.
  const sellerSelfBid = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: SESSION },
    body: JSON.stringify({ refund_address: funderUa, amount_zec: '1.0' }),
  });
  expect(sellerSelfBid.status === 403, 'seller session bidding on own lot rejected (403)');
  // Refund address equals the seller's payout address -> 400, even for a
  // different session identity.
  const refundSelfBid = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: other.cookie },
    body: JSON.stringify({ refund_address: sellerUa, amount_zec: '1.0' }),
  });
  expect(refundSelfBid.status === 400, 'bid refunding to seller payout address rejected (400)');
  // Bidding is identity-bound: no session at all -> 401.
  const anonBid = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refund_address: funderUa, amount_zec: '1.0' }),
  });
  expect(anonBid.status === 401, 'bid without a session rejected (401)');

  console.log('=== three sealed bids ===');
  // Each bidder is its own first-party identity (derived key, unlinkable to
  // its shielded funds address). Distinct from the seller, so these are real
  // bids rather than self-bids.
  const bidders = [
    { amount: '1.50000000', label: 'bidder A (top)', priv: new Uint8Array(32).fill(21) },
    { amount: '1.20000000', label: 'bidder B (second)', priv: new Uint8Array(32).fill(22) },
    { amount: '0.90000000', label: 'bidder C (third)', priv: new Uint8Array(32).fill(23) },
  ];
  const bids = [];
  for (const spec of bidders) {
    const bidder = await signIn(spec.priv);
    expect(bidder.pubkey !== session.pubkey, `${spec.label}: identity distinct from seller`);
    const reg = await api(`/api/auctions/${auction.id}/bids`, {
      method: 'POST',
      headers: { cookie: bidder.cookie },
      body: JSON.stringify({ refund_address: funderUa, amount_zec: spec.amount }),
    });
    const opid = await funderRpc('z_sendmany', [
      funderUa,
      [{ address: auctioneerUa, amount: spec.amount, memo: hex(reg.memo) }],
    ]);
    const txid = await awaitOpid(funderRpc, opid, spec.label);
    bids.push({ ...spec, id: reg.bid_id, txid, cookie: bidder.cookie });
    console.log(`  ${spec.label}: ${spec.amount} ZEC tx ${txid.slice(0, 16)}…`);
    // No manual `generate` here: the API's regtest miner sees the payment in
    // the mempool and mines it. Driving zebra from the test as well races the
    // product's miner and zebra rejects the loser as a duplicate block.
    await sleep(1500);
  }

  console.log('=== detection + confirmation depth ===');
  for (const b of bids) {
    const s = await waitFor(async () => {
      const st = await api(`/api/bids/${b.id}`);
      return st.status === 'detected' || st.status === 'confirmed' ? st : null;
    }, `detect ${b.label}`, 90000, 2000);
    expect(s.txid === b.txid, `${b.label} detected on-chain (txid matched)`);
    expect(Number(s.confirmed_amount_zats) === Number(toZats(b.amount)), `${b.label} amount from chain`);
  }
  // Depth is per-network (regtest trades reorg margin for a fast demo
  // confirm), so read the target the API will actually enforce rather than
  // assuming a constant. The miner keeps producing blocks until each bid
  // reaches it — no manual generate needed.
  const privacy = await api('/api/privacy');
  const confTarget = Number(privacy.conf_target);
  expect(Number.isFinite(confTarget) && confTarget >= 1, `conf_target exposed (${confTarget})`);
  for (const b of bids) {
    const st = await waitFor(async () => {
      const s = await api(`/api/bids/${b.id}`);
      return s.status === 'confirmed' ? s : null;
    }, `confirm ${b.label}`, 90000, 1000);
    expect(
      st.confirmations >= confTarget,
      `${b.label} at ≥${confTarget} confs (${st.confirmations})`,
    );
  }

  console.log('=== sealed until settlement (dashboard leak check) ===');
  const dash = await api('/api/dashboard');
  const dashAuction = dash.auctions.find((a) => a.auction.id === auction.id);
  expect(dashAuction && dashAuction.bids.length === 0, 'dashboard exposes zero bid rows before settlement');

  console.log('=== close + Vickrey settle ===');
  await api(`/api/auctions/${auction.id}/close`, {
    method: 'POST',
    headers: { cookie: SESSION }, // seller closes early
  });

  // Concurrent-settle race: exactly one caller may claim the settlement CAS.
  // The winner returns the settlement payload; the loser gets 409.
  const [raceA, raceB] = await Promise.allSettled([
    fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/settle`, { method: 'POST' }),
    fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/settle`, { method: 'POST' }),
  ]);
  const raceResults = [];
  for (const r of [raceA, raceB]) {
    if (r.status === 'fulfilled') {
      raceResults.push({ status: r.value.status, body: await r.value.json() });
    } else {
      raceResults.push({ status: 0, body: null });
    }
  }
  const okCount = raceResults.filter((r) => r.status === 200).length;
  const conflictCount = raceResults.filter((r) => r.status === 409).length;
  expect(
    okCount === 1 && conflictCount === 1,
    `concurrent settle: exactly one winner, one 409 (got ${raceResults.map((r) => r.status).join(',')})`,
  );
  const settle = raceResults.find((r) => r.status === 200).body;

  const price = toZats('1.2');
  expect(settle.settlement.sold === true, 'auction sold');
  expect(BigInt(settle.settlement.price_zats) === price, `hammer price = second price (1.2 ZEC)`);
  expect(settle.settlement.winner_bid_id === bids[0].id, 'top bid won');
  const winnerRefund = settle.settlement.payments.find((p) => p.kind === 'winner_excess_refund');
  expect(BigInt(winnerRefund.amount_zats) === toZats('1.5') - price, 'winner refunded bid - price (full, no fee)');
  const loserRefunds = settle.settlement.payments.filter((p) => p.kind === 'bid_refund');
  expect(loserRefunds.length === 2, 'two loser refunds');
  const sellerProceeds = settle.settlement.payments.find((p) => p.kind === 'seller_proceeds');
  expect(BigInt(sellerProceeds.amount_zats) === price - commission(price), 'seller paid hammer price less 5% commission');
  expect(typeof settle.settlement_txid === 'string' && settle.settlement_txid.length === 64, 'settlement txid');

  console.log('=== settlement visibility + shielded-only proof ===');
  // The settlement tx enters the mempool and the API's miner confirms it —
  // same as every other payment. Wait for the refund notes to actually be
  // spendable (min 1 conf) rather than mining here, so this step exercises
  // the product's miner instead of racing it. The winner-excess refund
  // (bid - price) is a unique amount, so it is a clean proxy for
  // "the settlement tx has confirmed".
  const winnerRefundAmt = toZec(toZats('1.5') - price);
  await waitFor(async () => {
    const utxos = await funderRpc('listunspent', [1]);
    return utxos.some(
      (u) => u.address === funderUa && u.pool === 'ironwood' && Math.abs(Number(u.amount) - Number(winnerRefundAmt)) < 1e-8,
    )
      ? true
      : null;
  }, 'settlement refund notes confirmed', 90000, 1000);
  const detail = await api(`/api/auctions/${auction.id}`);
  expect(detail.status === 'settled', 'auction settled on the board');
  expect(detail.bids.length === 3, 'settlement ledger exposes all three bids');
  const winnerRow = detail.bids.find((b) => b.id === bids[0].id);
  expect(winnerRow.status === 'won', 'winner row marked won');
  const ledgerRefunds = detail.bids
    .filter((b) => b.id !== bids[0].id)
    .every((b) => b.status === 'refunded');
  expect(ledgerRefunds, 'loser rows marked refunded');

  // The persisted settlement plan must survive a refresh and carry every
  // outgoing payment — including the seller-side rows that carry no bid id.
  const plan = detail.settlement;
  expect(Boolean(plan) && plan.sold === true, 'settlement plan exposed on refresh');
  expect(plan.winner_bid_id === bids[0].id, 'plan names the winner');
  const planKinds = plan.payments.map((p) => p.kind);
  expect(planKinds.includes('seller_proceeds'), 'plan carries the seller proceeds row');
  expect(planKinds.includes('winner_excess_refund'), 'plan carries the winner excess refund');
  expect(planKinds.filter((k) => k === 'bid_refund').length === 2, 'plan carries two loser refunds');
  const planSellerProceeds = plan.payments.find((p) => p.kind === 'seller_proceeds');
  expect(
    BigInt(planSellerProceeds.amount_zats) === price - commission(price),
    'seller proceeds are hammer price less 5% commission',
  );

  const funderUtxos = await funderRpc('listunspent', [1]);
  // Refunds went to funderUa; seller proceeds went to sellerUa (also a
  // funder-wallet address, but a different one). The loser-B refund (full
  // 1.2 deposit) and the seller proceeds (1.2 less commission) are now
  // distinct amounts, so every lookup here is still address-scoped but the
  // values no longer collide.
  const refundAmounts = [toZec(toZats('1.5') - price), toZec(toZats('1.2')), toZec(toZats('0.9'))];
  const leaked = funderUtxos.filter(
    (u) => u.pool === 'transparent' && refundAmounts.some((amt) => Math.abs(Number(u.amount) - Number(amt)) < 1e-8),
  );
  expect(leaked.length === 0, 'no settlement refund amount landed in a transparent note');
  for (const amt of refundAmounts) {
    const note = funderUtxos.find(
      (u) => u.address === funderUa && Math.abs(Number(u.amount) - Number(amt)) < 1e-8,
    );
    expect(Boolean(note) && note.pool === 'ironwood', `refund note ${amt} ZEC arrived shielded at funderUa (ironwood)`);
  }

  const sellerNote = funderUtxos.find(
    (u) => u.address === sellerUa && Math.abs(Number(u.amount) - Number(toZec(price - commission(price)))) < 1e-8,
  );
  // Two-phase payout: the seller's proceeds are HELD after settlement, not
  // paid. They must not reach the seller until the winner confirms delivery.
  expect(detail.payout_state === 'held', 'seller payout held after settlement');
  expect(detail.payout_deadline != null && detail.payout_deadline > 0, 'payout auto-release deadline armed');
  expect(!sellerNote, 'seller proceeds held (not yet paid to seller)');

  console.log('=== contact escrow: only the winning bid can read the seller note ===');
  const SELLER_CONTACT = 'seller@zecathon — contact-escrow proof';
  // The note is escrowed at create but must never leak on a public read.
  expect(detail.seller_contact === undefined, 'public auction detail never exposes seller_contact');
  const loserClaim = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/contact/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bid_id: bids[1].id }),
  });
  expect(loserClaim.status === 403, `loser's bid cannot claim the contact (403, got ${loserClaim.status})`);
  const claimRaw = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/contact/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bid_id: bids[0].id }),
  });
  expect(claimRaw.ok, `winner claim accepted (${claimRaw.status})`);
  const claim = await claimRaw.json();
  expect(claim.counterparty_contact === SELLER_CONTACT, 'winner reads the seller contact escrowed at create');
  const claimedDetail = await api(`/api/auctions/${auction.id}`);
  expect(claimedDetail.contact_claimed === true, 'claim marked on the board');

  // Winner escrows their own note (bid ID capability); the seller reads it;
  // one-shot per side.
  const winnerNote = 'bidder A — @zcomputer_buyer';
  // Raw fetch with no cookie: the winning bid ID is the capability, so this
  // must work (and must not hit the seller one-shot branch) sessionless.
  const setWinnerRaw = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contact: winnerNote, bid_id: bids[0].id }),
  });
  expect(setWinnerRaw.ok, `winner escrow accepted (${setWinnerRaw.status})`);
  const setWinnerRes = await setWinnerRaw.json();
  expect(setWinnerRes.counterparty_contact === SELLER_CONTACT, 'winner escrow returns the seller note');
  const sellerRead = await api(`/api/auctions/${auction.id}/contact`, { headers: { cookie: SESSION } });
  expect(sellerRead.counterparty_contact === winnerNote, 'seller reads the winner contact');
  const sellerRewrite = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: SESSION },
    body: JSON.stringify({ contact: 'swapped after seeing theirs' }),
  });
  expect(sellerRewrite.status === 409, `seller contact one-shot (409, got ${sellerRewrite.status})`);

  console.log('=== winner confirms delivery → seller payout released ===');
  const confirmRes = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/payout/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bid_id: bids[0].id }),
  });
  expect(confirmRes.ok, `winner confirm accepted (${confirmRes.status})`);
  await waitFor(async () => {
    const d = await api(`/api/auctions/${auction.id}`);
    return d.payout_state === 'released' ? true : null;
  }, 'payout released after confirm', 90000, 2000);

  const sellerNoteAfter = await waitFor(async () => {
    const utxos = await funderRpc('listunspent', [1]);
    return utxos.find(
      (u) => u.address === sellerUa && Math.abs(Number(u.amount) - Number(toZec(price - commission(price)))) < 1e-8,
    );
  }, 'seller proceeds note after confirm', 90000, 2000);
  expect(
    sellerNoteAfter.pool === 'ironwood',
    `seller proceeds ${toZec(price - commission(price))} ZEC released shielded to sellerUa (ironwood)`,
  );

  // A second action after release must be rejected (payout already settled).
  const doublePayout = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/payout/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bid_id: bids[0].id }),
  });
  expect(doublePayout.status === 409, `double-confirm rejected after release (409, got ${doublePayout.status})`);

  console.log('=== profile: bids bound to identity ===');
  // Each bid is bound to the bidder's own identity, not the seller's, so the
  // seller profile must NOT expose them — and each bidder must see its own.
  const myBidsRes = await fetch('http://127.0.0.1:8080/api/me/bids', {
    headers: { cookie: SESSION },
  });
  expect(myBidsRes.ok, 'my bids endpoint authorized');
  const sellerBids = await myBidsRes.json();
  const sellerBidIds = new Set(sellerBids.map((b) => b.id));
  expect(
    bids.every((b) => !sellerBidIds.has(b.id)),
    'seller profile exposes none of the bidders\' bids (bound to bidder identities)',
  );
  for (const b of bids) {
    const r = await fetch('http://127.0.0.1:8080/api/me/bids', {
      headers: { cookie: b.cookie },
    });
    expect(r.ok, `${b.label} my-bids authorized`);
    const rows = await r.json();
    expect(
      rows.some((x) => x.id === b.id),
      `${b.label} sees its own bid under its own identity`,
    );
  }
  const anonBids = await fetch('http://127.0.0.1:8080/api/me/bids');
  expect(anonBids.status === 401, 'my bids requires session (401)');

  console.log('=== no transparent residue ===');
  const settleTx = await rpc(18232, 'gettransaction', [settle.settlement_txid], { user: 'auctioneer', password: 'regtest-auctioneer-pw' });
  const detailRows = settleTx.details || [];
  const anyTransparent = detailRows.some((d) => d.address && !d.address.startsWith('u'));
  expect(!anyTransparent, 'settlement tx has no transparent outputs');
  expect(settleTx.confirmations >= 1, `settlement tx confirmed (${settleTx.confirmations})`);

  console.log('=== dispute path: winner disputes → sale voided, hammer + collateral slash to winner ===');
  // Fund the seller's hosted wallet so it can escrow collateral.
  await api('/api/wallet/faucet', { method: 'POST', headers: { cookie: SESSION } });
  const auction2 = await api('/api/auctions', {
    method: 'POST',
    headers: { cookie: SESSION },
    body: JSON.stringify({
      title: 'Dispute proof lot — physical',
      description: 'Winner disputes delivery; hammer and collateral slash back to the winner.',
      reserve_zec: '0.1',
      duration_secs: 300,
      seller_address: sellerUa,
      collateral_zec: '0.02',
      delivery_kind: 'physical',
    }),
  });
  expect(auction2.delivery_kind === 'physical', 'delivery_kind persisted as physical');
  await api(`/api/auctions/${auction2.id}/collateral/pay`, {
    method: 'POST',
    headers: { cookie: SESSION },
  });
  await waitFor(async () => {
    const sv = await api(`/api/auctions/${auction2.id}/seller`, { headers: { cookie: SESSION } });
    return sv.auction.collateral_txid ? true : null;
  }, 'collateral confirmed for dispute lot', 90000, 2000);

  const disputeBidders = [
    { amount: '1.00000000', label: 'D-winner', priv: new Uint8Array(32).fill(31) },
    { amount: '0.60000000', label: 'D-loser', priv: new Uint8Array(32).fill(32) },
  ];
  const dIds = [];
  const dCookies = [];
  for (const spec of disputeBidders) {
    const bidder = await signIn(spec.priv);
    const reg = await api(`/api/auctions/${auction2.id}/bids`, {
      method: 'POST',
      headers: { cookie: bidder.cookie },
      body: JSON.stringify({ refund_address: funderUa, amount_zec: spec.amount }),
    });
    const opid = await funderRpc('z_sendmany', [
      funderUa,
      [{ address: auctioneerUa, amount: spec.amount, memo: hex(reg.memo) }],
    ]);
    await awaitOpid(funderRpc, opid, spec.label);
    dIds.push(reg.bid_id);
    dCookies.push(bidder.cookie);
    await sleep(1500);
  }
  for (const id of dIds) {
    await waitFor(async () => {
      const s = await api(`/api/bids/${id}`);
      return s.status === 'confirmed' ? true : null;
    }, `confirm dispute-lot bid ${id.slice(0, 8)}`, 90000, 1000);
  }
  await api(`/api/auctions/${auction2.id}/close`, { method: 'POST', headers: { cookie: SESSION } });
  await api(`/api/auctions/${auction2.id}/settle`, { method: 'POST' });

  const dDetail = await api(`/api/auctions/${auction2.id}`);
  expect(dDetail.sold === true && dDetail.payout_state === 'held', 'dispute lot sold with payout held');
  const dPrice = toZats('0.6'); // second price
  const slashAmt = toZec(dPrice + toZats('0.02')); // hammer + collateral

  // Only the winning bid may dispute; anyone else is forbidden.
  const nonWinnerDispute = await fetch(`http://127.0.0.1:8080/api/auctions/${auction2.id}/payout/dispute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bid_id: dIds[1] }), // loser's bid id
  });
  expect(nonWinnerDispute.status === 403, `non-winner dispute rejected (403, got ${nonWinnerDispute.status})`);

  const disputeRes = await fetch(`http://127.0.0.1:8080/api/auctions/${auction2.id}/payout/dispute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bid_id: dIds[0], reason: 'package never arrived' }), // winner's bid id
  });
  expect(disputeRes.ok, `winner dispute accepted (${disputeRes.status})`);
  // Dispute FREEZES the payout: no money moves until a neutral reviewer
  // resolves it (or the digital auto-rule fires — this lot is physical).
  const frozen = await waitFor(async () => {
    const d = await api(`/api/auctions/${auction2.id}`);
    return d.payout_state === 'disputed' ? d : null;
  }, 'payout frozen into disputed state', 90000, 2000);
  expect(frozen.dispute_reason === 'package never arrived', 'buyer claim recorded on the dispute');
  expect(frozen.payout_txid == null, 'dispute moved no money (still no payout txid)');

  // Seller submits delivery evidence once; a rewrite is refused.
  const proofRes = await api(`/api/auctions/${auction2.id}/payout/delivery-proof`, {
    method: 'POST',
    headers: { cookie: SESSION },
    body: JSON.stringify({ proof: 'tracking 9999 — delivered to buyer address' }),
  });
  expect(proofRes.delivery_proof === 'tracking 9999 — delivered to buyer address', 'seller delivery proof recorded');
  const proofRewrite = await fetch(`http://127.0.0.1:8080/api/auctions/${auction2.id}/payout/delivery-proof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: SESSION },
    body: JSON.stringify({ proof: 'swapped evidence' }),
  });
  expect(proofRewrite.status === 409, `delivery proof one-shot (409, got ${proofRewrite.status})`);

  // Neither principal may resolve their own dispute; a session is required.
  const anonResolve = await fetch(`http://127.0.0.1:8080/api/auctions/${auction2.id}/payout/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'slash' }),
  });
  expect(anonResolve.status === 401, `resolve requires a session (401, got ${anonResolve.status})`);
  const sellerResolve = await fetch(`http://127.0.0.1:8080/api/auctions/${auction2.id}/payout/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: SESSION },
    body: JSON.stringify({ action: 'release' }),
  });
  expect(sellerResolve.status === 403, `seller cannot resolve own dispute (403, got ${sellerResolve.status})`);
  const winnerResolve = await fetch(`http://127.0.0.1:8080/api/auctions/${auction2.id}/payout/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: dCookies[0] },
    body: JSON.stringify({ action: 'slash' }),
  });
  expect(winnerResolve.status === 403, `winner cannot resolve own dispute (403, got ${winnerResolve.status})`);

  // A neutral signed-in session (neither principal) resolves: slash to winner.
  const neutral = await signIn(new Uint8Array(32).fill(50));
  const resolveRes = await api(`/api/auctions/${auction2.id}/payout/resolve`, {
    method: 'POST',
    headers: { cookie: neutral.cookie },
    body: JSON.stringify({ action: 'slash' }),
  });
  expect(resolveRes.payout_state === 'slashed', `neutral slash accepted (${JSON.stringify(resolveRes)})`);
  await waitFor(async () => {
    const d = await api(`/api/auctions/${auction2.id}`);
    return d.payout_state === 'slashed' ? true : null;
  }, 'payout slashed after neutral resolution', 90000, 2000);
  const resolveAgain = await fetch(`http://127.0.0.1:8080/api/auctions/${auction2.id}/payout/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: neutral.cookie },
    body: JSON.stringify({ action: 'release' }),
  });
  expect(resolveAgain.status === 409, `second resolve rejected (409, got ${resolveAgain.status})`);

  const slashNote = await waitFor(async () => {
    const utxos = await funderRpc('listunspent', [1]);
    return utxos.find(
      (u) => u.address === funderUa && u.pool === 'ironwood' && Math.abs(Number(u.amount) - Number(slashAmt)) < 1e-8,
    );
  }, 'winner slash note after dispute', 90000, 2000);
  expect(
    Boolean(slashNote),
    `winner received hammer + collateral (${slashAmt} ZEC) shielded after dispute`,
  );
  const sellerSlashUtxos = await funderRpc('listunspent', [1]);
  const sellerSlashNote = sellerSlashUtxos.find(
    (u) => u.address === sellerUa && Math.abs(Number(u.amount) - Number(toZec(dPrice - commission(dPrice)))) < 1e-8,
  );
  expect(!sellerSlashNote, 'seller received nothing after dispute (proceeds + collateral forfeited)');

  console.log('=== security hardening regression checks ===');
  const doubleSettle = await fetch(`http://127.0.0.1:8080/api/auctions/${auction.id}/settle`, {
    method: 'POST',
  });
  expect(doubleSettle.status === 409, `double-settle rejected after settlement (409, got ${doubleSettle.status})`);

  const giantBody = JSON.stringify({
    title: 'x'.repeat(200),
    description: 'x'.repeat(20000),
    reserve_zec: '0.1',
    duration_secs: 300,
    seller_address: sellerUa,
  });
  const giantRes = await fetch('http://127.0.0.1:8080/api/auctions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: SESSION },
    body: giantBody,
  });
  expect(giantRes.status === 413, `oversized body rejected (413, got ${giantRes.status})`);

  const hdrRes = await fetch('http://127.0.0.1:8080/api/health');
  expect(
    hdrRes.headers.get('x-content-type-options') === 'nosniff' &&
      hdrRes.headers.get('x-frame-options') === 'DENY' &&
      (hdrRes.headers.get('content-security-policy') ?? '').length > 0,
    'security headers present (nosniff/DENY/CSP)',
  );

  let rateLimited = false;
  for (let i = 0; i < 30; i++) {
    const r = await fetch('http://127.0.0.1:8080/api/auth/nonce');
    if (r.status === 429) {
      rateLimited = true;
      break;
    }
  }
  expect(rateLimited, 'auth rate limiter returns 429 under burst');

  console.log(`\nLIFECYCLE GREEN — create → 3 shielded bids → detect → ${confTarget} confs → close → Vickrey settle → shielded refunds verified`);
  console.log('Security GREEN — authz boundaries, concurrent-settle CAS, sealed dashboard, double-settle 409, body limit, headers, rate limit');
  console.log(`UI: http://127.0.0.1:8080/auctions/${auction.id}`);
}

main().catch((e) => {
  console.error(`\nLIFECYCLE RED: ${e.message}`);
  process.exit(1);
});
