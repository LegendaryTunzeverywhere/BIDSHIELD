#!/usr/bin/env node
// Bidshield Phase-1 feasibility spike (Zecathon day 1-2 gate).
//
// Proves the load-bearing assumption: zecd on a zebra Regtest chain can
//   1. hold a shielded wallet (auctioneer), receive a shielded "bid" with memo,
//   2. report it with amount + address + memo via listtransactions (bid detection),
//   3. verify it landed in the ironwood pool (NU6.3, same as mainnet),
//   4. send a shielded refund back to the bidder.
//
// Flow (mirrors zecd's own regtest-harness bring-up):
//   preflight (binary, image, offline address derivation, zebrad config render)
//   -> zebra regtest up -> mine 130 -> init funder -> shield coinbase
//   -> init auctioneer -> funder z_sendmany bid (memo) -> detect -> refund
//
// Usage:  node e2e/spike.mjs [--keep]
//   --keep  reuse existing containers/volumes (steps are ensure-style) instead of
//           a full `docker compose down -v` fresh start.
//
// Exit 0 = spike green (safe to build Bidshield on zecd); exit 1 = red (pivot gate).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

// Minimal repo-root .env loader so local runs share the gitignored seeds
// (e.g. the auctioneer ZECD_MNEMONIC). Real environment always wins.
try {
  const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env — script defaults apply */
}

const ZECD_VERSION = '0.8.2';
const ZECD_TARBALL = `zecd-${ZECD_VERSION}-linux-amd64.tar.gz`;
const ZECD_URL = `https://github.com/zecrocks/zecd/releases/download/v${ZECD_VERSION}/${ZECD_TARBALL}`;
const SHA_URL = `https://github.com/zecrocks/zecd/releases/download/v${ZECD_VERSION}/SHA256SUMS`;
const ZEBRA_IMAGE = 'zfnd/zebra:6.3.0';

// Canonical BIP-39 all-zero-entropy test vector (regtest infrastructure only).
const FUNDER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

const FUNDER_BIRTHDAY = 2;
const FUNDER_COINBASES = 20;
const MATURITY_TAIL = 110;          // 100 coinbase maturity + 10 slack
const BRINGUP_BLOCKS = FUNDER_COINBASES + MATURITY_TAIL; // 130
const SHIELD_AGE_BLOCKS = 6;        // harness SHIELD_CONFIRMATIONS
const BID_ZEC = '1.50000000';
const BID_MEMO_TEXT = 'bid:spike-0001';
const CONF_TARGET = 10;             // zecd stock untrusted-confirmation policy

const FANDER_RPC = { user: 'funder', password: 'regtest-funder-pw' };
const AUCTIONEER_RPC = { user: 'auctioneer', password: 'regtest-auctioneer-pw' };

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  return !!ok;
}
function warn(name, detail = '') {
  checks.push({ name, ok: true, warn: true, detail: String(detail) });
  console.log(`WARN  ${name}${detail ? `  [${detail}]` : ''}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    input: opts.input,
    env: { ...process.env, ...opts.env },
    timeout: opts.timeout ?? 600000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd} ${args.join(' ')} -> exit ${r.status}\n${(r.stderr || '') + (r.stdout || '')}`.slice(-4000)
    );
  }
  return r;
}
const compose = (args, opts = {}) => sh('docker', ['compose', ...args], opts);

