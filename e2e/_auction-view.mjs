// One-off: fetch auction state from a Railway/Vercel API with a fresh session.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');

const BASE = process.env.API_BASE || 'https://bidshield.up.railway.app';
const sha256d = (b) => sha256(sha256(b));
function compactSize(n) {
  if (n < 253) return Buffer.from([n]);
  const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b;
}
async function signIn(priv) {
  const { nonce, message } = await (await fetch(`${BASE}/api/auth/nonce`)).json();
  const payload = Buffer.concat([
    compactSize(22), Buffer.from('Zcash Signed Message:\n', 'utf8'),
    compactSize(Buffer.byteLength(message)), Buffer.from(message, 'utf8'),
  ]);
  const sig = secp256k1.sign(sha256d(payload), priv);
  const sigBytes = Buffer.concat([Buffer.from([31 + sig.recovery]), Buffer.from(sig.toCompactRawBytes())]);
  const r = await fetch(`${BASE}/api/auth/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, signature: sigBytes.toString('hex') }),
  });
  if (!r.ok) throw new Error(`verify ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}

const cookie = await signIn(randomBytes(32));
const id = process.argv[2];
const r = await fetch(`${BASE}/api/auctions/${id}`, { headers: { cookie } });
console.log(r.status, JSON.stringify(await r.json(), null, 2));
const m = await fetch(`${BASE}/api/auctions/${id}/bids`, { headers: { cookie } }).catch(() => null);
if (m && m.ok) console.log('BIDS', JSON.stringify(await m.json(), null, 2));
