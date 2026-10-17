mod auth;
mod db;
mod detector;
mod ratelimit;
mod routes;
mod settle_exec;
mod state;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::{info, warn};

use state::{AppState, Config, NetworkRuntime, NetworkSpec};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    state::load_dotenv();
    let cfg = Config::from_env();
    info!(bind = %cfg.bind, db = %cfg.db_path, "starting bidshield api");

    // ---- Default (required) network profile ----
    let default_spec = NetworkSpec::default_from_env(&cfg);
    let zecd = default_spec.build_client();

    let mut ready = false;
    for _ in 0..120 {
        if zecd.ready().await {
            ready = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    if !ready {
        return Err("zecd wallet never became ready".into());
    }

    let chain = match zecd.get_blockchain_info().await {
        Ok(info) => state::map_chain(&info.chain),
        Err(e) => {
            warn!("getblockchaininfo failed ({e}); labelling chain from profile name");
            default_spec.name.clone()
        }
    };

    if let Some(parent) = std::path::Path::new(&default_spec.db_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let conn = rusqlite::Connection::open(&default_spec.db_path)?;
    db::init(&conn)?;

    let auctioneer_ua = resolve_auctioneer_ua(&zecd, &conn, &default_spec.name).await;
    if auctioneer_ua.is_empty() {
        return Err("could not obtain a shielded auctioneer address".into());
    }
    info!(ua = %auctioneer_ua, network = %default_spec.name, "auctioneer shielded address");

    let mut networks: Vec<Arc<NetworkRuntime>> = vec![Arc::new(NetworkRuntime::new(
        default_spec.name.clone(),
        chain.clone(),
        zecd,
        default_spec.build_zebra(),
        default_spec.build_funder(),
        conn,
        auctioneer_ua,
        true,
        cfg.conf_target_for(&chain),
    ))];

    // ---- Optional extra profiles (testnet / mainnet): best-effort ----
    for env_name in ["TESTNET", "MAINNET"] {
        let Some(spec) = NetworkSpec::extra_from_env(env_name) else {
            continue;
        };
        let client = spec.build_client();
        let zebra = spec.build_zebra();
        let funder = spec.build_funder();
        let mut up = false;
        // Boot must stay responsive: ~12 × (probes + 1s) ≈ 36s worst case.
        // "Up" means zecd answers AND zebra is at the estimated network tip —
        // /readyz alone is green hours early on a syncing public chain. A
        // backend still syncing flips up later via the detector watchdog.
        for _ in 0..12 {
            if client.ready().await && zebra.synced(cfg.sync_progress_min).await {
                up = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if let Some(parent) = std::path::Path::new(&spec.db_path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        let conn = rusqlite::Connection::open(&spec.db_path)?;
        db::init(&conn)?;

        let mut ua = String::new();
        let mut chain = spec.name.clone();
        if up {
            ua = resolve_auctioneer_ua(&client, &conn, &spec.name).await;
            if let Ok(info) = client.get_blockchain_info().await {
                chain = state::map_chain(&info.chain);
            }
        } else {
            warn!(
                network = %spec.name,
                "backend not reachable at boot; watchdog will keep retrying"
            );
        }
        info!(network = %spec.name, chain = %chain, ready = up, "network profile loaded");
        networks.push(Arc::new(NetworkRuntime::new(
            spec.name.clone(),
            chain.clone(),
            client,
            zebra,
            funder,
            conn,
            ua,
            up,
            cfg.conf_target_for(&chain),
        )));
    }

    let bind = cfg.bind.clone();
    let rate = ratelimit::RateLimiter::with_limits(cfg.rate_limits());
    let concurrency = std::sync::Arc::new(tokio::sync::Semaphore::new(
        cfg.max_concurrent_requests.max(1),
    ));
    let state = Arc::new(AppState {
        cfg,
        networks,
        active: AtomicUsize::new(0),
        auth_nonces: auth::AuthNonces::default(),
        rate,
        concurrency,
    });

    // Finalize any settlement interrupted by a previous crash/shutdown
    // before the detector starts moving bids again.
    for net in &state.networks {
        if net.ready.load(Ordering::Relaxed) {
            routes::recover_settling_net(&state, net).await;
        }
    }

    for i in 0..state.networks.len() {
        tokio::spawn(detector::run(state.clone(), i));
    }
    tokio::spawn(recovery_loop(state.clone()));
    // Regtest has no built-in miner, so without this every faucet claim and
    // bid payment would sit unconfirmed forever and the hosted demo would
    // look broken. Blocks are produced only when the mempool holds
    // something, so the chain stays quiet at rest.
    if state.cfg.miner_interval_secs > 0 {
        for i in 0..state.networks.len() {
            tokio::spawn(miner_loop(state.clone(), i));
        }
    }

    let index = std::path::Path::new(&state.cfg.web_dist).join("index.html");
    let static_service = ServeDir::new(&state.cfg.web_dist).fallback(ServeFile::new(index));

    let app = routes::api_routes()
        .fallback_service(static_service)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            routes::concurrency_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            routes::rate_limit_middleware,
        ))
        .layer(axum::middleware::from_fn(
            routes::security_headers_middleware,
        ))
        // Body cap: every API payload is tiny (auction form, JSON auth).
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024));

    // Split deploys (frontend hosted apart from the API, e.g. on Vercel):
    // when CORS_ORIGIN is set, answer preflights and allow that origin with
    // credentials. Empty = same-origin only (the API serves the SPA itself).
    let app = match &state.cfg.cors_origin {
        Some(origin) => {
            let origin: axum::http::HeaderValue = origin
                .parse()
                .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
            app.layer(
                CorsLayer::new()
                    .allow_origin(origin)
                    .allow_credentials(true)
                    .allow_methods([
                        axum::http::Method::GET,
                        axum::http::Method::POST,
                        axum::http::Method::PUT,
                        axum::http::Method::PATCH,
                        axum::http::Method::DELETE,
                        axum::http::Method::OPTIONS,
                    ])
                    .allow_headers([
                        axum::http::header::ACCEPT,
                        axum::http::header::CONTENT_TYPE,
                    ]),
            )
        }
        None => app,
    };

    let app = app.with_state(state);

    let listener = TcpListener::bind(&bind).await?;
    info!(addr = %listener.local_addr()?, "listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}

/// The auctioneer's shielded address must stay stable across redeploys: lots
/// register escrow payments to it, and a rotating address (a fresh
/// `getnewaddress` every boot mints a new random diversifier) strands funds
/// and confuses clients. Persist the first address in the network database
/// and only re-mint when the stored one is no longer ours — e.g. the wallet
/// volume was wiped and restored from the baked mnemonic. Returns an empty
/// string when no shielded address could be obtained (boot fails).
async fn resolve_auctioneer_ua(
    zecd: &zecd_client::ZecdClient,
    conn: &rusqlite::Connection,
    network: &str,
) -> String {
    if let Ok(Some(stored)) = db::get_setting(conn, "auctioneer_ua") {
        match zecd.z_validateaddress(&stored).await {
            Ok(v) if v.ismine => {
                info!(ua = %stored, network, "reusing stored auctioneer address");
                return stored;
            }
            Ok(v) => info!(
                ua = %stored,
                network,
                ismine = v.ismine,
                "stored auctioneer address not in wallet; minting a fresh one"
            ),
            Err(e) => warn!(
                ua = %stored,
                network,
                "z_validateaddress failed ({e}); minting a fresh auctioneer address"
            ),
        }
    }
    for _ in 0..30 {
        match zecd.get_new_address(None).await {
            Ok(ua) if ua.starts_with('u') => {
                if let Err(e) = db::set_setting(conn, "auctioneer_ua", &ua) {
                    warn!(network, "could not persist auctioneer address: {e}");
                }
                return ua;
            }
            Ok(_) => warn!("getnewaddress returned a non-shielded address; retrying"),
            Err(e) => warn!("getnewaddress failed: {e}; retrying"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    String::new()
}

/// Periodically re-check `settling` auctions so an interrupted settlement
/// finishes (or reverts) without operator action.
async fn recovery_loop(state: Arc<AppState>) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        for net in &state.networks {
            if net.ready.load(Ordering::Relaxed) {
                routes::recover_settling_net(&state, net).await;
                routes::recover_payouts_net(&state, net).await;
            }
        }
    }
}

/// Regtest-only block production: mine a block whenever zebra has
/// unconfirmed transactions, so the demo confirms unattended. Refuses to run
/// on any other chain — real networks mine themselves, and poking them with
/// `generate` would only log errors.
async fn miner_loop(state: Arc<AppState>, net_idx: usize) {
    let net = &state.networks[net_idx];
    if net.chain != "regtest" {
        return;
    }
    let period = std::time::Duration::from_secs(state.cfg.miner_interval_secs.max(1));
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    info!(network = %net.name, every = ?period, "regtest miner started");
    loop {
        tick.tick().await;
        if !net.ready.load(Ordering::Relaxed) {
            continue;
        }
        // Mine when the mempool holds something, or when a bid is still
        // waiting on the chain. The mempool check alone is not enough: once a
        // bid payment confirms into its first block the mempool drains, and
        // the detector still needs further blocks before the bid reaches
        // conf_target and the auction can settle. Without this second term the
        // chain stops at 1 confirmation and every hosted-wallet auction wedges.
        let pending = match net.zebra.mempool_txids().await {
            Ok(txs) if txs.is_empty() => {
                let awaiting = db::bids_awaiting_chain(&net.db()).unwrap_or(0);
                if awaiting == 0 {
                    continue;
                }
                awaiting
            }
            Ok(txs) => txs.len() as i64,
            Err(e) => {
                warn!(network = %net.name, "mempool probe failed: {e}");
                continue;
            }
        };
        match net.zebra.generate(1).await {
            Ok(hashes) => info!(
                network = %net.name,
                pending,
                block = hashes.first().map(String::as_str).unwrap_or("?"),
                "mined block"
            ),
            Err(e) => warn!(network = %net.name, "regtest miner failed: {e}"),
        }
    }
}