async function rpc(port, method, params = [], auth = null, timeoutMs = 20000) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.password}`).toString('base64');
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ method, params, id: Math.random().toString(36).slice(2) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const zebraRpc = (m, p = [], t) => rpc(18234, m, p, null, t);
const funderRpc = (m, p = []) => rpc(18242, m, p, FANDER_RPC);
const auctioneerRpc = (m, p = []) => rpc(18232, m, p, AUCTIONEER_RPC);

async function waitUntil(fn, label, timeoutMs = 120000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let lastErr = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      if (await fn()) return true;
    } catch (e) {
      lastErr = e;
      if (attempts <= 5 || attempts % 20 === 0) {
        console.log(`  ... ${label}: attempt ${attempts} failed after ${Date.now() - started}ms: ${e.message}`);
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout: ${label} after ${attempts} attempts (${Date.now() - started}ms)` +
    `${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

async function readyz(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}
const waitReady = (port, label, timeoutMs = 180000) => waitUntil(() => readyz(port), `${label} /readyz`, timeoutMs);

async function awaitOpid(call, opid, label, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await call('z_getoperationresult', [[opid]]);
    if (Array.isArray(res) && res.length > 0) {
      const entry = res[0];
      if (entry.status !== 'success') {
        throw new Error(`${label} operation ${opid} ended ${entry.status}: ${JSON.stringify(entry.error ?? entry)}`);
      }
      return entry.result ?? {};
    }
    await sleep(500);
  }
  throw new Error(`${label} operation ${opid} did not finish within ${timeoutMs}ms`);
}

async function mine(n) {
  if (n <= 0) return;
  for (let done = 0; done < n;) {
    const batch = Math.min(25, n - done);
    const hashes = await zebraRpc('generate', [batch], 300000);
    if (!Array.isArray(hashes) || hashes.length !== batch) {
      throw new Error(`generate(${batch}) returned ${JSON.stringify(hashes)?.slice(0, 200)}`);
    }
    done += batch;
    if (n > 25) process.stdout.write(`  mined ${done}/${n}\r`);
  }
  if (n > 25) process.stdout.write('\n');
}

// Mine one block at a time until `confs()` >= 1 (a batch tip-jump can drop a
// just-broadcast mempool tx; harness mines to first confirmation singly).
async function confirmFirstTx(confs, label, maxBlocks = 25) {
  for (let i = 0; i < maxBlocks; i++) {
    if ((await confs()) >= 1) return;
    await mine(1);
    await sleep(700);
  }
  throw new Error(`${label} never reached 1 confirmation after ${maxBlocks} blocks`);
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function sha256File(file) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function ensureZecdBinary() {
  const bin = path.join(ROOT, 'docker', 'zecd', 'zecd');
  if (existsSync(bin) && statSync(bin).size > 10_000_000) return bin;

  const dir = path.join(ROOT, 'docker', 'zecd');
  mkdirSync(dir, { recursive: true });
  const tarPath = path.join(dir, ZECD_TARBALL);
  if (!existsSync(tarPath)) {
    console.log(`downloading ${ZECD_TARBALL} ...`);
    await download(ZECD_URL, tarPath);
  }
  console.log('verifying SHA256 against the release SHA256SUMS ...');
  const sumsPath = path.join(dir, 'SHA256SUMS');
  if (!existsSync(sumsPath)) await download(SHA_URL, sumsPath);
  const sums = readFileSync(sumsPath, 'utf8');
  const expected = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((parts) => parts[1] === ZECD_TARBALL)?.[0];
  if (!expected) throw new Error(`${ZECD_TARBALL} not listed in SHA256SUMS`);
  const actual = await sha256File(tarPath);
  if (actual !== expected.toLowerCase()) {
    rmSync(tarPath, { force: true });
    throw new Error(`SHA256 mismatch for ${ZECD_TARBALL}: expected ${expected}, got ${actual}`);
  }

  const extractDir = path.join(dir, '_extract');
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  sh('tar', ['-xzf', tarPath, '-C', extractDir]);
  const found = (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) {
        const r = walk(p);
        if (r) return r;
      } else if (e === 'zecd') return p;
    }
    return null;
  })(extractDir);
  if (!found) throw new Error('zecd binary not found inside the tarball');
  renameSync(found, bin);
  rmSync(extractDir, { recursive: true, force: true });
  console.log(`zecd ${ZECD_VERSION} ready at docker/zecd/zecd`);
  return bin;
}

function deriveAddress(index) {
  const r = compose(
    [
      'run', '-T', '--rm', '--no-deps',
      '-e', `ZECD_MNEMONIC=${FUNDER_MNEMONIC}`,
      'funder',
      '--conf', '/dev/null', '--regtest',
      'derive-address', '--mnemonic', '--address-type', 'transparent', '--index', String(index),
    ],
    { timeout: 120000 }
  );
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const addr = lines[lines.length - 1]?.trim();
  if (!addr || !addr.startsWith('tm')) throw new Error(`derive-address(${index}) -> ${JSON.stringify(addr)}`);
  return addr;
}

function renderZebradConfig(minerTaddr) {
  const tmpl = readFileSync(path.join(ROOT, 'regtest', 'zebrad.toml.tmpl'), 'utf8');
  const out = tmpl.replaceAll('{{MINER_TADDR}}', minerTaddr);
  writeFileSync(path.join(ROOT, 'regtest', 'zebrad.generated.toml'), out);
}

async function initWallet(service, args, input) {
  // Wipe helper: init failures can leave a partial datadir; start clean each retry.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = compose(
      ['run', '-T', '--rm', service, '--datadir', '/var/lib/zecd', '--conf=/etc/zecd/zecd.toml',
        'init', ...args],
      { allowFail: true, input, timeout: 180000 }
    );
    if (r.status === 0) return;
    console.log(`init ${service} attempt ${attempt} failed: ${(r.stderr || r.stdout || '').slice(-500)}`);
    compose(
      ['run', '-T', '--rm', '--no-deps', '--entrypoint', 'sh', service, '-c',
        'rm -rf /var/lib/zecd/* /var/lib/zecd/.[!.]* 2>/dev/null; true'],
      { allowFail: true, timeout: 60000 }
    );
    await sleep(2000);
  }
  throw new Error(`zecd init for ${service} failed after 3 attempts`);
}

async function walletInitialized(call, port) {
  try {
    await call('getwalletinfo', []);
    return true;
  } catch {
    return readyz(port).catch(() => false);
  }
}

// ---------------------------------------------------------------- phases

async function main() {
  const t0 = Date.now();

  section('P0 preflight');
  const ver = sh('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 60000 }).stdout.trim();
  check('docker engine reachable', ver.length > 0, `server ${ver}`);

  await ensureZecdBinary();

  const zebraPresent = sh('docker', ['image', 'inspect', ZEBRA_IMAGE], { allowFail: true }).status === 0;
  if (!zebraPresent) {
    console.log(`pulling ${ZEBRA_IMAGE} ...`);
    sh('docker', ['pull', ZEBRA_IMAGE], { timeout: 600000 });
  }
  check(`zebra image present (${ZEBRA_IMAGE})`, true);

  console.log('building zecd image ...');
  compose(['build', 'funder', 'auctioneer'], { timeout: 600000 });
  check('zecd image build', true);

  const genPath = path.join(ROOT, 'regtest', 'zebrad.generated.toml');
  let minerTaddr, expectedIssued;
  if (KEEP && existsSync(genPath) && !readFileSync(genPath, 'utf8').includes('{{MINER_TADDR}}')) {
    console.log('reusing existing zebrad.generated.toml (--keep)');
  } else {
    minerTaddr = deriveAddress(0);
    renderZebradConfig(minerTaddr);
  }
  expectedIssued = deriveAddress(1);
  check('funder t-addresses derived offline', true, `miner=${minerTaddr ?? '(cached)'} issued1=${expectedIssued}`);

  section('P1 chain up');
  const REGTEST_GENESIS = '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327';
  // zebra 6.3.0 reports chain:"test" for Regtest (newer builds say "regtest"), so pin the
  // chain by its genesis hash instead of the chain label.
  const chainIsOurs = async () => {
    const i = await zebraRpc('getblockchaininfo');
    if (i.chain !== 'regtest' && i.chain !== 'test') throw new Error(`unexpected chain: ${i.chain}`);
    const genesis = await zebraRpc('getblockhash', [0]);
    if (genesis !== REGTEST_GENESIS) throw new Error(`unexpected genesis: ${genesis}`);
    return true;
  };
  if (!KEEP) {
    compose(['down', '-v', '--remove-orphans'], { allowFail: true, timeout: 180000 });
    compose(['up', '-d', 'zebra'], { timeout: 180000 });
  } else {
    const healthy = await waitUntil(chainIsOurs, 'existing zebra regtest RPC (--keep)', 30000)
      .then(() => true).catch(() => false);
    if (!healthy) compose(['up', '-d', 'zebra'], { timeout: 180000 });
  }
  await waitUntil(chainIsOurs, 'zebra regtest RPC', 120000);
  const chainLabel = (await zebraRpc('getblockchaininfo')).chain;
  check('zebra on regtest', true, `chain=${chainLabel} blocks=${await zebraRpc('getblockcount')}`);

  section(`P2 mine bring-up chain (${BRINGUP_BLOCKS} blocks)`);
  const tip = await zebraRpc('getblockcount');
  if (tip < BRINGUP_BLOCKS) {
    await mine(BRINGUP_BLOCKS - tip);
  }
  check('chain height >= 130 (coinbase mature at 100)', (await zebraRpc('getblockcount')) >= BRINGUP_BLOCKS,
    `height=${await zebraRpc('getblockcount')}`);

  section('P3 funder wallet');
  if (!(await walletInitialized(funderRpc, 9243))) {
    await initWallet('funder', ['--restore', '--birthday', String(FUNDER_BIRTHDAY)], FUNDER_MNEMONIC + '\n');
  }
  compose(['up', '-d', 'funder'], { timeout: 180000 });
  await waitReady(9243, 'funder');
  const issued = await funderRpc('getnewaddress', ['', 'transparent']);
  check('funder daemon agrees with offline derivation', issued === expectedIssued, `issued=${issued}`);
  const funderUa = await funderRpc('getnewaddress', []);
  check('funder UA issued', typeof funderUa === 'string' && funderUa.length > 10, funderUa);

  section('P4 shield coinbase -> spendable shielded balance');
  // NB: getbalance counts transparent coinbase too (the funder already has 165 ZEC of
  // mature t-coins at this height), so it cannot gate the shield - probe the actual
  // shielded note via listunspent's pool field instead.
  const SHIELDED_POOLS = new Set(['sapling', 'orchard', 'ironwood']);
  const hasShieldedNote = async (call) => {
    const utxos = await call('listunspent', [1]);
    return Array.isArray(utxos) && utxos.some((u) => SHIELDED_POOLS.has(u.pool));
  };
  const shieldNow = async () => {
    if (await hasShieldedNote(funderRpc)) return true;
    const res = await funderRpc('z_shieldcoinbase', ['*', funderUa, null, 10]);
    if (!res.opid || !(res.shieldingUTXOs > 0)) throw new Error(`z_shieldcoinbase: ${JSON.stringify(res)}`);
    const { txid } = await awaitOpid(funderRpc, res.opid, 'shield');
    await confirmFirstTx(async () => {
      try { return (await funderRpc('gettransaction', [txid])).confirmations ?? 0; } catch { return 0; }
    }, `shield tx ${txid}`);
    await mine(SHIELD_AGE_BLOCKS);
    await waitUntil(async () => {
      await waitReady(9243, 'funder (post-shield)', 60000).catch(() => {});
      return await hasShieldedNote(funderRpc);
    }, 'funder shielded note visible (listunspent)', 120000);
    return true;
  };
  await shieldNow();
  const funderBal = Number(await funderRpc('getbalance')) || 0;
  check('funder holds a shielded note (spendable via z_sendmany)', await hasShieldedNote(funderRpc),
    `shielded=${await hasShieldedNote(funderRpc)} getbalance(t+shielded)=${funderBal} ZEC`);

  section('P5 auctioneer wallet');
  if (!(await walletInitialized(auctioneerRpc, 9233))) {
    // Same seed story as Railway: with ZECD_MNEMONIC set (.env) the wallet
    // restores that phrase — held key, identical wallet after any wipe.
    // Without it, keep the legacy fresh-wallet init.
    const seed = (process.env.ZECD_MNEMONIC || '').trim();
    if (seed) {
      await initWallet('auctioneer', ['--restore', '--birthday', String(FUNDER_BIRTHDAY)], seed + '\n');
    } else {
      await initWallet('auctioneer', ['--wallet', 'default', '--birthday', String(FUNDER_BIRTHDAY)]);
    }
  }
  compose(['up', '-d', 'auctioneer'], { timeout: 180000 });
  await waitReady(9233, 'auctioneer');
  const auctioneerUa = await auctioneerRpc('getnewaddress', []);
  check('auctioneer UA (uregtest1)', typeof auctioneerUa === 'string' && auctioneerUa.startsWith('uregtest1'), auctioneerUa);

  section('P6 shielded bid (funder -> auctioneer, memo)');
  const memoHex = Buffer.from(BID_MEMO_TEXT, 'utf8').toString('hex');
  const bidOpid = await funderRpc('z_sendmany', [
    funderUa,
    [{ address: auctioneerUa, amount: BID_ZEC, memo: memoHex }],
  ]);
  check('z_sendmany returns opid', typeof bidOpid === 'string', String(bidOpid));
  const bid = await awaitOpid(funderRpc, bidOpid, 'bid send');
  const bidTxid = bid.txid;
  check('bid tx broadcast', typeof bidTxid === 'string' && bidTxid.length === 64, String(bidTxid));

  // 0-conf visibility is desirable (fast bid detection) but backend-dependent: soft check.
  try {
    await waitUntil(async () => (Number(await auctioneerRpc('getunconfirmedbalance')) || 0) > 0,
      '0-conf bid visible', 30000);
    check('0-conf bid visible (getunconfirmedbalance)', true, 'mempool');
  } catch (e) {
    warn('0-conf bid visibility not observed on zebra backend', e.message);
  }

  await confirmFirstTx(async () => {
    try { return (await auctioneerRpc('gettransaction', [bidTxid])).confirmations ?? 0; } catch { return 0; }
  }, `bid tx ${bidTxid}`);
  await mine(CONF_TARGET + 1); // reach stock untrusted policy (>=10 confs)
  await waitReady(9233, 'auctioneer (post-bid)');
  await waitUntil(async () => {
    try { return (await auctioneerRpc('gettransaction', [bidTxid])).confirmations >= CONF_TARGET; }
    catch { return false; }
  }, `bid tx >= ${CONF_TARGET} confirmations (scan)`, 120000);

  section('P7 bid detection assertions (the product-critical bit)');
  const bal = Number(await auctioneerRpc('getbalance')) || 0;
  check('auctioneer getbalance > 0', bal > 0, `${bal} ZEC`);

  const unspent = await auctioneerRpc('listunspent', []);
  const iron = Array.isArray(unspent) && unspent.some((u) => u.pool === 'ironwood');
  check('received note is in the ironwood pool (NU6.3 = mainnet pool)', iron,
    `pools=${JSON.stringify([...new Set((unspent || []).map((u) => u.pool))])}`);

  const txs = await auctioneerRpc('listtransactions', ['*', 100]);
  const recv = (txs || []).find((t) => t.category === 'receive' && t.txid === bidTxid);
  check('listtransactions has the receive row', !!recv, recv ? `conf=${recv.confirmations}` : `rows=${(txs || []).length}`);
  if (recv) {
    check('receive row carries amount', Math.abs(Number(recv.amount) - Number(BID_ZEC)) < 1e-9, `amount=${recv.amount}`);
    check('receive row carries address', recv.address === auctioneerUa,
      `address=${recv.address} (expected ${auctioneerUa})`);
    check('receive row carries memoStr', recv.memoStr === BID_MEMO_TEXT, `memoStr=${recv.memoStr}`);
    check(`receive row confirmations >= ${CONF_TARGET}`, Number(recv.confirmations) >= CONF_TARGET, `conf=${recv.confirmations}`);
  }

  const gt = await auctioneerRpc('gettransaction', [bidTxid]);
  const gtDetail = (gt.details || []).find((d) => d.category === 'receive') ?? gt;
  check('gettransaction agrees (amount on receive detail)',
    Math.abs(Number(gtDetail.amount ?? gt.amount ?? 0) - Number(BID_ZEC)) < 1e-9,
    `amount=${gtDetail.amount ?? gt.amount}`);

  section('P8 refund (auctioneer -> funder)');
  // Wallet holds exactly the bid; the network fee must come out of the refund itself
  // (the product pays refunds as bid - fee; zecd's default fee is 10000 zats).
  const FEE_ZATS = 10000n;
  const bidZats = BigInt(Math.round(Number(BID_ZEC) * 1e8));
  const refundZats = bidZats - FEE_ZATS;
  const refundAmount = (Number(refundZats) / 1e8).toFixed(8);
  const refundOpid = await auctioneerRpc('z_sendmany', [
    auctioneerUa,
    [{ address: funderUa, amount: refundAmount }],
  ]);
  const refund = await awaitOpid(auctioneerRpc, refundOpid, 'refund send');
  const refundTxid = refund.txid;
  check('refund tx broadcast', typeof refundTxid === 'string' && refundTxid.length === 64, String(refundTxid));
  await confirmFirstTx(async () => {
    try { return (await funderRpc('gettransaction', [refundTxid])).confirmations ?? 0; } catch { return 0; }
  }, `refund tx ${refundTxid}`);
  await waitReady(9243, 'funder (post-refund)');
  const refundTxs = await funderRpc('listtransactions', ['*', 100]);
  const refundRecv = (refundTxs || []).find((t) => t.category === 'receive' && t.txid === refundTxid);
  check('refund visible to bidder with amount (bid - fee)', !!refundRecv && Math.abs(Number(refundRecv.amount) - Number(refundAmount)) < 1e-9,
    refundRecv ? `amount=${refundRecv.amount} (expected ${refundAmount}) conf=${refundRecv.confirmations}` : 'row missing');

  section('summary');
  const failed = checks.filter((c) => !c.ok);
  const warned = checks.filter((c) => c.warn);
  const report = {
    ts: new Date().toISOString(),
    durationMs: Date.now() - t0,
    verdict: failed.length === 0 ? 'GREEN' : 'RED',
    checks,
  };
  writeFileSync(path.join(ROOT, 'e2e', '.spike-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.verdict}: ${checks.length - failed.length}/${checks.length} checks passed` +
    `${warned.length ? `, ${warned.length} warning(s)` : ''} in ${Math.round(report.durationMs / 1000)}s`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name} :: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nSPIKE ERROR: ${e.message ?? e}`);
  const report = { ts: new Date().toISOString(), verdict: 'ERROR', error: String(e.message ?? e), checks };
  try { writeFileSync(path.join(ROOT, 'e2e', '.spike-report.json'), JSON.stringify(report, null, 2)); } catch {}
  process.exit(1);
});
