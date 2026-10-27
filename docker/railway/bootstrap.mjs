// Railway bring-up + refill job for the Bidshield regtest stack. Pure HTTP
// against the zebra / funder / api services (Railway volumes are per-service,
// so this job never touches a datadir). Mirrors e2e/spike.mjs P1-P4, then
// keeps the faucet reserve topped up forever:
//   1. wait for zebra regtest RPC, mine BRINGUP_BLOCKS to the funder miner
//      address (the config's miner_address is this mnemonic's index-0 taddr),
//   2. wait for the funder wallet, shield mature coinbase into shielded notes,
//   3. wait for the api to report wallet_ready,
//   4. idle, re-checking every 5 minutes: whenever the funder's shielded
//      reserve drops under FUNDER_TARGET_ZATS, mine TOPUP_BLOCKS more blocks
//      (the first TOPUP_BLOCKS-100 mature into coinbase) and shield again.
//      A drained faucet therefore refills itself without a redeploy.

const ZEBRA = process.env.ZEBRA_RPC || 'http://zebra:18234';
const FUNDER = process.env.FUNDER_RPC || 'http://funder:18242';
const FUNDER_HEALTH = process.env.FUNDER_HEALTH || 'http://funder:9243/readyz';
const API = process.env.API_URL || 'http://api:8080';
// Deterministic index-0 transparent address of the all-zero BIP-39 test vector
// (matches MINER_TADDR in regtest/zebrad.railway.toml).
const MINER_TADDR =
  process.env.MINER_TADDR || 'tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd';
const BRINGUP_BLOCKS = Number(process.env.BRINGUP_BLOCKS || 135);
// Refill target: keep at least this many zats of shielded reserve in the
// funder wallet (default 100 ZEC — 200 faucet claims of 0.5 ZEC).
const FUNDER_TARGET_ZATS = Number(process.env.FUNDER_TARGET_ZATS || 100_000_000_00);
// Blocks mined per top-up round. Coinbase matures at 100 confirms, so the
// first TOPUP_BLOCKS-100 of each round become spendable (~16.875 ZEC each).
const TOPUP_BLOCKS = Number(process.env.TOPUP_BLOCKS || 120);
const IDLE_SECS = Number(process.env.BOOTSTRAP_IDLE_SECS || 300);
const REGTEST_GENESIS =
  '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327';
const SHIELDED_POOLS = new Set(['sapling', 'orchard', 'ironwood']);

const FUNDER_AUTH =
  'Basic ' +
  Buffer.from(
    `${process.env.FUNDER_USER || 'funder'}:${process.env.FUNDER_PASS || 'regtest-funder-pw'}`,
  ).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function rpc(url, method, params = [], auth = null, timeoutMs = 20000) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ method, params, id: 'bootstrap' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const zebraRpc = (m, p = [], t) => rpc(`${ZEBRA}/`, m, p, null, t);
const funderRpc = (m, p = [], t) => rpc(`${FUNDER}/`, m, p, FUNDER_AUTH, t);

async function waitUntil(fn, label, timeoutMs, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function mine(n) {
  let done = 0;
  while (done < n) {
    const batch = Math.min(25, n - done);
    // Zebra can hiccup mid-bulk-generate ("buffer's worker closed
    // unexpectedly") and Railway restarts it — ride it out in-process instead
    // of killing this job.
    let hashes = null;
    let last = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        hashes = await zebraRpc('generate', [batch], 300000);
        break;
      } catch (e) {
        last = e;
        log(`mine: generate failed (attempt ${attempt}/4): ${e.message}; retrying in 15s`);
        await sleep(15000);
      }
    }
    if (!hashes) throw new Error(`generate(${batch}) failed after retries: ${last?.message}`);
    if (!Array.isArray(hashes) || hashes.length !== batch) {
      throw new Error(`generate(${batch}) returned ${JSON.stringify(hashes)?.slice(0, 200)}`);
    }
    done += batch;
    if (n > 25) log(`mined ${done}/${n}`);
  }
}

async function funderShieldedZats() {
  const utxos = await funderRpc('listunspent', [1]);
  if (!Array.isArray(utxos)) return 0;
  return utxos
    .filter((u) => u.pool && u.pool !== 'transparent')
    .reduce((n, u) => n + Math.round(Number(u.amount) * 1e8), 0);
}

