// Testnet lifecycle: real public-testnet auction via light-mode zecd.
// Prerequisites: docker compose --profile testnet up -d (auctioneer-testnet +
// funder-testnet, both zecd 0.9.0-rc1 light mode) + api with NETWORK_TESTNET_*.
// The funder wallet needs TAZ (Valar faucet or an external testnet send) before the
// bid step; everything before that runs without funds.
//
// Usage: node e2e/testnet.mjs [--skip-bid]   (skip bid+settle, just prove API path)

import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');

const API = 'http://127.0.0.1:8080';
const FUNDER_RPC = 'http://127.0.0.1:18262/';
const FUNDER_AUTH = { user: 'funder', password: 'testnet-funder-pw' };
const AUCTIONEER_AUTH = { user: 'auctioneer', password: 'testnet-auctioneer-pw' };
const AUCTIONEER_RPC = 'http://127.0.0.1:18252/';
const skipBid = process.argv.includes('--skip-bid');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

async function rpc(url, auth, method, params = [], timeoutMs = 60000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.password}`).toString('base64'),
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'bidshield', method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function api(path, opts = {}, session = null) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (session) headers.cookie = `bidshield_session=${session}`;
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers,
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${opts.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/bidshield_session=([^;]+)/);
  return { body: text ? JSON.parse(text) : null, session: m ? m[1] : session, status: res.status };
}

const compactSize = (n) => {
  if (n < 253) return Buffer.from([n]);
  const b = Buffer.alloc(3);
  b[0] = 0xfd;
  b.writeUInt16LE(n, 1);
  return b;
};

async function signIn(priv) {
  const pub = secp256k1.getPublicKey(priv, true);
  let nonce, message;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}/api/auth/nonce`);
    if (r.status === 429 && attempt < 40) {
      await sleep(3000);
      continue;
    }
    if (!r.ok) throw new Error(`nonce: ${r.status}`);
    ({ nonce, message } = await r.json());
    break;
  }
  const payload = Buffer.concat([
    compactSize(22),
    Buffer.from('Zcash Signed Message:\n', 'utf8'),
    compactSize(Buffer.byteLength(message)),
    Buffer.from(message, 'utf8'),
  ]);
  const prehash = sha256(sha256(payload));
  const sig = secp256k1.sign(prehash, priv);
  const sigBytes = Buffer.concat([
    Buffer.from([31 + sig.recovery]),
    Buffer.from(sig.toCompactRawBytes()),
  ]);
  const { body, session } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({
      signature: sigBytes.toString('hex'),
      nonce,
    }),
  });
  if (!body?.pubkey) throw new Error(`verify failed: ${JSON.stringify(body)}`);
  return session;
}

async function awaitOpid(opid, label, auth = AUCTIONEER_AUTH, url = AUCTIONEER_RPC) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const entries = await rpc(url, auth, 'z_getoperationresult', [[opid]]);
    if (entries.length) {
      const e = entries[0];
      if (e.status === 'success') return e.result.txid;
      if (e.status === 'failed' || e.status === 'invalid')
        throw new Error(`${label} failed: ${JSON.stringify(e.error)}`);
    }
    await sleep(2000);
  }
  throw new Error(`${label} timed out`);
}

