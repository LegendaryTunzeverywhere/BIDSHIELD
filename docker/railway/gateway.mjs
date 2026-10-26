// Single-container Railway gateway for the Bidshield regtest demo.
//
// Railway bills a container for every minute it is awake and for the memory it
// holds. The split five-service stack keeps zebra + two zecd wallets resident
// 24/7 (~1.6 GB) even when nobody is bidding. This gateway keeps the same
// processes but runs them as children of one small Node process, starts them
// on the first request, and stops them after IDLE_STOP_SECS of inactivity.
// The public API stays on :8080; the Rust API listens on loopback :8081.
//
//   internet -> gateway :8080 -> api :8081
//                       \-> zebra :18234, funder :18242, auctioneer :18232
//
// While the stack boots, /api/* returns a JSON 503 with retry_after_secs and
// everything else returns a branded "waking" page. Vercel's /api rewrite passes
// the JSON through to the SPA, which can show a boot panel and retry.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_PORT = Number(process.env.PORT || 8080);
const API_PORT = Number(process.env.API_PORT || 8081);
const API_UID = Number(process.env.BIDSHIELD_UID || 10002);
const ZEBRA_UID = Number(process.env.ZEBRA_UID || 10001);

const IDLE_STOP_SECS = Number(process.env.IDLE_STOP_SECS || 900);
const START_RETRY_SECS = Number(process.env.START_RETRY_SECS || 15);
const ZEBRA_TIMEOUT_MS = Number(process.env.ZEBRA_TIMEOUT_SECS || 300) * 1000;
const WALLET_TIMEOUT_MS = Number(process.env.WALLET_TIMEOUT_SECS || 600) * 1000;
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_SECS || 180) * 1000;
const WARM_ON_BOOT = process.env.WARM_ON_BOOT === '1';

const ZEBRA_RPC = 'http://127.0.0.1:18234/';
const FUNDER_RPC = 'http://127.0.0.1:18242';
const FUNDER_HEALTH = 'http://127.0.0.1:9243/readyz';
const AUCTIONEER_RPC = 'http://127.0.0.1:18232';
const AUCTIONEER_HEALTH = 'http://127.0.0.1:9233/readyz';
const API_HEALTH = `http://127.0.0.1:${API_PORT}/api/health`;
const REGTEST_GENESIS =
  '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327';
const MINER_TADDR =
  process.env.MINER_TADDR || 'tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd';

// Public BIP-39 regtest test vectors only. A real deployment must override
// both variables with its own seeds.
const DEFAULT_FUNDER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const DEFAULT_AUCTIONEER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

const FUNDER_MNEMONIC = process.env.FUNDER_MNEMONIC || DEFAULT_FUNDER_MNEMONIC;
const AUCTIONEER_MNEMONIC =
  process.env.AUCTIONEER_MNEMONIC || DEFAULT_AUCTIONEER_MNEMONIC;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** @type {'stopped'|'starting'|'ready'|'stopping'|'broken'} */
let state = 'stopped';
let lastActivity = Date.now();
let lastFailureAt = 0;
let lastError = '';
let startPromise = null;
let stopPromise = null;
let pendingStart = false;
let generation = 0;
/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map();

const apiEnv = {
  BIND: `127.0.0.1:${API_PORT}`,
  DB_PATH: path.join(DATA_DIR, 'bidshield.db'),
  WEB_DIST: '/app/web/dist',
  ZECD_URL: `${AUCTIONEER_RPC}/`,
  ZECD_HEALTH: AUCTIONEER_HEALTH,
  ZECD_USER: 'auctioneer',
  ZECD_PASS: 'regtest-auctioneer-pw',
  FUNDER_URL: `${FUNDER_RPC}/`,
  FUNDER_HEALTH,
  FUNDER_USER: 'funder',
  FUNDER_PASS: 'regtest-funder-pw',
  MINER_INTERVAL_SECS: process.env.MINER_INTERVAL_SECS || '1',
  TRUST_PROXY: process.env.TRUST_PROXY || '1',
  COOKIE_SECURE: process.env.COOKIE_SECURE || '1',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '',
  RUST_LOG: process.env.RUST_LOG || 'info,tower_http=warn',
};