// Errors that a little more chain progress + a re-sync will clear. Anything
// else (auth, bad address, daemon gone) is not worth retrying in a loop.
function isTransientShieldErr(msg) {
  const m = String(msg).toLowerCase();
  return (
    m.includes('immature') ||
    m.includes('expiry') ||
    m.includes('expired') ||
    m.includes('must not be mined') ||
    m.includes('no connected peer') ||
    m.includes('request timed out')
  );
}

// Shield every mature transparent coinbase on the funder into its own wallet.
// Readiness is detected by the shield call itself, never by comparing wallet
// height to zebra's tip: getblockcount is the wallet's *scanned* height, which
// trails the tip while a batch scan runs, so a lag gate can never clear (the
// exact failure that starved the faucet). z_shieldcoinbase internally knows
// when the view is usable — retry it every 3s until it reports actual UTXOs
// to shield (same pattern as DERELICT's e2e bootstrap).
async function shieldAllCoinbase(timeoutMs = 600000) {
  // Shield destination must be a shielded receiver; the default address kind
  // is a unified address with shielded pools (a transparent t-addr is
  // rejected: "coinbase funds must be shielded when spent").
  const ua = await funderRpc('getnewaddress', []);
  const deadline = Date.now() + timeoutMs;
  let res = null;
  for (;;) {
    try {
      res = await funderRpc('z_shieldcoinbase', ['*', ua, null, 10], 60000);
      if (res?.opid && res.shieldingUTXOs > 0) break;
      log(`bootstrap: z_shieldcoinbase not ready yet (opid=${res?.opid ?? 'none'} utxos=${res?.shieldingUTXOs ?? 0}); retrying in 3s`);
    } catch (e) {
      if (Date.now() >= deadline) throw new Error(`z_shieldcoinbase: ${e.message}`);
      log(`bootstrap: z_shieldcoinbase error (${e.message}); retrying in 3s`);
    }
    if (Date.now() >= deadline) {
      // No mature coinbase after the full window — not an error; the caller
      // mines more blocks so the next attempt has spendable coinbase.
      log(`bootstrap: nothing mature to shield after ${Math.round(timeoutMs / 1000)}s`);
      return false;
    }
    await sleep(3000);
  }
  log(`bootstrap: shield opid ${res.opid} (${res.shieldingUTXOs} utxos)`);
  const opDeadline = Date.now() + 300000;
  while (Date.now() < opDeadline) {
    const entries = await funderRpc('z_getoperationresult', [[res.opid]]);
    if (Array.isArray(entries) && entries.length > 0) {
      const e = entries[0];
      if (e.status !== 'success') {
        const msg = `shield operation ${e.status}: ${JSON.stringify(e.error ?? e)}`;
        if (isTransientShieldErr(msg)) throw new TransientShieldError(msg);
        throw new Error(msg);
      }
      log(`bootstrap: shield tx ${e.result?.txid}`);
      return true;
    }
    await sleep(1000);
  }
  throw new TransientShieldError(`shield op ${res.opid} did not finish in 5 minutes`);
}

class TransientShieldError extends Error {}


// Shield once, retrying the transient failures a stale wallet tip produces
// (immature-coinbase, born-expired tx). Each retry mines a few more blocks so
// the wallet has a fresh tip to build against, then re-syncs before retrying.
async function shieldWithRetry(label) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await shieldAllCoinbase();
    } catch (e) {
      if (!(e instanceof TransientShieldError) || attempt === 5) throw e;
      log(`${label}: shield attempt ${attempt}/5 failed transiently (${e.message}); mining 5 blocks and retrying`);
      await mine(5);
    }
  }
  return false;
}

