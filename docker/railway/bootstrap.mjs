// Railway bring-up job for the Bidshield regtest stack. Pure HTTP against the
// zebra / funder / api services (Railway volumes are per-service, so this job
// never touches a datadir). Mirrors e2e/spike.mjs P1-P4:
//   1. wait for zebra regtest RPC, mine BRINGUP_BLOCKS to the funder miner
//      address (the config's miner_address is this mnemonic's index-0 taddr),
//   2. wait for the funder wallet, shield mature coinbase into a shielded note,
//   3. wait for the api to report wallet_ready, then idle (Railway restarts
//      the container if it ever exits, which is also the retry mechanism).

const ZEBRA = process.env.ZEBRA_RPC || 'http://zebra:18234';
const FUNDER = process.env.FUNDER_RPC || 'http://funder:18242';
const FUNDER_HEALTH = process.env.FUNDER_HEALTH || 'http://funder:9243/readyz';
const API = process.env.API_URL || 'http://api:8080';
// Deterministic index-0 transparent address of the all-zero BIP-39 test vector
// (matches MINER_TADDR in regtest/zebrad.railway.toml).
const MINER_TADDR =
  process.env.MINER_TADDR || 'tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd';
const BRINGUP_BLOCKS = Number(process.env.BRINGUP_BLOCKS || 135);
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
    const hashes = await zebraRpc('generate', [batch], 300000);
    if (!Array.isArray(hashes) || hashes.length !== batch) {
      throw new Error(`generate(${batch}) returned ${JSON.stringify(hashes)?.slice(0, 200)}`);
    }
    done += batch;
    if (n > 25) log(`mined ${done}/${n}`);
  }
}

async function hasShieldedNote() {
  const utxos = await funderRpc('listunspent', [1]);
  return Array.isArray(utxos) && utxos.some((u) => SHIELDED_POOLS.has(u.pool));
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
    await mine(BRINGUP_BLOCKS - tip);
    tip = Number(await zebraRpc('getblockcount'));
  }
  log(`bootstrap: height ${tip} (coinbase maturity 100)`);

  log('bootstrap: waiting for funder /readyz');
  await waitUntil(async () => {
    const r = await fetch(FUNDER_HEALTH, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  }, 'funder /readyz', 300000);

  if (!(await hasShieldedNote())) {
    log('bootstrap: shielding coinbase into the funder wallet');
    // Shield destination must be a shielded receiver; the default address kind
    // is a unified address with shielded pools (a transparent t-addr is
    // rejected: "coinbase funds must be shielded when spent").
    const ua = await funderRpc('getnewaddress', []);
    const res = await funderRpc('z_shieldcoinbase', ['*', ua, null, 10]);
    if (!res.opid || !(res.shieldingUTXOs > 0)) {
      throw new Error(`z_shieldcoinbase: ${JSON.stringify(res)}`);
    }
    log(`bootstrap: shield opid ${res.opid} (${res.shieldingUTXOs} utxos)`);
    const deadline = Date.now() + 300000;
    let shielded = false;
    while (Date.now() < deadline) {
      const entries = await funderRpc('z_getoperationresult', [[res.opid]]);
      if (Array.isArray(entries) && entries.length > 0) {
        const e = entries[0];
        if (e.status !== 'success') {
          throw new Error(`shield operation ${e.status}: ${JSON.stringify(e.error ?? e)}`);
        }
        log(`bootstrap: shield tx ${e.result?.txid}`);
        break;
      }
      await sleep(1000);
    }
    // Give the shielded note a few blocks of depth, then wait for the wallet
    // to see it in listunspent (funder scans every 2s).
    await mine(6);
    await waitUntil(hasShieldedNote, 'funder shielded note', 300000);
    shielded = true;
    log(`bootstrap: funder holds a shielded note (shielded=${shielded})`);
  } else {
    log('bootstrap: funder already holds a shielded note');
  }

  log('bootstrap: waiting for api /api/health wallet_ready');
  await waitUntil(async () => {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const h = await r.json();
    return h.ok === true && h.wallet_ready === true;
  }, 'api wallet_ready', 600000, 5000);
  log('bootstrap: stack is up — idling as a liveness probe');

  // Idle forever (Railway restarts on exit). A tiny periodic probe keeps the
  // logs honest without doing any work.
  for (;;) {
    await sleep(300000);
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