async function main() {
  // 0. Sanity: both testnet wallets synced.
  const aRz = await fetch('http://127.0.0.1:9253/readyz');
  const fRz = await fetch('http://127.0.0.1:9263/readyz');
  if (!aRz.ok || !fRz.ok) throw new Error('testnet wallets not ready (auctioneer/funder readyz)');
  console.log('PASS  testnet wallets ready (light mode)');

  // 1. Sign in with a synthetic key (same crypto path as the browser).
  const priv = secp256k1.utils.randomPrivateKey();
  const session = await signIn(priv);
  console.log('PASS  signed in');

  // 2. Switch the instance to testnet.
  const sw = await api('/api/network', {
    method: 'POST',
    body: JSON.stringify({ name: 'testnet' }),
  }, session);
  console.log(`PASS  switched to ${sw.body.active} (chain=${sw.body.chain})`);
  console.log(`      auctioneer UA: ${sw.body.auctioneer_ua}`);

  // Sessions are stored per-network DB, and the switch itself is validated
  // against the previous network's DB. Re-auth so the seller identity exists
  // in the testnet DB we are about to write to.
  const testnetSession = await signIn(priv);
  if (testnetSession !== session) console.log('PASS  re-authenticated against testnet DB');

  // 3. Seller address: the funder UA (proceeds land in the scripted bidder).
  const sellerAddress = await rpc(FUNDER_RPC, FUNDER_AUTH, 'getnewaddress', ['', 'orchard']);
  console.log(`      seller address: ${sellerAddress}`);

  // 4. Create a 3-minute auction.
  const created = await api('/api/auctions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Real testnet lot (light mode)',
      description: 'Public Zcash testnet via zec.rocks lightwalletd, zecd 0.9.0-rc1.',
      reserve_zec: '0.001',
      duration_secs: 180,
      seller_address: sellerAddress,
    }),
  }, testnetSession);
  const auction = created.body;
  console.log(`PASS  auction created ${auction.id} closes_at=${new Date(auction.closes_at * 1000).toISOString()}`);

  // 5. Register a bid (gets the exact memo + ZIP-321 the UI would show).
  //    Bidding is identity-bound and anti-shill: the bidder signs in with its
  //    own derived key (distinct from the seller's), and the refund address
  //    must not be the seller's payout address.
  const bidAmt = 0.003;
  const funderUa = await rpc(FUNDER_RPC, FUNDER_AUTH, 'getnewaddress', ['', 'orchard']);
  const bidderSession = await signIn(secp256k1.utils.randomPrivateKey());
  const reg = await api(`/api/auctions/${auction.id}/bids`, {
    method: 'POST',
    body: JSON.stringify({ amount_zec: String(bidAmt), refund_address: funderUa }),
  }, bidderSession);
  const bid = reg.body;
  console.log(`PASS  bid registered ${bid.bid_id} memo=${bid.memo} (bidder identity distinct from seller)`);
  console.log(`      zip321: ${bid.zip321_uri}`);

  if (skipBid) {
    console.log('--skip-bid: stopping before on-chain payment');
    return;
  }

  // 6. Fund check: the funder wallet must hold > bid + fee. The Valar faucet pays
  //    transparent tm... addresses, so shield any t-funds to the wallet's own UA first —
  //    the bid send below uses AllowRevealedRecipients (shielded source only).
  const bal = await rpc(FUNDER_RPC, FUNDER_AUTH, 'getbalance');
  const balNum = typeof bal === 'number' ? bal : Number(bal);
  if (!(balNum > bidAmt)) {
    console.log(`BLOCKED: funder balance ${balNum} TAZ <= bid ${bidAmt}.`);
    const funderUa = await rpc(FUNDER_RPC, FUNDER_AUTH, 'getnewaddress');
    const funderT = await rpc(FUNDER_RPC, FUNDER_AUTH, 'getnewaddress', ['', 'transparent']);
    console.log(`FUNDER UA  (shielded, any faucet): ${funderUa}`);
    console.log(`FUNDER t-addr (transparent ok):    ${funderT}`);
    console.log('Claim from faucet.testnet.valargroup.dev (phone hotspot if this IP is capped), then re-run.');
    process.exit(2);
  }
  console.log(`PASS  funder balance ${balNum} TAZ`);

  const utxos = await rpc(FUNDER_RPC, FUNDER_AUTH, 'listunspent');
  // zecd's listunspent includes SHIELDED notes (they carry a `pool` field like
  // "ironwood"/"orchard"). Only plain transparent UTXOs need a t->z shield step;
  // shielded notes are spendable by the bid's '' from-address as-is.
  const tUtxos = (Array.isArray(utxos) ? utxos : []).filter(
    (u) => !u.pool && (!u.address || u.address.startsWith('tm') || u.address.startsWith('t1')),
  );
  if (tUtxos.length) {
    const tSum = tUtxos.reduce((s, u) => s + Number(u.amount || 0), 0);
    console.log(`      shielding ${tUtxos.length} transparent UTXO(s) (${tSum} TAZ) to own UA...`);
    const funderUa = await rpc(FUNDER_RPC, FUNDER_AUTH, 'getnewaddress');
    const shieldOp = await rpc(FUNDER_RPC, FUNDER_AUTH, 'z_sendmany', [
      'ANY_TADDR',
      [{ address: funderUa, amount: String(tSum) }],
      1,
      null,
      'AllowRevealedSenders',
    ]);
    const shieldTxid = await (async () => {
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const entries = await rpc(FUNDER_RPC, FUNDER_AUTH, 'z_getoperationresult', [[shieldOp]]);
        if (entries.length) {
          const e = entries[0];
          if (e.status === 'success') return e.result.txid;
          if (e.status === 'failed' || e.status === 'invalid')
            throw new Error(`shield send failed: ${JSON.stringify(e.error)}`);
        }
        await sleep(2000);
      }
      throw new Error('shield send timed out');
    })();
    console.log(`PASS  shielded txid ${shieldTxid}`);
    console.log(`      explorer: https://testnet.zecblock.com/tx/${shieldTxid}`);
    // Wait for the shielded note to be spendable (orchard anchors need a block).
    await sleep(30000);
  }

  // 7. Pay the bid from the funder wallet (exactly what any wallet would do via ZIP-321).
  //    zecd 0.9.0-rc1 rejects '' as from-address, so spend from the address the
  //    sweep notes landed at (first shielded note in listunspent, else a fresh UA).
  const auctioneerUa = sw.body.auctioneer_ua;
  const fromAddr =
    (Array.isArray(utxos) ? utxos : []).find((u) => u.pool && u.spendable)?.address ||
    (await rpc(FUNDER_RPC, FUNDER_AUTH, 'getnewaddress'));
  const send = await rpc(FUNDER_RPC, FUNDER_AUTH, 'z_sendmany', [
    fromAddr,
    [{ address: auctioneerUa, amount: bidAmt, memo: hex(bid.memo) }],
    10,
    null,
    'AllowRevealedRecipients',
  ]);
  console.log(`PASS  bid broadcast opid=${send}`);
  const bidTxid = await (async () => {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const entries = await rpc(FUNDER_RPC, FUNDER_AUTH, 'z_getoperationresult', [[send]]);
      if (entries.length) {
        const e = entries[0];
        if (e.status === 'success') return e.result.txid;
        if (e.status === 'failed' || e.status === 'invalid')
          throw new Error(`bid send failed: ${JSON.stringify(e.error)}`);
      }
      await sleep(2000);
    }
    throw new Error('bid send timed out');
  })();
  console.log(`PASS  bid txid ${bidTxid}`);
  console.log(`      explorer: https://testnet.zecblock.com/tx/${bidTxid}`);

  // 8. Wait for the detector to mark it detected (CONF_TARGET=10 ~ 25s blocks).
  //    Bids are sealed pre-settlement, so poll the per-bid status endpoint.
  console.log('waiting for bid detection (CONF_TARGET=10, ~4-5 min on testnet)...');
  const deadline = Date.now() + 900000;
  let bidStatus = null;
  while (Date.now() < deadline) {
    const r = await api(`/api/bids/${bid.bid_id}`, {}, testnetSession);
    bidStatus = r.body;
    if (bidStatus.status === 'detected') break;
    await sleep(15000);
  }
  if (bidStatus?.status !== 'detected') throw new Error(`bid never detected (status=${bidStatus?.status})`);
  console.log(`PASS  bid detected (txid=${bidStatus.txid} confs=${bidStatus.confirmations})`);
  console.log(`      explorer: https://testnet.zecblock.com/tx/${bidStatus.txid}`);

  // 9. Close (after closes_at) and settle. Settle is synchronous: the API
  //    waits for the z_sendmany opid and returns the final settlement_txid.
  //    It 409s until the winning bid reaches CONF_TARGET confirmations, so retry.
  await sleep(Math.max(0, auction.closes_at * 1000 - Date.now() + 5000));
  await api(`/api/auctions/${auction.id}/close`, { method: 'POST' }, testnetSession);
  console.log('PASS  auction closed');
  let settle = null;
  const settleDeadline = Date.now() + 900000;
  while (Date.now() < settleDeadline) {
    try {
      settle = await api(`/api/auctions/${auction.id}/settle`, { method: 'POST' }, testnetSession);
      break;
    } catch (e) {
      if (!/409|confirmations/.test(e.message)) throw e;
      const m = e.message.match(/has (\d+) confirmations/);
      console.log(`      settle waiting (${m ? m[1] + ' confs' : '409'})...`);
      await sleep(20000);
    }
  }
  if (!settle) throw new Error('settle never succeeded (timeout)');
  const txid = settle.body.settlement_txid;
  if (txid) {
    console.log(`PASS  settlement txid ${txid}`);
    console.log(`      explorer: https://testnet.zecblock.com/tx/${txid}`);
  } else {
    console.log(`PASS  settle (no outputs?): ${JSON.stringify(settle.body).slice(0, 300)}`);
  }

  const final = await api(`/api/auctions/${auction.id}`, {}, testnetSession);
  console.log(`FINAL status=${final.body.status} sold=${final.body.sold} price_zats=${final.body.price_zats} winner=${final.body.winner_bid_id}`);
  console.log('=== testnet lifecycle GREEN ===');
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