// Mine + shield until the funder's shielded reserve covers the target.
async function ensureFunded(label) {
  let zats = await funderShieldedZats();
  if (zats >= FUNDER_TARGET_ZATS) {
    log(`${label}: funder shielded reserve ${zats} zats (>= target ${FUNDER_TARGET_ZATS})`);
    return;
  }
  for (let round = 1; round <= 4 && zats < FUNDER_TARGET_ZATS; round++) {
    log(
      `${label}: top-up round ${round}: reserve ${zats} < target ${FUNDER_TARGET_ZATS}, ` +
        `mining ${TOPUP_BLOCKS} blocks to the funder miner`,
    );
    await mine(TOPUP_BLOCKS);
    const shielded = await shieldWithRetry(label);
    if (!shielded) {
      // Nothing mature yet — mine more so the next round has spendable
      // coinbase instead of waiting on a reserve that cannot grow.
      log(`${label}: nothing shielded this round; mining 10 more blocks`);
      await mine(10);
      continue;
    }
    // Depth for the new shield tx, then let the wallet scan it in.
    await mine(2);
    await waitUntil(
      async () => (await funderShieldedZats()) > zats,
      'funder reserve to grow',
      300000,
    );
    zats = await funderShieldedZats();
    log(`${label}: funder reserve now ${zats} zats`);
  }
  if (zats < FUNDER_TARGET_ZATS) {
    throw new Error(`top-up failed: reserve ${zats} < target ${FUNDER_TARGET_ZATS}`);
  }
}

async function main() {
  log('bootstrap: waiting for zebra regtest RPC');
  await waitUntil(async () => {
    const genesis = await zebraRpc('getblockhash', [0]);
    if (genesis !== REGTEST_GENESIS) throw new Error(`unexpected genesis: ${genesis}`);
    return true;
  }, 'zebra regtest RPC', 300000);

  let tip = Number(await zebraRpc('getblockcount'));
  log(`bootstrap: chain height ${tip}`);
  if (tip < BRINGUP_BLOCKS) {
    log(`bootstrap: mining bring-up chain to ${BRINGUP_BLOCKS} blocks`);
    // Repeat until the tip actually holds: a zebra restart mid-mine can roll
    // the state back, which would leave us short of the maturity height.
    for (let round = 1; round <= 4 && tip < BRINGUP_BLOCKS; round++) {
      await mine(BRINGUP_BLOCKS - tip);
      tip = Number(await zebraRpc('getblockcount'));
      log(`bootstrap: height after round ${round}: ${tip}`);
    }
  }
  log(`bootstrap: height ${tip} (coinbase maturity 100)`);

  log('bootstrap: waiting for funder /readyz');
  try {
    // Throw on non-ok so the final timeout message carries the status + body —
    // "funder responds but is not ready" and "funder is down" must not look
    // identical in the logs.
    await waitUntil(async () => {
      const r = await fetch(FUNDER_HEALTH, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`funder /readyz HTTP ${r.status} ${body.slice(0, 200)}`);
      }
      return true;
    }, 'funder /readyz', 300000);
  } catch (e) {
    // Full diagnosis so the next pasted log names the actual cause.
    log('bootstrap: funder diagnosis —');
    try {
      const r = await fetch(FUNDER_HEALTH, { signal: AbortSignal.timeout(3000) });
      const body = r.ok ? '' : await r.text().catch(() => '');
      log(`bootstrap:   funder health: HTTP ${r.status} ${body.slice(0, 300)}`);
    } catch (e2) {
      log(`bootstrap:   funder health unreachable: ${e2.message}`);
    }
    try {
      const h = await funderRpc('getblockcount', [], 5000);
      log(`bootstrap:   funder rpc getblockcount: ${h}`);
    } catch (e2) {
      log(`bootstrap:   funder rpc failed: ${e2.message}`);
    }
    try {
      const z = await zebraRpc('getblockcount', [], 5000);
      log(`bootstrap:   zebra height: ${z}`);
    } catch (e2) {
      log(`bootstrap:   zebra probe failed: ${e2.message}`);
    }
    throw e;
  }

  await ensureFunded('bring-up');

  log('bootstrap: waiting for api /api/health wallet_ready');
  await waitUntil(async () => {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const h = await r.json();
    return h.ok === true && h.wallet_ready === true;
  }, 'api wallet_ready', 600000, 5000);
  log('bootstrap: stack is up — idling as a refill daemon');

  // Idle forever, keeping the faucet reserve topped up. Top-up failures are
  // logged and retried on the next pass; only a crash of this container
  // (Railway restarts it) escapes the loop.
  for (;;) {
    await sleep(IDLE_SECS * 1000);
    try {
      await ensureFunded('idle');
    } catch (e) {
      log(`bootstrap: top-up failed (will retry): ${e.message}`);
    }
    try {
      const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) });
      log(`bootstrap: api health ${r.status}`);
    } catch (e) {
      log(`bootstrap: api health probe failed: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error('bootstrap failed:', e.message ?? e);
  process.exit(1); // Railway restarts the container = retry
});