function runAs(uid, command, args, env, cwd = '/app') {
  return spawn(
    'setpriv',
    [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', command, ...args],
    {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function watch(name, child, gen) {
  children.set(name, child);
  const prefix = `[${name}] `;
  child.stdout?.on('data', (b) => process.stdout.write(prefix + b));
  child.stderr?.on('data', (b) => process.stderr.write(prefix + b));
  child.on('error', (e) => {
    if (gen !== generation) return;
    lastError = `${name} failed to start: ${e.message}`;
    log(lastError);
    state = 'broken';
  });
  child.on('exit', (code, signal) => {
    if (children.get(name) === child) children.delete(name);
    log(`${name} exited (code=${code}, signal=${signal})`);
    if (gen !== generation) return;
    if (state === 'stopping' || state === 'stopped') return;
    lastError = `${name} exited (code=${code}, signal=${signal})`;
    state = 'broken';
    // Let the request path own the restart so a sleeping demo does not spin.
    // Skip if a newer generation already started in the meantime.
    setTimeout(() => {
      if (state === 'broken' && gen === generation) {
        void stopStack('child exited');
      }
    }, 1500);
  });
}

function prepareDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const owners = [
    ['zebra', ZEBRA_UID],
    ['funder', API_UID],
    ['auctioneer', API_UID],
  ];
  for (const [name, uid] of owners) {
    const dir = path.join(DATA_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    try {
      spawnSync('chown', ['-R', `${uid}:${uid}`, dir], { stdio: 'ignore' });
    } catch (e) {
      log(`chown ${dir} failed: ${e.message}`);
    }
  }
  try {
    fs.chownSync(DATA_DIR, API_UID, API_UID);
  } catch (e) {
    log(`chown ${DATA_DIR} failed: ${e.message}`);
  }
  for (const f of ['bidshield.db', 'bidshield.db-wal', 'bidshield.db-shm']) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) {
      try {
        fs.chownSync(p, API_UID, API_UID);
      } catch (e) {
        log(`chown ${p} failed: ${e.message}`);
      }
    }
  }
}

async function fetchOk(url, timeoutMs = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return res.ok;
}

async function zebraReady() {
  const res = await fetch(ZEBRA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getblockhash',
      params: [0],
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return false;
  const body = await res.json();
  return body.result === REGTEST_GENESIS;
}

async function apiReady() {
  const res = await fetch(API_HEALTH, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return false;
  const body = await res.json();
  return body.ok === true && body.wallet_ready === true;
}

async function waitFor(label, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (state === 'broken') throw new Error(lastError || `${label} failed`);
    try {
      if (await fn()) {
        log(`ready: ${label}`);
        return;
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(2000);
  }
  throw new Error(
    `timed out waiting for ${label} after ${Math.round(timeoutMs / 1000)}s${
      last ? `: ${last}` : ''
    }`,
  );
}

function startStack() {
  if (startPromise) return startPromise;
  if (state === 'stopping') {
    pendingStart = true;
    return Promise.resolve();
  }
  startPromise = (async () => {
    if (Date.now() - lastFailureAt < START_RETRY_SECS * 1000) {
      throw new Error(`backing off after a failed start (${lastError})`);
    }
    if (children.size > 0) await stopStack('restart');
    generation += 1;
    const gen = generation;
    state = 'starting';
    lastActivity = Date.now();
    log(`starting stack (generation ${gen})`);
    try {
      prepareDataDir();

      watch(
        'zebra',
        runAs(
          ZEBRA_UID,
          'zebrad',
          ['-c', '/etc/zebra/zebrad.toml', 'start'],
          {
            HOME: '/home/zebra',
            ZEBRA_STATE__CACHE_DIR: path.join(DATA_DIR, 'zebra'),
            ZEBRA_RPC_ENABLE_COOKIE_AUTH: 'false',
          },
          '/home/zebra',
        ),
        gen,
      );
      await waitFor('zebra RPC', zebraReady, ZEBRA_TIMEOUT_MS);

      watch(
        'bootstrap',
        runAs(
          API_UID,
          '/usr/local/bin/node',
          ['/app/bootstrap.mjs'],
          {
            HOME: DATA_DIR,
            ZEBRA_RPC: 'http://127.0.0.1:18234',
            FUNDER_RPC,
            FUNDER_HEALTH,
            API_URL: `http://127.0.0.1:${API_PORT}`,
            FUNDER_USER: 'funder',
            FUNDER_PASS: 'regtest-funder-pw',
            MINER_TADDR,
            BRINGUP_BLOCKS: process.env.BRINGUP_BLOCKS || '135',
            FUNDER_TARGET_ZATS:
              process.env.FUNDER_TARGET_ZATS || '10000000000',
            TOPUP_BLOCKS: process.env.TOPUP_BLOCKS || '120',
            BOOTSTRAP_IDLE_SECS: process.env.BOOTSTRAP_IDLE_SECS || '300',
          },
        ),
        gen,
      );

      const wallet = (role) =>
        runAs(
          API_UID,
          '/usr/local/bin/zecd-entrypoint.sh',
          [],
          {
            HOME: DATA_DIR,
            ZECD_ROLE: role,
            ZECD_DATADIR: path.join(DATA_DIR, role),
            ZECD_CONF: `/etc/zecd/allinone.${role}.toml`,
            ZECD_MNEMONIC:
              role === 'funder' ? FUNDER_MNEMONIC : AUCTIONEER_MNEMONIC,
            ZECD_BIRTHDAY: process.env.ZECD_BIRTHDAY || '2',
            ZEBRA_RPC,
          },
          DATA_DIR,
        );

      watch('funder', wallet('funder'), gen);
      watch('auctioneer', wallet('auctioneer'), gen);

      await waitFor('funder wallet', () => fetchOk(FUNDER_HEALTH), WALLET_TIMEOUT_MS);
      await waitFor(
        'auctioneer wallet',
        () => fetchOk(AUCTIONEER_HEALTH),
        WALLET_TIMEOUT_MS,
      );

      watch(
        'api',
        runAs(API_UID, '/usr/local/bin/bidshield-api', [], apiEnv, DATA_DIR),
        gen,
      );
      await waitFor('api wallet_ready', apiReady, API_TIMEOUT_MS);

      if (gen !== generation) return;
      state = 'ready';
      lastActivity = Date.now();
      log('stack ready');
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      lastFailureAt = Date.now();
      log(`start failed: ${lastError}`);
      await stopStack('start failed');
      throw e;
    } finally {
      startPromise = null;
      if (pendingStart) {
        pendingStart = false;
        setImmediate(() => void ensureStack());
      }
    }
  })();
  return startPromise;
}

function ensureStack() {
  if (state === 'ready') return Promise.resolve();
  if (state === 'stopping') {
    pendingStart = true;
    return Promise.resolve();
  }
  return startStack().catch((e) => {
    log(`ensureStack: ${e.message}`);
  });
}

function stopStack(reason) {
  if (stopPromise) return stopPromise;
  if (state === 'stopped') return Promise.resolve();
  stopPromise = (async () => {
    generation += 1;
    state = 'stopping';
    log(`stopping stack (${reason})`);
    for (const name of ['api', 'bootstrap', 'auctioneer', 'funder', 'zebra']) {
      const child = children.get(name);
      if (child) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    await sleep(6000);
    for (const [name, child] of [...children]) {
      try {
        child.kill('SIGKILL');
        log(`killed ${name}`);
      } catch {
        /* already gone */
      }
    }
    children.clear();
    state = 'stopped';
    log('stack stopped');
    if (pendingStart) {
      pendingStart = false;
      setImmediate(() => void ensureStack());
    }
  })().finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}

function bootHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#15171a">
<meta http-equiv="refresh" content="5">
<title>Bidshield — waking the stack</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15171a;color:#eceae4;font-family:"Overpass","Segoe UI",system-ui,sans-serif;background-image:repeating-linear-gradient(to bottom,#15171a 0 27px,#131518 27px 28px)}
.card{width:min(520px,calc(100vw - 32px));border:1px solid #343a42;background:linear-gradient(#1b1e22,#191c20);padding:28px 24px}
.brand{font-weight:800;letter-spacing:.16em;text-transform:uppercase;font-size:20px;margin:0 0 18px}
.brand span{color:#ffb000}
.flap{display:grid;grid-template-columns:repeat(8,1fr);gap:4px;margin:18px 0 22px}
.flap i{height:34px;border-radius:2px;background:linear-gradient(#363c45 0 49%,#0e1013 49% 51%,#31363e 51%);animation:flap 1.4s ease-in-out infinite}
.flap i:nth-child(2n){animation-delay:.12s}.flap i:nth-child(3n){animation-delay:.24s}.flap i:nth-child(5n){animation-delay:.36s}
@keyframes flap{0%,100%{opacity:.35}50%{opacity:1}}
h1{font-size:clamp(22px,5vw,30px);line-height:1.05;letter-spacing:.06em;text-transform:uppercase;margin:0 0 10px}
p{margin:0;color:#a8a49c;font-size:14px;line-height:1.55}
code{font-family:"IBM Plex Mono",ui-monospace,monospace;color:#ffb000;font-size:12px;overflow-wrap:anywhere}
.foot{margin-top:22px;padding-top:14px;border-top:1px solid #282d34;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6f6b64}
@media (prefers-reduced-motion:reduce){.flap i{animation:none;opacity:.7}}
</style></head><body><main class="card">
<p class="brand">Bid<span>shield</span></p>
<div class="flap" aria-hidden="true">${'<i></i>'.repeat(16)}</div>
<h1>Waking the shielded stack</h1>
<p>The auction board runs on a sleeping demo node. It is starting zebra, the two shielded wallets, and the API now. This page refreshes automatically — the first wake can take a couple of minutes.</p>
<div class="foot">State: <code>${state}</code>${lastError ? ` · last error: <code>${escapeHtml(lastError).slice(0, 160)}</code>` : ''}</div>
</main></body></html>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function proxy(req, res) {
  // Keep the original Host: the API's origin check compares Origin to Host
  // (with CORS_ORIGIN as the explicit split-deploy exception).
  const headers = { ...req.headers };
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (peer) headers['x-forwarded-for'] = peer;
  headers['x-forwarded-proto'] =
    req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: API_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    log(`proxy error: ${e.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'backend unavailable', detail: e.message });
    } else {
      res.destroy();
    }
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/__gateway/health' || url === '/__gateway/healthz') {
    const ok = state !== 'broken';
    sendJson(res, ok ? 200 : 503, {
      ok,
      state,
      pid: process.pid,
      uptime_secs: Math.round(process.uptime()),
      idle_secs: Math.round((Date.now() - lastActivity) / 1000),
      last_error: lastError || null,
    });
    return;
  }
  if (url === '/__gateway/status') {
    sendJson(res, 200, {
      state,
      children: [...children.keys()],
      idle_stop_secs: IDLE_STOP_SECS,
      last_error: lastError || null,
    });
    return;
  }

  lastActivity = Date.now();
  if (state === 'ready') {
    proxy(req, res);
    return;
  }

  void ensureStack();

  if (url.startsWith('/api/')) {
    sendJson(
      res,
      503,
      {
        error:
          state === 'broken'
            ? 'The shielded stack failed to start; retrying.'
            : 'Booting the shielded stack.',
        booting: true,
        state,
        retry_after_secs: state === 'broken' ? START_RETRY_SECS : 5,
      },
      { 'retry-after': String(state === 'broken' ? START_RETRY_SECS : 5) },
    );
    return;
  }

  const html = bootHtml();
  res.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'retry-after': '5',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
});

setInterval(() => {
  if (state === 'ready' && Date.now() - lastActivity > IDLE_STOP_SECS * 1000) {
    void stopStack('idle');
  }
}, 30_000).unref();

async function shutdown(signal) {
  log(`${signal} received`);
  await stopStack(signal);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  log(
    `gateway listening on :${PUBLIC_PORT}; api on 127.0.0.1:${API_PORT}; ` +
      `idle stop ${IDLE_STOP_SECS}s`,
  );
  if (WARM_ON_BOOT) void ensureStack();
});
