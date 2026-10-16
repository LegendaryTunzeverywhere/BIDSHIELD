import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');

const ROOT = process.cwd();

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

// Reads are session-gated: sign in once with a throwaway key so the bid
// status polls below are not anonymous 401s.
const compactSize = (n) => {
  if (n < 253) return Buffer.from([n]);
  const b = Buffer.alloc(3);
  b[0] = 0xfd;
  b.writeUInt16LE(n, 1);
  return b;
};
const readSession = (async () => {
  const priv = new Uint8Array(32).fill(88);
  const { nonce, message } = await (await fetch('http://127.0.0.1:8080/api/auth/nonce')).json();
  const payload = Buffer.concat([
    compactSize(22),
    Buffer.from('Zcash Signed Message:\n', 'utf8'),
    compactSize(Buffer.byteLength(message)),
    Buffer.from(message, 'utf8'),
  ]);
  const sig = secp256k1.sign(sha256(sha256(payload)), priv);
  const sigBytes = Buffer.concat([Buffer.from([31 + sig.recovery]), Buffer.from(sig.toCompactRawBytes())]);
  const verifyRes = await fetch('http://127.0.0.1:8080/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, signature: sigBytes.toString('hex') }),
  });
  if (!verifyRes.ok) throw new Error(`read-session verify failed: ${verifyRes.status}`);
  return (verifyRes.headers.get('set-cookie') ?? '').split(';')[0];
})();
const READ_COOKIE = await readSession;

const api = async (path, opts = {}) => {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (!headers.cookie) headers.cookie = READ_COOKIE;
  const res = await fetch(`http://127.0.0.1:8080${path}`, {
    ...opts,
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${opts.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auctionId = readFileSync(`${ROOT}/logs/auction.id`, 'utf8').trim();
const bidId = readFileSync(`${ROOT}/logs/bid.id`, 'utf8').trim();

const funderUa = await funderRpc('getnewaddress', []);
console.log(`funder UA: ${funderUa.slice(0, 30)}...`);

const bal = await funderRpc('getbalance');
console.log(`funder balance: ${bal} ZEC`);

const memoHex = Buffer.from(`bid:${bidId}`, 'utf8').toString('hex');
const auctioneerUa = (await api('/api/health')).auctioneer_ua;

const opid = await funderRpc('z_sendmany', [funderUa, [{ address: auctioneerUa, amount: '1.50000000', memo: memoHex }]]);
console.log(`send opid: ${opid}`);

let txid = null;
for (let i = 0; i < 120; i++) {
  const entries = await funderRpc('z_getoperationresult', [[opid]]);
  if (entries.length && entries[0].status === 'success') { txid = entries[0].result.txid; break; }
  if (entries.length && entries[0].status === 'failed') throw new Error(`send failed: ${JSON.stringify(entries[0].error)}`);
  await sleep(1000);
}
if (!txid) throw new Error('send timed out');
console.log(`bid txid: ${txid}`);

// No manual `generate`: the API's regtest miner sees the payment in the
// mempool and mines it. Driving zebra here as well races that miner.
let status = null;
for (let i = 0; i < 60; i++) {
  status = await api(`/api/bids/${bidId}`);
  if (status.status === 'detected' || status.status === 'confirmed') break;
  await sleep(1000);
}
console.log(`after detection: status=${status.status} txid=${status.txid} conf=${status.confirmations} amount=${status.confirmed_amount_zats}`);
if (status.status === 'registered') throw new Error('detector did not pick up the bid');

const confTarget = Number((await api('/api/privacy')).conf_target);
console.log(`conf_target: ${confTarget}`);

for (let i = 0; i < 90; i++) {
  status = await api(`/api/bids/${bidId}`);
  if (status.status === 'confirmed') break;
  await sleep(1000);
}
console.log(`target conf: status=${status.status} conf=${status.confirmations}`);
if (status.status !== 'confirmed') throw new Error(`bid not confirmed: ${JSON.stringify(status)}`);

const closed = await api(`/api/auctions/${auctionId}/close`, { method: 'POST' });
console.log(`closed: status=${closed.status}`);

const settlement = await api(`/api/auctions/${auctionId}/settle`, { method: 'POST' });
console.log(`settlement: ${JSON.stringify(settlement, null, 2)}`);

const detail = await api(`/api/auctions/${auctionId}`);
console.log(`final: status=${detail.status} sold=${detail.sold} price=${detail.price_zats} winner=${detail.winner_bid_id}`);
for (const b of detail.bids || []) {
  console.log(`  bid ${b.id.slice(0, 8)} status=${b.status} amount=${b.confirmed_amount_zats} refund=${b.refund_amount_zats} refund_tx=${b.refund_txid?.slice(0, 12)}`);
}

const auctioneerBal = (await api('/api/health')).wallet_balance_zats;
console.log(`auctioneer wallet after settlement: ${auctioneerBal} zats`);
console.log('LIVE FLOW OK');
