use std::sync::Arc;

use axum::extract::{ConnectInfo, Json, Path, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use axum_extra::extract::cookie::CookieJar;
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth;
use crate::db::{self, Auction, Bid};
use crate::detector;
use crate::ratelimit::Class;
use crate::settle_exec;
use crate::state::{AppState, NetworkRuntime};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    RateLimited(String),
    #[error("{0}")]
    Busy(String),
    #[error("zecd: {0}")]
    Zecd(String),
    #[error("db: {0}")]
    Db(String),
    #[error("{0}")]
    Internal(String),
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        ApiError::Db(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden(_) => StatusCode::FORBIDDEN,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            ApiError::Busy(_) => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::Zecd(_) | ApiError::Db(_) | ApiError::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}

pub fn api_routes() -> Router<Arc<AppState>> {
    // Settlement may legitimately take minutes (z_sendmany confirmation);
    // everything else must answer quickly or be cut off.
    let settle_routes = Router::new().route("/api/auctions/{id}/settle", post(settle_auction));
    let short_routes = Router::new()
        .route("/api/health", get(health))
        .route("/api/privacy", get(privacy))
        .route("/api/networks", get(list_networks))
        .route("/api/network", post(switch_network))
        .route("/api/dashboard", get(dashboard))
        .route("/api/auctions", get(list_auctions).post(create_auction))
        .route("/api/auctions/{id}", get(get_auction))
        .route("/api/auctions/{id}/bids", post(place_bid))
        .route("/api/auctions/{id}/close", post(close_auction))
        .route("/api/auctions/{id}/collateral", get(collateral_invoice))
        .route("/api/auctions/{id}/seller", get(seller_view))
        .route("/api/auctions/{id}/payload", post(claim_payload))
        .route("/api/auctions/{id}/payout/confirm", post(payout_confirm))
        .route("/api/auctions/{id}/payout/dispute", post(payout_dispute))
        .route(
            "/api/auctions/{id}/payout/delivery-proof",
            post(payout_delivery_proof),
        )
        .route("/api/auctions/{id}/payout/resolve", post(payout_resolve))
        .route("/api/auctions/{id}/contact", post(set_contact).get(get_contact))
        .route("/api/auctions/{id}/contact/claim", post(claim_contact))
        .route("/api/bids/{bid_id}", get(get_bid))
        .route("/api/bids/{bid_id}/pay", post(pay_bid))
        .route("/api/wallet", get(get_wallet))
        .route("/api/wallet/faucet", post(faucet_claim))
        .route("/api/wallet/send", post(wallet_send))
        .route("/api/auctions/{id}/collateral/pay", post(pay_collateral))
        .route("/api/auth/nonce", get(auth_nonce))
        .route("/api/auth/verify", post(auth_verify))
        .route("/api/auth/me", get(auth_me))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/me/bids", get(my_bids))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            std::time::Duration::from_secs(30),
        ));
    short_routes.merge(settle_routes)
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn parse_zec(s: &str) -> Option<i64> {
    let s = s.trim();
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, f),
        None => (s, ""),
    };
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if frac.len() > 8 || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let whole: i64 = int.parse().ok()?;
    let frac = format!("{frac:0<8}");
    let frac: i64 = frac.parse().ok()?;
    whole.checked_mul(100_000_000)?.checked_add(frac)
}

fn validate_shielded(addr: &str) -> bool {
    addr.starts_with('u') && addr.len() >= 10
}

fn memo_hex(memo: &str) -> String {
    memo.bytes().map(|b| format!("{b:02x}")).collect()
}

pub fn zip321_uri(address: &str, amount_zec: &str, memo: &str) -> String {
    format!(
        "zcash:?address={address}&amount={amount_zec}&memo={}",
        memo_hex(memo)
    )
}

/// Reject state-changing auth requests whose Origin does not match Host
/// (CSRF defense-in-depth on top of SameSite). Split deploys (frontend on
/// its own origin) must pass the configured CORS_ORIGIN here too, or every
/// browser sign-in dies as "origin mismatch".
fn check_origin(headers: &HeaderMap, cors_origin: Option<&str>) -> Result<(), ApiError> {
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return Ok(()); // non-browser clients (curl, e2e)
    };
    if cors_origin.is_some_and(|allowed| allowed.eq_ignore_ascii_case(origin)) {
        return Ok(()); // split frontend: explicitly allowed cross-origin client
    }
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let origin_host = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .map(|s| s.split('/').next().unwrap_or(""))
        .unwrap_or("");
    if origin_host.is_empty() || !origin_host.eq_ignore_ascii_case(host) {
        return Err(ApiError::Unauthorized("origin mismatch".into()));
    }
    Ok(())
}

/// Resolve a session cookie to its pubkey. Takes the connection rather than
/// the state so callers pass their existing guard — locking the same
/// non-reentrant std::sync::Mutex twice on one thread deadlocks the runtime.
fn session_pubkey(db: &rusqlite::Connection, jar: &CookieJar) -> Option<(String, i64)> {
    let token = jar.get(auth::SESSION_COOKIE)?.value();
    let hash = auth::hash_token(token);
    let now = now();
    db::get_session(db, &hash, now).ok().flatten()
}

/// Require a session whose pubkey matches the auction's seller identity.
fn require_seller(
    db: &rusqlite::Connection,
    jar: &CookieJar,
    auction: &Auction,
) -> Result<String, ApiError> {
    let Some((pubkey, _)) = session_pubkey(db, jar) else {
        return Err(ApiError::Unauthorized("sign in required".into()));
    };
    match &auction.seller_pubkey {
        Some(sp) if *sp == pubkey => Ok(pubkey),
        _ => Err(ApiError::Forbidden(
            "only the seller may perform this action".into(),
        )),
    }
}

/// Validate a user-supplied shielded address against zecd: syntactically
/// valid, actually shielded, and not an address of the auctioneer wallet
/// (which would silently circle funds back into escrow).
async fn validate_user_address(
    net: &NetworkRuntime,
    addr: &str,
    what: &str,
) -> Result<(), ApiError> {
    if !validate_shielded(addr) {
        return Err(ApiError::BadRequest(format!(
            "{what} must be a shielded UA (starts with 'u')"
        )));
    }
    let va = net
        .zecd
        .z_validateaddress(addr)
        .await
        .map_err(|e| ApiError::Zecd(e.to_string()))?;
    if !va.isvalid {
        return Err(ApiError::BadRequest(format!(
            "{what} is not a valid address"
        )));
    }
    if va.ismine {
        return Err(ApiError::BadRequest(format!(
            "{what} belongs to the auctioneer wallet; supply an address you control"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP middleware: per-IP rate limiting, concurrency cap, security headers.
// ---------------------------------------------------------------------------

/// Resolve the client address. Behind the all-in-one Railway gateway every
/// socket peer is 127.0.0.1, so TRUST_PROXY=1 makes us read the gateway's
/// `X-Forwarded-For` instead. Only enable it when a trusted local proxy is the
/// sole ingress; otherwise clients can spoof the header.
fn client_ip(addr: &std::net::SocketAddr, headers: &HeaderMap, trust_proxy: bool) -> String {
    if trust_proxy {
        if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(first) = forwarded
                .split(',')
                .map(str::trim)
                .find(|part| !part.is_empty())
            {
                return first.to_string();
            }
        }
    }
    addr.ip().to_string()
}

pub async fn rate_limit_middleware(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    req: Request,
    next: axum::middleware::Next,
) -> Response {
    let ip = client_ip(&addr, req.headers(), state.cfg.trust_proxy);
    let path = req.uri().path();
    let class = if path.starts_with("/api/auth/") {
        Class::Auth
    } else if req.method() == Method::GET || req.method() == Method::HEAD {
        Class::Read
    } else {
        Class::Write
    };
    if !state.rate.check(&ip, class) {
        return ApiError::RateLimited("too many requests".into()).into_response();
    }
    next.run(req).await
}

pub async fn concurrency_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: axum::middleware::Next,
) -> Response {
    let Ok(_permit) = state.concurrency.clone().try_acquire_owned() else {
        return ApiError::Busy("server at capacity".into()).into_response();
    };
    next.run(req).await
}

pub async fn security_headers_middleware(req: Request, next: axum::middleware::Next) -> Response {
    let is_api = req.uri().path().starts_with("/api/");
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        "x-content-type-options",
        "nosniff".parse().expect("static header"),
    );
    h.insert("x-frame-options", "DENY".parse().expect("static header"));
    h.insert(
        "referrer-policy",
        "no-referrer".parse().expect("static header"),
    );
    h.insert(
        "content-security-policy",
        // script-src is 'self' only: the SPA ships no inline scripts, no eval,
        // and no HTML-injection sinks (React text nodes only; no
        // dangerouslySetInnerHTML), so there is nothing to relax for. An earlier
        // build opened 'unsafe-inline'/'unsafe-eval'/blob: so an injected wallet
        // extension could initialize; the sign-in flow is now seed-phrase based
        // and no longer talks to any injected provider. img-src gains https:
        // for the listing gallery (seller-supplied image URLs); data: keeps
        // QR/identicon support. style-src keeps 'unsafe-inline' for React
        // inline styles.
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
            .parse()
            .expect("static header"),
    );
    if is_api {
        h.insert("cache-control", "no-store".parse().expect("static header"));
    }
    res
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct AuthNonceResponse {
    nonce: String,
    message: String,
    expires_at: i64,
}

async fn auth_nonce(State(state): State<Arc<AppState>>) -> Json<AuthNonceResponse> {
    let (nonce, message, expires_at) = state.auth_nonces.issue(now());
    Json(AuthNonceResponse {
        nonce,
        message,
        expires_at,
    })
}

#[derive(serde::Deserialize)]
struct AuthVerify {
    nonce: String,
    signature: String,
}

#[derive(Serialize)]
struct AuthIdentityResponse {
    pubkey: String,
    short: String,
    first_seen: i64,
    last_seen: i64,
    sign_in_count: i64,
    expires_at: i64,
}

async fn auth_verify(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<AuthVerify>,
) -> Result<(CookieJar, Json<AuthIdentityResponse>), ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let ip = client_ip(&addr, &headers, state.cfg.trust_proxy);
    // Lock out IPs grinding signatures (secp256k1 recovery is CPU-heavy).
    if state.rate.auth_locked(&ip) {
        return Err(ApiError::RateLimited(
            "too many failed sign-in attempts".into(),
        ));
    }
    let message = state
        .auth_nonces
        .consume(body.nonce.trim(), now())
        .ok_or_else(|| {
            state.rate.note_auth_failure(&ip);
            ApiError::Unauthorized("nonce unknown, expired, or burned".into())
        })?;
    let pubkey = auth::verify_zcash_signature(&message, body.signature.trim()).map_err(|e| {
        state.rate.note_auth_failure(&ip);
        ApiError::Unauthorized(format!("signature invalid: {e}"))
    })?;
    state.auth_nonces.burn(body.nonce.trim());
    state.rate.clear_auth_failures(&ip);

    let now_ts = now();
    let expires_at = now_ts + state.cfg.session_ttl_secs;
    let (token, token_hash) = auth::new_session_token();
    let identity = {
        let net = state.active();
        let db = net.db();
        let identity = db::upsert_identity(&db, &pubkey, now_ts)?;
        db::create_session(&db, &token_hash, &pubkey, now_ts, expires_at)?;
        db::purge_expired_sessions(&db, now_ts)?;
        identity
    };
    let jar = jar.add(auth::session_cookie(
        &token,
        state.cfg.session_ttl_secs,
        state.cfg.cookie_secure,
    ));
    Ok((
        jar,
        Json(AuthIdentityResponse {
            short: auth::short_key(&identity.pubkey),
            pubkey: identity.pubkey,
            first_seen: identity.first_seen,
            last_seen: identity.last_seen,
            sign_in_count: identity.sign_in_count,
            expires_at,
        }),
    ))
}

#[derive(Serialize)]
struct AuthMeResponse {
    authenticated: bool,
    identity: Option<AuthIdentityResponse>,
}

async fn auth_me(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<AuthMeResponse>, ApiError> {
    let session = {
        let net = state.active();
        let db = net.db();
        session_pubkey(&db, &jar)
    };
    let Some((pubkey, expires_at)) = session else {
        return Ok(Json(AuthMeResponse {
            authenticated: false,
            identity: None,
        }));
    };
    let identity = {
        let net = state.active();
        let db = net.db();
        db::get_identity(&db, &pubkey)?
    };
    match identity {
        Some(identity) => Ok(Json(AuthMeResponse {
            authenticated: true,
            identity: Some(AuthIdentityResponse {
                short: auth::short_key(&identity.pubkey),
                pubkey: identity.pubkey,
                first_seen: identity.first_seen,
                last_seen: identity.last_seen,
                sign_in_count: identity.sign_in_count,
                expires_at,
            }),
        })),
        None => Ok(Json(AuthMeResponse {
            authenticated: false,
            identity: None,
        })),
    }
}

async fn auth_logout(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
) -> Result<(CookieJar, StatusCode), ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    if let Some(token) = jar.get(auth::SESSION_COOKIE) {
        let hash = auth::hash_token(token.value());
        let net = state.active();
        let db = net.db();
        db::delete_session(&db, &hash)?;
    }
    let jar = jar.add(auth::clear_cookie(state.cfg.cookie_secure));
    Ok((jar, StatusCode::NO_CONTENT))
}

async fn my_bids(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<Bid>>, ApiError> {
    let net = state.active();
    let db = net.db();
    let Some((pubkey, _)) = session_pubkey(&db, &jar) else {
        return Err(ApiError::Unauthorized("sign in required".into()));
    };
    Ok(Json(db::bids_for_user(&db, &pubkey)?))
}

// ---------------------------------------------------------------------------
// Hosted demo wallet: a seed phrase signs in, and the server's funder zecd
// holds and moves the ZEC. Judges never install a browser extension.
// ---------------------------------------------------------------------------

/// One authenticated identity's hosted wallet.
#[derive(Serialize)]
struct WalletView {
    /// Shielded address minted for this identity (null only before first
    /// successful assignment — the response below always mints one).
    address: Option<String>,
    balance_zats: i64,
    faucet_zats: i64,
    faucet_ready: bool,
    /// Seconds until the next faucet claim is allowed (0 when ready).
    faucet_wait_secs: i64,
    network: String,
    /// False when this network profile has no funder zecd configured.
    hosted: bool,
}

/// Resolve the session identity's pubkey, or 401.
fn require_session(db: &rusqlite::Connection, jar: &CookieJar) -> Result<String, ApiError> {
    session_pubkey(db, jar)
        .map(|(pk, _)| pk)
        .ok_or_else(|| ApiError::Unauthorized("sign in required".into()))
}

/// A funder RPC that never reached the wallet is an availability problem, not
/// a server bug: the wallet is still booting or has gone away. Answer 503 so
/// the client falls back to its retry state instead of surfacing a raw
/// transport string as a 500. Anything the wallet actually said (an RPC
/// rejection, a decode failure) keeps its own status.
fn map_funder_err(e: zecd_client::Error) -> ApiError {
    match e {
        zecd_client::Error::Transport(err) => {
            tracing::warn!(error = %err, "funder rpc unreachable");
            ApiError::Busy("the hosted wallet is not responding yet; retry in a moment".into())
        }
        e => ApiError::Zecd(e.to_string()),
    }
}

/// Mint + persist the identity's hosted address if it does not exist yet.
/// The address is created on the FUUNDER wallet, so it is never `ismine` on
/// the auctioneer and therefore stays valid as a refund_address.
async fn ensure_wallet_address(
    net: &NetworkRuntime,
    pubkey: &str,
) -> Result<String, ApiError> {
    let existing = {
        let db = net.db();
        db::get_wallet_address(&db, pubkey)?
    };
    if let Some(a) = existing {
        return Ok(a);
    }
    let funder = net.funder()?;
    let address = funder
        .get_new_address(None)
        .await
        .map_err(map_funder_err)?;
    if !address.starts_with('u') {
        return Err(ApiError::Zecd(
            "funder returned a non-shielded address".into(),
        ));
    }
    let db = net.db();
    if !db::insert_wallet_address(&db, pubkey, &address, now())? {
        // Lost a race with a concurrent request; use its address instead of
        // orphaning the one we just minted.
        return db::get_wallet_address(&db, pubkey)?
            .ok_or_else(|| ApiError::Internal("wallet row missing after insert".into()));
    }
    Ok(address)
}

/// The address the faucet sends from, gated on the reserve that actually
/// backs it: unspent shielded notes minus what the ledger already owes users.
///
/// zecd treats a shielded `fromaddress` as the whole account's note pool, so
/// this address only selects pools — it is not a per-address pot of money.
/// That also means change notes (which report a null address) are usable and
/// must count toward solvency, which a per-address sum would miss.
async fn faucet_funding(net: &NetworkRuntime, amount_zats: i64) -> Result<String, ApiError> {
    let notes = net
        .funder()?
        .list_unspent()
        .await
        .map_err(map_funder_err)?;

    let shielded: i64 = notes
        .iter()
        .filter(|n| n.pool.as_deref().is_some_and(|p| p != "transparent"))
        .map(|n| zecd_client::zats(n.amount))
        .sum();
    let owed = {
        let db = net.db();
        db::total_wallet_balances(&db)?
    };
    let reserve = shielded - owed;
    if reserve < amount_zats {
        return Err(ApiError::Busy(format!(
            "faucet reserve is low ({reserve} zats unclaimed of {shielded} shielded, {amount_zats} needed)"
        )));
    }

    // Prefer an address that is not a user's, so the log line reads like a
    // treasury; any funder-owned address names the same shielded pools.
    let owned: Vec<String> = {
        let db = net.db();
        db::wallet_addresses(&db)?
    };
    let named: Vec<String> = notes
        .iter()
        .filter_map(|n| n.address.clone())
        .filter(|a| a.starts_with('u'))
        .collect();
    named
        .iter()
        .find(|a| !owned.iter().any(|o| o == *a))
        .or_else(|| named.first())
        .or_else(|| owned.first())
        .cloned()
        .ok_or_else(|| {
            ApiError::Busy("funder wallet has no shielded address to send from".into())
        })
}

/// Why an awaited operation ended without a terminal status.
///
/// `Failed` means zecd itself reported the transfer did not happen, so a
/// balance reserved for it can safely be handed back. `Ambiguous` covers
/// everything else — a dropped connection, a vanished opid — where the
/// transaction may still land; the reservation must stay in place, because
/// refunding money that later moves would let one balance be spent twice.
pub enum OpOutcome {
    Failed(String),
    Ambiguous(String),
}

impl From<OpOutcome> for ApiError {
    fn from(o: OpOutcome) -> Self {
        ApiError::Zecd(match o {
            OpOutcome::Failed(m) | OpOutcome::Ambiguous(m) => m,
        })
    }
}

/// Poll a zecd async operation until it finishes or `secs` elapse.
/// Returns (status, txid). Status is "pending" when the deadline hit first.
async fn await_op(
    client: &zecd_client::ZecdClient,
    opid: &str,
    secs: u64,
) -> Result<(String, Option<String>), OpOutcome> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        let entry = client
            .operation_status(opid)
            .await
            .map_err(|e| OpOutcome::Ambiguous(e.to_string()))?;
        match entry {
            Some(e) => match e.status.as_deref() {
                Some("success") => return Ok(("success".into(), e.result.and_then(|r| r.txid))),
                Some("failed") | Some("invalid") => {
                    let msg = e
                        .error
                        .and_then(|x| x.message)
                        .unwrap_or_else(|| "operation failed".into());
                    return Err(OpOutcome::Failed(msg));
                }
                _ => {}
            },
            None => return Err(OpOutcome::Ambiguous("operation disappeared".into())),
        }
        if std::time::Instant::now() >= deadline {
            return Ok(("pending".into(), None));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// Move `amount_zats` out of an identity's ledger balance and on chain.
///
/// The balance is reserved first, so two concurrent spends cannot both pass
/// the check; the reservation is given back only when we know for certain
/// nothing moved (an RPC rejection before an opid existed, or zecd reporting
/// the operation failed). Anything ambiguous keeps the reservation.
///
/// Returns the operation's (status, txid).
async fn ledger_transfer(
    net: &NetworkRuntime,
    funder: &zecd_client::ZecdClient,
    pubkey: &str,
    from: &str,
    to: &str,
    amount_zats: i64,
    memo: Option<&str>,
) -> Result<(String, Option<String>), ApiError> {
    {
        let db = net.db();
        if !db::debit_wallet(&db, pubkey, amount_zats)? {
            let have = db::wallet_balance(&db, pubkey)?;
            return Err(ApiError::BadRequest(format!(
                "insufficient balance: have {have} zats, need {amount_zats} zats"
            )));
        }
    }
    let opid = match funder
        .send_with_memo(from, to, &zecd_client::zec_str(amount_zats), memo)
        .await
    {
        Ok(o) => o,
        Err(e) => {
            let db = net.db();
            let _ = db::refund_wallet(&db, pubkey, amount_zats);
            return Err(map_funder_err(e));
        }
    };
    match await_op(funder, &opid, 25).await {
        Ok(v) => Ok(v),
        Err(e) => {
            if matches!(e, OpOutcome::Failed(_)) {
                let db = net.db();
                let _ = db::refund_wallet(&db, pubkey, amount_zats);
            }
            Err(e.into())
        }
    }
}

/// Report the ledger balance, which is what the identity can actually spend.
/// zecd's shielded `fromaddress` spends the whole wallet's notes, so an
/// on-chain per-address sum is neither spendable nor reduced by spending.
fn ledger_balance(net: &NetworkRuntime, pubkey: &str) -> Result<i64, ApiError> {
    let db = net.db();
    Ok(db::wallet_balance(&db, pubkey)?)
}

/// Sign-in-scoped wallet read: assigns an address on first use and reports
/// the live balance plus faucet availability.
async fn get_wallet(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<WalletView>, ApiError> {
    let net = state.active();
    let pubkey = {
        let db = net.db();
        require_session(&db, &jar)?
    };
    let hosted = net.funder.is_some();
    if !hosted {
        return Ok(Json(WalletView {
            address: None,
            balance_zats: 0,
            faucet_zats: 0,
            faucet_ready: false,
            faucet_wait_secs: 0,
            network: net.name.clone(),
            hosted: false,
        }));
    }
    let address = ensure_wallet_address(&net, &pubkey).await?;
    let balance = ledger_balance(&net, &pubkey)?;
    let (since_last_claim, cooldown) = {
        let db = net.db();
        (
            db::wallet_faucet_elapsed(&db, &pubkey, now())?,
            state.cfg.faucet_cooldown_secs,
        )
    };
    // `wallet_faucet_elapsed` is seconds *since* the last claim, or `None`
    // when the identity has never claimed. The client counts down to the next
    // claim, so report remaining, not elapsed.
    let remaining = match since_last_claim {
        None => 0,
        Some(elapsed) => (cooldown - elapsed).max(0),
    };
    Ok(Json(WalletView {
        address: Some(address),
        balance_zats: balance,
        faucet_zats: state.cfg.faucet_zats,
        faucet_ready: remaining <= 0,
        faucet_wait_secs: remaining.min(cooldown).max(0),
        network: net.name.clone(),
        hosted: true,
    }))
}

/// Claim a fixed amount of regtest/testnet ZEC from the demo treasury.
async fn faucet_claim(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let net = state.active();
    let pubkey = {
        let db = net.db();
        require_session(&db, &jar)?
    };
    let amount = state.cfg.faucet_zats;
    if amount <= 0 {
        return Err(ApiError::BadRequest("faucet is disabled".into()));
    }
    let address = ensure_wallet_address(&net, &pubkey).await?;

    // Cooldown is claimed BEFORE the transfer so two parallel requests cannot
    // both pass the check and double-spend the treasury. It is released if
    // the transfer never happens.
    let ts = now();
    let earliest = ts - state.cfg.faucet_cooldown_secs;
    {
        let db = net.db();
        if !db::claim_wallet_faucet(&db, &pubkey, ts, earliest)? {
            // None = never claimed (a missing wallet row, not a real cooldown).
            let elapsed = db::wallet_faucet_elapsed(&db, &pubkey, ts)?.unwrap_or(0);
            let wait = (state.cfg.faucet_cooldown_secs - elapsed).max(0);
            return Err(ApiError::RateLimited(format!(
                "faucet cooldown: try again in {wait}s"
            )));
        }
    }

    let src = match faucet_funding(&net, amount).await {
        Ok(v) => v,
        Err(e) => {
            let db = net.db();
            let _ = db::release_wallet_faucet(&db, &pubkey);
            return Err(e);
        }
    };

    let funder = net.funder()?.clone();
    let send = funder
        .send_with_memo(&src, &address, &zecd_client::zec_str(amount), None)
        .await;
    let opid = match send {
        Ok(o) => o,
        Err(e) => {
            let db = net.db();
            let _ = db::release_wallet_faucet(&db, &pubkey);
            return Err(map_funder_err(e));
        }
    };
    let (status, txid) = match await_op(&funder, &opid, 25).await {
        Ok(v) => v,
        Err(e) => {
            let db = net.db();
            let _ = db::release_wallet_faucet(&db, &pubkey);
            return Err(e.into());
        }
    };
    // zecd accepted the transfer, so these zats belong to the identity now.
    // The ledger — not the note set, which zecd refuses to split per address
    // — is what the user will see and spend from here on.
    {
        let db = net.db();
        db::credit_wallet(&db, &pubkey, amount)?;
    }
    tracing::info!(
        address = %address,
        amount_zats = amount,
        txid = txid.as_deref().unwrap_or("-"),
        "faucet claim"
    );
    Ok((
        StatusCode::OK,
        Json(json!({
            "status": status,
            "txid": txid,
            "amount_zats": amount,
            "address": address,
        })),
    ))
}

#[derive(serde::Deserialize)]
struct WalletSend {
    to: String,
    amount_zec: String,
    #[serde(default)]
    memo: Option<String>,
}

/// Arbitrary send from the identity's hosted address.
async fn wallet_send(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<WalletSend>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let net = state.active();
    let pubkey = {
        let db = net.db();
        require_session(&db, &jar)?
    };
    let address = ensure_wallet_address(&net, &pubkey).await?;

    let to = body.to.trim().to_string();
    validate_user_address(&net, &to, "destination").await?;
    let amount = parse_zec(body.amount_zec.trim())
        .ok_or_else(|| ApiError::BadRequest("amount_zec must be a decimal ZEC amount".into()))?;
    if amount <= 0 {
        return Err(ApiError::BadRequest("amount must be positive".into()));
    }
    let memo = body.memo.as_deref().unwrap_or("").trim().to_string();
    if memo.len() > 512 {
        return Err(ApiError::BadRequest("memo exceeds 512 bytes".into()));
    }

    let funder = net.funder()?.clone();
    let balance = ledger_balance(&net, &pubkey)?;
    if amount > balance {
        return Err(ApiError::BadRequest(format!(
            "insufficient balance: have {balance} zats, need {amount} zats"
        )));
    }

    let (status, txid) = ledger_transfer(
        &net,
        &funder,
        &pubkey,
        &address,
        &to,
        amount,
        if memo.is_empty() { None } else { Some(&memo) },
    )
    .await?;
    // When the destination is another hosted identity the value stayed inside
    // the ledger, so credit it there; external addresses are paid on chain
    // and simply leave the ledger.
    {
        let db = net.db();
        if let Some(recipient) = db::wallet_pubkey_by_address(&db, &to)? {
            db::credit_wallet(&db, &recipient, amount)?;
        }
    }
    tracing::info!(to = %to, amount_zats = amount, txid = txid.as_deref().unwrap_or("-"), "wallet send");
    Ok((
        StatusCode::OK,
        Json(json!({ "status": status, "txid": txid, "amount_zats": amount, "to": to })),
    ))
}

/// Pay a bid you already registered, from your hosted address to the
/// auctioneer escrow, with the `bid:<uuid>` memo the detector matches on.
async fn pay_bid(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Path(bid_id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let net = state.active();
    let (pubkey, amount, target_bid, auction_open) = {
        let db = net.db();
        let pubkey = require_session(&db, &jar)?;
        let bid = db::get_bid(&db, &bid_id)?
            .ok_or_else(|| ApiError::NotFound("bid not found".into()))?;
        if bid.user_pubkey.as_deref() != Some(pubkey.as_str()) {
            return Err(ApiError::Forbidden(
                "this bid belongs to another identity".into(),
            ));
        }
        match bid.status.as_str() {
            "registered" | "detected" | "confirmed" => {}
            "missed" => {
                return Err(ApiError::Conflict(
                    "bid window closed; this bid was never paid".into(),
                ))
            }
            other => {
                return Err(ApiError::Conflict(format!(
                    "bid is already {other}; nothing to pay"
                )))
            }
        }
        let auction = db::get_auction(&db, &bid.auction_id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        // Only the unpaid remainder moves on chain. `paid_zats` is what this
        // server has already sent, so a top-up does not re-send the whole
        // registered total. Using the chain's confirmed amount here would
        // under-send whenever a prior payment is still in the mempool.
        let outstanding = bid.registered_amount_zats - bid.paid_zats;
        (pubkey, outstanding, bid.id.clone(), auction.status == "open" && now() < auction.closes_at)
    };
    if !auction_open {
        return Err(ApiError::Conflict("auction is closed".into()));
    }
    if amount <= 0 {
        return Err(ApiError::Conflict(
            "bid is already fully funded on chain; nothing outstanding to pay".into(),
        ));
    }

    let address = ensure_wallet_address(&net, &pubkey).await?;
    let funder = net.funder()?.clone();
    let balance = ledger_balance(&net, &pubkey)?;
    if amount > balance {
        return Err(ApiError::BadRequest(format!(
            "insufficient balance: have {balance} zats, bid needs {amount} zats — claim the faucet"
        )));
    }

    let memo = format!("bid:{bid_id}");
    let (status, txid) = ledger_transfer(
        &net,
        &funder,
        &pubkey,
        &address,
        &net.auctioneer_ua(),
        amount,
        Some(&memo),
    )
    .await?;
    // Book the send immediately so a second top-up before the detector sees
    // this payment sends only the remaining remainder, never the full total.
    {
        let db = net.db();
        db::credit_bid_paid(&db, &target_bid, amount)?;
    }
    tracing::info!(bid_id = %bid_id, amount_zats = amount, txid = txid.as_deref().unwrap_or("-"), "bid paid from hosted wallet");
    Ok((
        StatusCode::OK,
        Json(json!({ "status": status, "txid": txid, "amount_zats": amount, "memo": memo })),
    ))
}

/// Escrow the seller's collateral from the identity's hosted address.
async fn pay_collateral(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let net = state.active();
    let pubkey = {
        let db = net.db();
        let auction = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        require_seller(&db, &jar, &auction)?
    };
    let (amount, already_paid) = {
        let db = net.db();
        let auction = db::get_auction(&db, &id)?.expect("auction re-read");
        (auction.collateral_zats, auction.collateral_txid.is_some())
    };
    if amount <= 0 {
        return Err(ApiError::NotFound("this lot requires no collateral".into()));
    }
    if already_paid {
        return Err(ApiError::Conflict("collateral already escrowed".into()));
    }

    let address = ensure_wallet_address(&net, &pubkey).await?;
    let funder = net.funder()?.clone();
    let balance = ledger_balance(&net, &pubkey)?;
    if amount > balance {
        return Err(ApiError::BadRequest(format!(
            "insufficient balance: have {balance} zats, collateral needs {amount} zats"
        )));
    }

    let memo = format!("collateral:{id}");
    let (status, txid) = ledger_transfer(
        &net,
        &funder,
        &pubkey,
        &address,
        &net.auctioneer_ua(),
        amount,
        Some(&memo),
    )
    .await?;
    tracing::info!(auction_id = %id, amount_zats = amount, txid = txid.as_deref().unwrap_or("-"), "collateral paid from hosted wallet");
    Ok((
        StatusCode::OK,
        Json(json!({ "status": status, "txid": txid, "amount_zats": amount, "memo": memo })),
    ))
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Health {
    pub ok: bool,
    pub wallet_ready: bool,
    pub wallet_balance_zats: i64,
    /// Every hosted identity's balance summed: what the hosted wallet owes.
    pub wallet_ledger_zats: i64,
    /// The funder's unspent shielded notes backing that ledger. The demo
    /// must never let this fall below `wallet_ledger_zats`.
    ///
    /// `0` here is ambiguous on its own — it also reads as "funder broke" —
    /// so `funder_ready` disambiguates: false means the RPC never answered.
    pub funder_shielded_zats: i64,
    /// Whether the funder's RPC answered this request at all. False means the
    /// wallet is unreachable (still booting, or gone), which is a different
    /// problem from a reachable wallet that happens to hold nothing.
    pub funder_ready: bool,
    pub auctioneer_ua: String,
    pub network: String,
    pub chain: String,
    /// Confirmations a bid must reach before it is settlement-eligible. Per
    /// network, so the UI must not assume a constant.
    pub conf_target: i64,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    let net = state.active();
    let wallet_ready = net.zecd.ready().await;
    let balance = net
        .zecd
        .get_balance_zats()
        .await
        .map_err(|e| e.to_string())
        .unwrap_or(0);
    // Ledger first (cheap, local), then one RPC for the shielded notes that
    // back it — the pair is the hosted wallet's solvency statement.
    let wallet_ledger_zats = {
        let db = net.db();
        db::total_wallet_balances(&db).unwrap_or(0)
    };
    // `ready` tracks whether the RPC answered at all, not whether it holds
    // anything: a wallet that is still booting and one that is empty both
    // report zero notes, and only the first is a transient condition.
    let (funder_ready, funder_shielded_zats) = match net.funder() {
        Ok(funder) => match funder.list_unspent().await {
            Ok(notes) => (
                true,
                notes
                    .iter()
                    // Shielded rows only, and keyed on the pool rather than
                    // the address: change notes carry a null address but are
                    // still real backing.
                    .filter(|n| n.pool.as_deref().is_some_and(|p| p != "transparent"))
                    .map(|n| zecd_client::zats(n.amount))
                    .sum(),
            ),
            // The wallet never answered: still booting, or gone.
            Err(e @ zecd_client::Error::Transport(_)) => {
                tracing::warn!(error = %e, "funder rpc unreachable");
                (false, 0)
            }
            // The wallet answered but the call failed — reachable, so only
            // the balance is unknown.
            Err(e) => {
                tracing::warn!(error = %e, "funder list_unspent failed");
                (true, 0)
            }
        },
        // No funder configured for this network.
        Err(_) => (false, 0),
    };
    Json(Health {
        ok: wallet_ready,
        wallet_ready,
        wallet_balance_zats: balance,
        wallet_ledger_zats,
        funder_shielded_zats,
        funder_ready,
        auctioneer_ua: net.auctioneer_ua(),
        network: net.name.clone(),
        chain: net.chain.clone(),
        conf_target: net.conf_target,
    })
}

async fn privacy(State(state): State<Arc<AppState>>) -> Json<Value> {
    let net = state.active();
    Json(json!({
        "chain": net.chain,
        "pool": "ironwood",
        "conf_target": net.conf_target,
        "commission_bps": state.cfg.commission_bps,
        "min_bid_zats": state.cfg.min_bid_zats,
        "min_bid_zec": format!("{:.8}", state.cfg.min_bid_zats as f64 / 1e8),
        "auctioneer_ua": net.auctioneer_ua(),
        "rpc_auth": "HTTP Basic, per-service credentials held only by the API container",
        "ip_logging": "none: the API stores no client IPs and sets no analytics",
        "bid_confidentiality": "bidders cannot see each other's bids; bid amounts are revealed only after settlement",
        "memo_channel": "bid id travels in the encrypted shielded memo; only the auctioneer (receiver) can read it",
        "onchain_view": "observers see shielded-only transfers and timings, never amounts or addresses",
    }))
}

async fn list_auctions(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<Auction>>, ApiError> {
    let net = state.active();
    let db = net.db();
    require_session(&db, &jar)?;
    Ok(Json(db::list_auctions(&db)?))
}

#[derive(serde::Deserialize)]
struct CreateAuction {
    title: String,
    #[serde(default)]
    description: String,
    reserve_zec: String,
    duration_secs: i64,
    seller_address: String,
    /// Public image gallery: https URLs only (max 6).
    #[serde(default)]
    images: Vec<String>,
    /// Marketplace category (wl, wallet, nft, alpha, collectible, other).
    #[serde(default = "default_category")]
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    /// Seller's hidden floor — never echoed to any client.
    #[serde(default)]
    hidden_reserve_zec: Option<String>,
    /// Optional buy-it-now price (public).
    #[serde(default)]
    bin_price_zec: Option<String>,
    /// Optional seller collateral (escrowed via `collateral:<id>` memo).
    #[serde(default)]
    collateral_zec: Option<String>,
    /// Encrypted-delivery payload: released only to the winning bid.
    #[serde(default)]
    delivery_payload: Option<String>,
    /// Seller's declared refund policy (public transparency label). Cannot be
    /// enforced on-chain; pairs with collateral as skin-in-the-game.
    #[serde(default)]
    refund_policy: Option<String>,
    /// Seller's contact note for the winning bidder (Telegram/email…).
    /// Escrowed server-side; readable only by the winning bidder once the
    /// lot settles. Never public.
    #[serde(default)]
    seller_contact: Option<String>,
    /// How the winner receives the goods: "digital" (payload/contact — short
    /// auto-release window) or "physical" (shipping — long window).
    #[serde(default = "default_delivery_kind")]
    delivery_kind: String,
}

fn default_category() -> String {
    "other".into()
}

fn default_delivery_kind() -> String {
    "digital".into()
}

const CATEGORIES: &[&str] = &["wl", "wallet", "nft", "alpha", "collectible", "other"];
const MAX_IMAGES: usize = 6;
const MAX_TAGS: usize = 10;
const MAX_PAYLOAD: usize = 4000;

fn validate_images(images: &[String]) -> Result<Vec<String>, ApiError> {
    if images.len() > MAX_IMAGES {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_IMAGES} images"
        )));
    }
    for u in images {
        let u = u.trim();
        if u.len() > 2048 || !u.starts_with("https://") {
            return Err(ApiError::BadRequest(
                "each image must be an https:// URL of at most 2048 chars".into(),
            ));
        }
    }
    Ok(images.iter().map(|u| u.trim().to_string()).collect())
}

fn validate_tags(tags: &[String]) -> Result<Vec<String>, ApiError> {
    if tags.len() > MAX_TAGS {
        return Err(ApiError::BadRequest(format!("at most {MAX_TAGS} tags")));
    }
    for t in tags {
        let t = t.trim();
        if t.is_empty() || t.len() > 32 {
            return Err(ApiError::BadRequest(
                "each tag must be 1-32 chars".into(),
            ));
        }
    }
    Ok(tags.iter().map(|t| t.trim().to_string()).collect())
}

async fn create_auction(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<CreateAuction>,
) -> Result<(StatusCode, Json<Auction>), ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let Some((seller_pubkey, _)) = ({
        let net = state.active();
        let db = net.db();
        session_pubkey(&db, &jar)
    }) else {
        return Err(ApiError::Unauthorized(
            "sign in required to list a lot".into(),
        ));
    };
    let title = body.title.trim().to_string();
    if title.is_empty() || title.len() > 200 {
        return Err(ApiError::BadRequest("title must be 1-200 chars".into()));
    }
    let description = body.description.trim().to_string();
    if description.len() > 4000 {
        return Err(ApiError::BadRequest(
            "description must be <= 4000 chars".into(),
        ));
    }
    let reserve_zats = parse_zec(&body.reserve_zec)
        .ok_or_else(|| ApiError::BadRequest("reserve_zec must be a decimal ZEC amount".into()))?;
    if reserve_zats < 0 {
        return Err(ApiError::BadRequest("reserve must be >= 0".into()));
    }
    if reserve_zats > state.cfg.max_bid_zats {
        return Err(ApiError::BadRequest("reserve exceeds maximum".into()));
    }
    if body.duration_secs < state.cfg.min_duration_secs
        || body.duration_secs > state.cfg.max_duration_secs
    {
        return Err(ApiError::BadRequest(format!(
            "duration_secs must be between {} and {}",
            state.cfg.min_duration_secs, state.cfg.max_duration_secs
        )));
    }
    let seller_address = body.seller_address.trim().to_string();
    {
        let net = state.active();
        validate_user_address(&net, &seller_address, "seller_address").await?;
    }
    let images = validate_images(&body.images)?;
    let category = body.category.trim().to_lowercase();
    if !CATEGORIES.contains(&category.as_str()) {
        return Err(ApiError::BadRequest(format!(
            "category must be one of {CATEGORIES:?}"
        )));
    }
    let tags = validate_tags(&body.tags)?;
    let delivery_kind = body.delivery_kind.trim().to_lowercase();
    if delivery_kind != "digital" && delivery_kind != "physical" {
        return Err(ApiError::BadRequest(
            "delivery_kind must be \"digital\" or \"physical\"".into(),
        ));
    }
    let hidden_reserve_zats = match &body.hidden_reserve_zec {
        Some(s) if !s.trim().is_empty() => {
            let z = parse_zec(s)
                .ok_or_else(|| ApiError::BadRequest("hidden_reserve_zec must be a decimal ZEC amount".into()))?;
            if z < 0 || z > state.cfg.max_bid_zats {
                return Err(ApiError::BadRequest("hidden reserve out of range".into()));
            }
            Some(z)
        }
        _ => None,
    };
    let bin_price_zats = match &body.bin_price_zec {
        Some(s) if !s.trim().is_empty() => {
            let z = parse_zec(s)
                .ok_or_else(|| ApiError::BadRequest("bin_price_zec must be a decimal ZEC amount".into()))?;
            if z <= reserve_zats || z > state.cfg.max_bid_zats {
                return Err(ApiError::BadRequest(
                    "buy-it-now price must be above the public reserve".into(),
                ));
            }
            Some(z)
        }
        _ => None,
    };
    let collateral_zats = match &body.collateral_zec {
        Some(s) if !s.trim().is_empty() => {
            let z = parse_zec(s)
                .ok_or_else(|| ApiError::BadRequest("collateral_zec must be a decimal ZEC amount".into()))?;
            if z <= 0 || z > state.cfg.max_bid_zats {
                return Err(ApiError::BadRequest("collateral out of range".into()));
            }
            z
        }
        _ => 0,
    };
    let delivery_payload = match &body.delivery_payload {
        Some(p) if !p.trim().is_empty() => {
            let p = p.trim().to_string();
            if p.len() > MAX_PAYLOAD {
                return Err(ApiError::BadRequest(format!(
                    "delivery payload must be <= {MAX_PAYLOAD} chars"
                )));
            }
            Some(p)
        }
        _ => None,
    };
    let refund_policy = match &body.refund_policy {
        Some(p) if !p.trim().is_empty() => {
            let p = p.trim().to_string();
            if p.len() > 500 {
                return Err(ApiError::BadRequest(
                    "refund_policy must be <= 500 chars".into(),
                ));
            }
            Some(p)
        }
        _ => None,
    };
    let seller_contact = match &body.seller_contact {
        Some(c) if !c.trim().is_empty() => {
            let c = c.trim().to_string();
            if c.len() > 300 {
                return Err(ApiError::BadRequest(
                    "seller_contact must be <= 300 chars".into(),
                ));
            }
            Some(c)
        }
        _ => None,
    };
    let auction = Auction {
        id: Uuid::new_v4().to_string(),
        title,
        description,
        reserve_zats,
        seller_address,
        seller_pubkey: Some(seller_pubkey),
        created_at: now(),
        closes_at: now() + body.duration_secs,
        status: "open".into(),
        settled_at: None,
        sold: None,
        price_zats: None,
        winner_bid_id: None,
        settlement_txid: None,
        settlement_opid: None,
        settlement_plan: None,
        images,
        category,
        tags,
        hidden_reserve_zats,
        bin_price_zats,
        collateral_zats,
        collateral_txid: None,
        delivery_kind,
        payout_state: None,
        payout_deadline: None,
        payout_txid: None,
        payout_opid: None,
        dispute_reason: None,
        delivery_proof: None,
        dispute_opened_at: None,
        delivery_payload,
        payload_claimed: false,
        refund_policy,
        seller_contact,
        winner_contact: None,
        contact_claimed: false,
    };
    let net = state.active();
    let db = net.db();
    db::insert_auction(&db, &auction)?;
    Ok((StatusCode::CREATED, Json(auction)))
}

#[derive(Serialize)]
struct AuctionDetail {
    id: String,
    title: String,
    description: String,
    reserve_zats: i64,
    seller_address: String,
    seller_pubkey: Option<String>,
    created_at: i64,
    closes_at: i64,
    status: String,
    settled_at: Option<i64>,
    sold: Option<bool>,
    price_zats: Option<i64>,
    winner_bid_id: Option<String>,
    settlement_txid: Option<String>,
    /// The exact settlement plan that was executed (every outgoing payment:
    /// bid refunds, winner excess refund, seller proceeds, collateral return).
    /// Present only once the auction has settled — the plan is persisted
    /// before the chain call so a refresh after settlement still shows the
    /// complete ledger, including the seller-side rows that carry no bid id.
    settlement: Option<settlement::Settlement>,
    bids: Option<Vec<Bid>>,
    registered_count: Option<usize>,
    images: Vec<String>,
    category: String,
    tags: Vec<String>,
    /// Whether a hidden reserve exists (never the value).
    has_hidden_reserve: bool,
    bin_price_zats: Option<i64>,
    collateral_zats: i64,
    collateral_txid: Option<String>,
    /// Whether a delivery payload exists (never the payload itself).
    has_delivery_payload: bool,
    payload_claimed: bool,
    /// Seller's declared refund policy (public transparency label).
    refund_policy: Option<String>,
    /// Whether the winning bidder has claimed the seller's contact note.
    contact_claimed: bool,
    /// How the winner receives the goods: "digital" or "physical". Drives the
    /// seller-payout auto-release window.
    delivery_kind: String,
    /// Two-phase seller payout state: "held" (awaiting winner confirm/dispute
    /// or auto-release), "released" (paid to seller), "slashed" (disputed —
    /// proceeds refunded, collateral forfeited to winner). Null before a sold
    /// lot settles.
    payout_state: Option<String>,
    /// When the held payout auto-releases to the seller (null = no deadline).
    payout_deadline: Option<i64>,
    payout_txid: Option<String>,
    /// Dispute state: the winner's non-delivery claim (recorded at dispute).
    dispute_reason: Option<String>,
    /// Seller's delivery proof submitted during the dispute evidence window.
    delivery_proof: Option<String>,
    /// When the dispute was opened (freezes auto-release, starts evidence window).
    dispute_opened_at: Option<i64>,
}

impl From<Auction> for AuctionDetail {
    fn from(a: Auction) -> Self {
        Self {
            id: a.id,
            title: a.title,
            description: a.description,
            reserve_zats: a.reserve_zats,
            seller_address: a.seller_address,
            seller_pubkey: a.seller_pubkey,
            created_at: a.created_at,
            closes_at: a.closes_at,
            status: a.status,
            settled_at: a.settled_at,
            sold: a.sold,
            price_zats: a.price_zats,
            winner_bid_id: a.winner_bid_id,
            settlement_txid: a.settlement_txid,
            settlement: None,
            bids: None,
            registered_count: None,
            images: a.images,
            category: a.category,
            tags: a.tags,
            has_hidden_reserve: a.hidden_reserve_zats.is_some(),
            bin_price_zats: a.bin_price_zats,
            collateral_zats: a.collateral_zats,
            collateral_txid: a.collateral_txid,
            has_delivery_payload: a.delivery_payload.is_some(),
            payload_claimed: a.payload_claimed,
            refund_policy: a.refund_policy,
            contact_claimed: a.contact_claimed,
            delivery_kind: a.delivery_kind,
            payout_state: a.payout_state,
            payout_deadline: a.payout_deadline,
            payout_txid: a.payout_txid,
            dispute_reason: a.dispute_reason,
            delivery_proof: a.delivery_proof,
            dispute_opened_at: a.dispute_opened_at,
        }
    }
}

async fn get_auction(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> Result<Json<AuctionDetail>, ApiError> {
    let (auction, bids) = {
        let net = state.active();
        let db = net.db();
        require_session(&db, &jar)?;
        let a = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        let bids = if a.status == "settled" {
            db::bids_for_auction(&db, &id)?
        } else {
            vec![]
        };
        (a, bids)
    };
    // Parse the persisted plan (the exact payments that were sent) so the
    // ledger can show the seller-side rows on any refresh, not only in the
    // one-shot settle response.
    let settlement = auction
        .settlement_plan
        .as_deref()
        .and_then(|p| serde_json::from_str::<settlement::Settlement>(p).ok());
    let mut detail = AuctionDetail::from(auction);
    if detail.status == "settled" {
        detail.registered_count = Some(bids.len());
        detail.bids = Some(bids);
        detail.settlement = settlement;
    }
    Ok(Json(detail))
}

#[derive(serde::Deserialize)]
struct PlaceBid {
    refund_address: String,
    amount_zec: String,
    /// Register as a buy-it-now purchase: amount must equal the lot's BIN
    /// price; a confirmed payment ends the Vickrey round.
    #[serde(default)]
    buy_now: bool,
}

#[derive(Serialize)]
struct PlaceBidResponse {
    bid_id: String,
    auction_id: String,
    memo: String,
    zip321_uri: String,
    amount_zats: i64,
    /// Running total this identity now has escrowed on this lot, including
    /// every prior deposit. `amount_zats` is only what this invoice adds.
    registered_amount_zats: i64,
    buy_now: bool,
}

async fn place_bid(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PlaceBid>,
) -> Result<(StatusCode, Json<PlaceBidResponse>), ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    // Bidding is identity-bound: a signed-in session is required so the
    // server can attribute a bid to a first-party key. This is what makes the
    // self-bid rejection below enforceable. The pubkey is a derived key,
    // unlinkable to the bidder's shielded funds address.
    let user_pubkey = {
        let net = state.active();
        let db = net.db();
        session_pubkey(&db, &jar).map(|(pk, _)| pk)
    };
    let Some(user_pubkey) = user_pubkey else {
        return Err(ApiError::Unauthorized(
            "sign in required to place a bid".into(),
        ));
    };
    let amount_zats = parse_zec(&body.amount_zec)
        .ok_or_else(|| ApiError::BadRequest("amount_zec must be a decimal ZEC amount".into()))?;
    if amount_zats < state.cfg.min_bid_zats {
        return Err(ApiError::BadRequest(format!(
            "bid below minimum of {:.8} ZEC",
            state.cfg.min_bid_zats as f64 / 1e8
        )));
    }
    let refund_address = body.refund_address.trim().to_string();
    let net = state.active();
    validate_user_address(&net, &refund_address, "refund_address").await?;
    // Bidding is one live bid per identity per auction: a second registration
    // tops up the deposit that identity already escrowed rather than opening
    // a competing position against itself. The bid id and memo are stable, so
    // the ZIP-321 invoice always addresses the same on-chain escrow.
    let (bid_id, memo_amount_zats, registered_total_zats) = {
        let db = net.db();
        let auction = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        // Self-bid rejection (anti-shill). The bidder's on-chain sending
        // address is hidden inside the shielded pool, so the server compares
        // the two identities it can actually see: the signed-in session pubkey
        // (bound to the seller at listing time) and the refund address the
        // bidder supplies. Either one matching the seller is refused.
        if auction.seller_pubkey.as_deref() == Some(user_pubkey.as_str()) {
            return Err(ApiError::Forbidden(
                "sellers cannot bid on their own lot".into(),
            ));
        }
        if refund_address == auction.seller_address {
            return Err(ApiError::BadRequest(
                "refund address matches the seller's payout address; sellers cannot bid on their own lot".into(),
            ));
        }
        if auction.status != "open" || now() >= auction.closes_at {
            return Err(ApiError::Conflict("auction is not accepting bids".into()));
        }
        if auction.collateral_zats > 0 && auction.collateral_txid.is_none() {
            return Err(ApiError::Conflict(
                "seller collateral not yet escrowed; bids open once it confirms".into(),
            ));
        }
        if body.buy_now {
            match auction.bin_price_zats {
                Some(bin) if bin == amount_zats => {}
                Some(bin) => {
                    return Err(ApiError::BadRequest(format!(
                        "buy-it-now amount must equal the listed price ({} ZEC)",
                        zecd_client::zec_str(bin)
                    )));
                }
                None => {
                    return Err(ApiError::BadRequest("this lot has no buy-it-now price".into()));
                }
            }
        }
        if let Some(existing) = db::live_bid_for_auction_user(&db, &id, &user_pubkey)? {
            if existing.is_buy_now {
                return Err(ApiError::Conflict(
                    "this identity already holds a buy-it-now bid on this lot".into(),
                ));
            }
            let new_total = db::raise_bid_registered_amount(&db, &existing.id, amount_zats)?
                .ok_or_else(|| ApiError::Conflict("bid is no longer live".into()))?;
            if new_total > state.cfg.max_bid_zats {
                return Err(ApiError::BadRequest(format!(
                    "bid exceeds maximum of {:.8} ZEC",
                    state.cfg.max_bid_zats as f64 / 1e8
                )));
            }
            tracing::info!(
                bid_id = %existing.id,
                added_zats = amount_zats,
                new_total_zats = new_total,
                "bid topped up"
            );
            (existing.id, amount_zats, new_total)
        } else {
            if amount_zats > state.cfg.max_bid_zats {
                return Err(ApiError::BadRequest("bid exceeds maximum".into()));
            }
            let bid_id = Uuid::new_v4().to_string();
            let bid = Bid {
                id: bid_id.clone(),
                auction_id: id.clone(),
                refund_address,
                registered_amount_zats: amount_zats,
                created_at: now(),
                status: "registered".into(),
                txid: None,
                confirmed_amount_zats: None,
                detected_at: None,
                confirmations: 0,
                refund_txid: None,
                refund_amount_zats: None,
                user_pubkey: Some(user_pubkey),
                is_buy_now: body.buy_now,
                paid_zats: 0,
            };
            db::insert_bid(&db, &bid)?;
            (bid_id, amount_zats, amount_zats)
        }
    };
    let memo = format!("bid:{bid_id}");
    // The invoice is for the amount being added right now, not the running
    // total: the prior deposit is already escrowed and must not be paid twice.
    let uri = zip321_uri(
        &net.auctioneer_ua(),
        &zecd_client::zec_str(memo_amount_zats),
        &memo,
    );
    Ok((
        StatusCode::CREATED,
        Json(PlaceBidResponse {
            bid_id,
            auction_id: id,
            memo,
            zip321_uri: uri,
            amount_zats: memo_amount_zats,
            registered_amount_zats: registered_total_zats,
            buy_now: body.buy_now,
        }),
    ))
}

async fn close_auction(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Auction>, ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let net = state.active();
    let db = net.db();
    let mut auction =
        db::get_auction(&db, &id)?.ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
    match auction.status.as_str() {
        "settled" | "canceled" | "settling" => {
            return Err(ApiError::Conflict(format!(
                "auction is {} and cannot be closed",
                auction.status
            )));
        }
        "closed" => return Ok(Json(auction)),
        _ => {}
    }
    // Status is "open" here. Early close is seller-only; past the close time
    // anyone may flip the flag (the detector would do it on its next sweep).
    if now() < auction.closes_at {
        require_seller(&db, &jar, &auction)?;
    }
    if !db::cas_auction_status(&db, &id, "open", "closed")? {
        return Err(ApiError::Conflict("auction already closed".into()));
    }
    auction.status = "closed".into();
    Ok(Json(auction))
}

#[derive(Serialize)]
struct CollateralInvoice {
    auction_id: String,
    amount_zats: i64,
    memo: String,
    zip321_uri: String,
    paid_txid: Option<String>,
}

/// ZIP-321 invoice for the seller to escrow their listing collateral. Public
/// Session-gated like every other read: the invoice names the auctioneer UA,
/// so it is not anonymous public data.
async fn collateral_invoice(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> Result<Json<CollateralInvoice>, ApiError> {
    let net = state.active();
    let db = net.db();
    require_session(&db, &jar)?;
    let auction = db::get_auction(&db, &id)?
        .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
    if auction.collateral_zats <= 0 {
        return Err(ApiError::NotFound("this lot requires no collateral".into()));
    }
    let memo = format!("collateral:{id}");
    let uri = zip321_uri(
        &net.auctioneer_ua(),
        &zecd_client::zec_str(auction.collateral_zats),
        &memo,
    );
    Ok(Json(CollateralInvoice {
        auction_id: id,
        amount_zats: auction.collateral_zats,
        memo,
        zip321_uri: uri,
        paid_txid: auction.collateral_txid,
    }))
}

#[derive(Serialize)]
struct SellerView {
    auction: AuctionDetail,
    hidden_reserve_zats: Option<i64>,
    delivery_payload: Option<String>,
}

/// Seller-only full record: hidden reserve + delivery payload. Requires the
/// signed-in identity to be the listing seller.
async fn seller_view(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> Result<Json<SellerView>, ApiError> {
    let net = state.active();
    let db = net.db();
    let auction = db::get_auction(&db, &id)?
        .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
    require_seller(&db, &jar, &auction)?;
    let hidden = auction.hidden_reserve_zats;
    let payload = auction.delivery_payload.clone();
    Ok(Json(SellerView {
        auction: AuctionDetail::from(auction),
        hidden_reserve_zats: hidden,
        delivery_payload: payload,
    }))
}

#[derive(serde::Deserialize)]
struct ClaimPayload {
    bid_id: String,
}

/// Winner-only delivery: the winning bid's ID is the capability. Returns the
/// seller's sealed payload (WL code, seed, invite…) exactly once the hammer
/// has fallen in that bid's favor.
async fn claim_payload(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ClaimPayload>,
) -> Result<Json<Value>, ApiError> {
    let net = state.active();
    let db = net.db();
    let auction = db::get_auction(&db, &id)?
        .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
    if auction.status != "settled" {
        return Err(ApiError::Conflict("auction not settled yet".into()));
    }
    if auction.sold != Some(true) {
        return Err(ApiError::Conflict("lot did not sell; no payload to claim".into()));
    }
    if auction.winner_bid_id.as_deref() != Some(body.bid_id.trim()) {
        return Err(ApiError::Forbidden(
            "only the winning bid may claim the delivery payload".into(),
        ));
    }
    let Some(payload) = auction.delivery_payload.clone() else {
        return Err(ApiError::NotFound("this lot carries no delivery payload".into()));
    };
    db::mark_payload_claimed(&db, &id)?;
    Ok(Json(json!({ "payload": payload })))
}

#[derive(serde::Deserialize)]
struct PayoutAction {
    /// Winning bid ID — the capability that authorizes confirm/dispute.
    bid_id: String,
}

/// Dispute request: the winner states non-delivery (optional free-text reason,
/// recorded as the buyer's claim for the review).
#[derive(serde::Deserialize)]
struct PayoutDisputeRequest {
    bid_id: String,
    #[serde(default)]
    reason: Option<String>,
}

/// Compute the phase-2 outputs for a held payout.
///   - Release (confirm / auto): seller receives proceeds (hammer less
///     commission) plus the returned collateral.
///   - Slash (dispute): the winner receives a full hammer refund plus the
///     forfeited collateral; the seller forfeits both.
fn payout_outputs(
    auction: &Auction,
    winner_refund: Option<&str>,
    commission_bps: i64,
    slash: bool,
) -> Result<Vec<(String, String)>, ApiError> {
    let hammer = auction.price_zats.unwrap_or(0);
    let collateral = auction.collateral_zats.max(0);
    let mut outputs = Vec::new();
    if slash {
        let to = winner_refund
            .ok_or_else(|| ApiError::Internal("winner refund address unavailable".into()))?
            .to_string();
        let amount = hammer + collateral;
        if amount > 0 {
            outputs.push((to, zecd_client::zec_str(amount)));
        }
    } else {
        let commission = settlement::commission_zats(hammer, commission_bps);
        let seller_proceeds = hammer - commission;
        if seller_proceeds > 0 {
            outputs.push((auction.seller_address.clone(), zecd_client::zec_str(seller_proceeds)));
        }
        if collateral > 0 {
            outputs.push((auction.seller_address.clone(), zecd_client::zec_str(collateral)));
        }
    }
    Ok(outputs)
}

/// Execute a claimed payout (release or slash): submit the batch, persist the
/// opid before waiting, then finalize. On RPC failure before any on-chain
/// effect, revert the in-flight marker to `revert_state` so the caller can
/// retry ('held' for confirm/auto-release, 'disputed' for a resolution).
async fn exec_payout(
    net: &NetworkRuntime,
    auction_id: &str,
    from_state: &str,
    to_state: &str,
    revert_state: &str,
    outputs: Vec<(String, String)>,
) -> Result<(), ApiError> {
    if outputs.is_empty() {
        // Nothing to move (e.g. zero-proceeds edge): just finalize.
        db::finalize_payout(&net.db(), auction_id, from_state, to_state, None)?;
        return Ok(());
    }
    let opid = match net
        .zecd
        .send_shielded_batch(&net.auctioneer_ua(), &outputs)
        .await
    {
        Ok(opid) => opid,
        Err(e) => {
            let _ = db::revert_payout_inflight(&net.db(), auction_id, revert_state);
            return Err(ApiError::Zecd(e.to_string()));
        }
    };
    db::set_payout_opid(&net.db(), auction_id, &opid)?;
    match settle_exec::wait_for_op(&net.zecd, &opid, 180).await {
        Ok(txid) => {
            db::finalize_payout(&net.db(), auction_id, from_state, to_state, Some(&txid))?;
            Ok(())
        }
        Err(e) => Err(ApiError::Busy(format!(
            "payout submitted (opid {opid}) but not yet confirmed: {e}; it will finalize automatically"
        ))),
    }
}

/// Winner confirms delivery: release the held seller proceeds + collateral.
async fn payout_confirm(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PayoutAction>,
) -> Result<Json<Value>, ApiError> {
    let net = state.active();
    let auction = {
        let db = net.db();
        let auction = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        if auction.status != "settled" || auction.sold != Some(true) {
            return Err(ApiError::Conflict("nothing to confirm on this lot".into()));
        }
        if auction.winner_bid_id.as_deref() != Some(body.bid_id.trim()) {
            return Err(ApiError::Forbidden(
                "only the winning bid may confirm delivery".into(),
            ));
        }
        if !db::claim_payout(&db, &id, "held", "releasing")? {
            return Err(ApiError::Conflict(
                "payout is not awaiting confirmation (already released, disputed, or in flight)"
                    .into(),
            ));
        }
        auction
    };
    let outputs = payout_outputs(&auction, None, state.cfg.commission_bps, false)?;
    exec_payout(&net, &id, "releasing", "released", "held", outputs).await?;
    Ok(Json(json!({ "payout_state": "released" })))
}

/// Winner disputes delivery: FREEZE the payout (no money moves) and open an
/// evidence window. The seller's proceeds and collateral stay in escrow — they
/// are neither released to the seller nor slashed to the winner until an
/// operator resolves, or the digital auto-rule fires after the window. This
/// prevents a buyer from taking goods + money by claiming non-delivery.
async fn payout_dispute(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PayoutDisputeRequest>,
) -> Result<Json<Value>, ApiError> {
    let net = state.active();
    {
        let db = net.db();
        let auction = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        if auction.status != "settled" || auction.sold != Some(true) {
            return Err(ApiError::Conflict("nothing to dispute on this lot".into()));
        }
        if auction.winner_bid_id.as_deref() != Some(body.bid_id.trim()) {
            return Err(ApiError::Forbidden(
                "only the winning bid may dispute delivery".into(),
            ));
        }
        let reason = body
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or("Buyer reports the goods were not delivered.")
            .to_string();
        if reason.len() > 500 {
            return Err(ApiError::BadRequest("dispute reason must be <= 500 chars".into()));
        }
        // Evidence window keyed off delivery kind: the digital auto-rule can
        // only fire after this passes; physical stays frozen for the operator.
        let window = if auction.delivery_kind == "physical" {
            state.cfg.payout_deadline_physical_secs
        } else {
            state.cfg.payout_deadline_digital_secs
        };
        let deadline = if window > 0 { Some(now() + window) } else { None };
        if !db::open_dispute(&db, &id, &reason, now(), deadline)? {
            return Err(ApiError::Conflict(
                "payout is not awaiting dispute (already released, resolved, or in flight)"
                    .into(),
            ));
        }
    }
    Ok(Json(json!({ "payout_state": "disputed" })))
}

#[derive(serde::Deserialize)]
struct DeliveryProofRequest {
    /// Seller's delivery evidence: tracking number, signed payload hash, etc.
    proof: String,
}

/// Seller submits delivery proof during a dispute's evidence window. Recorded
/// once (one-shot) so neither side can rewrite evidence after seeing it. The
/// operator weighs this against the buyer's reason when resolving.
async fn payout_delivery_proof(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<DeliveryProofRequest>,
) -> Result<Json<Value>, ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let proof = body.proof.trim().to_string();
    if proof.is_empty() {
        return Err(ApiError::BadRequest("proof must be non-empty".into()));
    }
    if proof.len() > 1000 {
        return Err(ApiError::BadRequest("proof must be <= 1000 chars".into()));
    }
    let net = state.active();
    {
        let db = net.db();
        let auction = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        require_seller(&db, &jar, &auction)?;
        if !db::set_delivery_proof(&db, &id, &proof)? {
            return Err(ApiError::Conflict(
                "no open dispute, or proof already submitted".into(),
            ));
        }
    }
    Ok(Json(json!({ "delivery_proof": proof })))
}

#[derive(serde::Deserialize)]
struct PayoutResolveRequest {
    /// "release" (seller gets proceeds + collateral) or "slash" (winner gets
    /// hammer + collateral; sale voided).
    action: String,
}

/// Operator resolves a disputed payout after the evidence window. The demo
/// operator model is any signed-in session (same trust level as
/// `switch_network`); production should gate this on a dedicated operator key.
/// The digital auto-rule (disputed + payload claimed + window passed) is
/// handled by the recovery sweep, not here.
async fn payout_resolve(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PayoutResolveRequest>,
) -> Result<Json<Value>, ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let slash = match body.action.trim() {
        "release" => false,
        "slash" => true,
        other => {
            return Err(ApiError::BadRequest(format!(
                "action must be \"release\" or \"slash\" (got {other})"
            )))
        }
    };
    let net = state.active();
    // Operator gate: a signed-in session that is NEITHER the seller nor the
    // winning bidder (those two principals would self-serve). Demo model —
    // production should gate on a dedicated operator key instead.
    {
        let db = net.db();
        let Some((pubkey, _)) = session_pubkey(&db, &jar) else {
            return Err(ApiError::Unauthorized(
                "sign in required to resolve a dispute".into(),
            ));
        };
        let auction = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        if auction.seller_pubkey.as_deref() == Some(pubkey.as_str()) {
            return Err(ApiError::Forbidden(
                "the seller cannot resolve their own dispute".into(),
            ));
        }
        let winner_pubkey = auction
            .winner_bid_id
            .as_deref()
            .and_then(|bid_id| db::get_bid(&db, bid_id).ok().flatten())
            .and_then(|b| b.user_pubkey);
        if winner_pubkey.as_deref() == Some(pubkey.as_str()) {
            return Err(ApiError::Forbidden(
                "the winning bidder cannot resolve their own dispute".into(),
            ));
        }
    }
    let auction = {
        let db = net.db();
        let auction = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        if auction.payout_state.as_deref() != Some("disputed") {
            return Err(ApiError::Conflict("payout is not in dispute".into()));
        }
        auction
    };
    let (to_state, target_state) = if slash {
        ("slashing", "slashed")
    } else {
        ("releasing", "released")
    };
    let winner_refund = if slash {
        auction
            .winner_bid_id
            .as_deref()
            .and_then(|bid_id| db::get_bid(&net.db(), bid_id).ok().flatten())
            .map(|b| b.refund_address)
    } else {
        None
    };
    {
        let db = net.db();
        if !db::claim_payout(&db, &id, "disputed", to_state)? {
            return Err(ApiError::Conflict(
                "dispute already resolved or in flight".into(),
            ));
        }
    }
    let commission = if slash { 0 } else { state.cfg.commission_bps };
    let outputs = payout_outputs(&auction, winner_refund.as_deref(), commission, slash)?;
    exec_payout(&net, &id, to_state, target_state, "disputed", outputs).await?;
    Ok(Json(json!({ "payout_state": target_state })))
}

#[derive(serde::Deserialize)]
struct SetContact {
    /// Winning bidder's contact note, when the caller is the winner. Ignored
    /// for the seller path.
    #[serde(default)]
    contact: Option<String>,
    /// Winning bid ID. Required when the caller is the winning bidder (the
    /// bid ID is the capability); omitted for the seller path.
    #[serde(default)]
    bid_id: Option<String>,
}

/// Post-settlement contact escrow. Each side escrows a contact note
/// (Telegram/email…) that only the counterparty can read:
///   - the seller writes and reads via their signed-in session;
///   - the winning bidder writes and reads via the winning bid ID.
///
/// One-shot per side: a second write is refused so neither party can swap
/// details after the other has seen them. Never public, only on a settled
/// and sold lot.
async fn set_contact(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(body): Json<SetContact>,
) -> Result<Json<Value>, ApiError> {
    let contact = body
        .contact
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .ok_or_else(|| ApiError::BadRequest("contact must be a non-empty string".into()))?
        .to_string();
    if contact.len() > 300 {
        return Err(ApiError::BadRequest("contact must be <= 300 chars".into()));
    }
    let net = state.active();
    let db = net.db();
    let auction = db::get_auction(&db, &id)?
        .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
    if auction.status != "settled" || auction.sold != Some(true) {
        return Err(ApiError::Conflict(
            "contact escrow opens only after the lot settles and sells".into(),
        ));
    }
    // Seller path: signed-in identity must be the listing seller. Checked
    // directly (not via require_seller) so a non-seller falls through to the
    // winner path instead of erroring here.
    let caller_is_seller = session_pubkey(&db, &jar)
        .map(|(pk, _)| auction.seller_pubkey.as_deref() == Some(pk.as_str()))
        .unwrap_or(false);
    if caller_is_seller {
        if !db::set_seller_contact(&db, &id, &contact)? {
            return Err(ApiError::Conflict(
                "seller contact already escrowed; it cannot be changed".into(),
            ));
        }
        return Ok(Json(json!({
            "role": "seller",
            "counterparty_contact": auction.winner_contact,
        })));
    }
    // Winner path: the winning bid ID is the capability.
    let bid_id = body
        .bid_id
        .as_deref()
        .map(str::trim)
        .ok_or_else(|| ApiError::Unauthorized("sign in as seller or present the winning bid_id".into()))?;
    if auction.winner_bid_id.as_deref() != Some(bid_id) {
        return Err(ApiError::Forbidden(
            "only the winning bid may escrow a contact note".into(),
        ));
    }
    if !db::set_winner_contact(&db, &id, &contact)? {
        return Err(ApiError::Conflict(
            "winner contact already escrowed; it cannot be changed".into(),
        ));
    }
    Ok(Json(json!({
        "role": "winner",
        "counterparty_contact": auction.seller_contact,
    })))
}

/// Read the counterparty's escrowed contact note. Seller reads via session;
/// winning bidder reads via the winning bid ID. Reading also marks the
/// seller's note as claimed (so the board can show delivery progress).
async fn get_contact(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let net = state.active();
    let db = net.db();
    let auction = db::get_auction(&db, &id)?
        .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
    if auction.status != "settled" || auction.sold != Some(true) {
        return Err(ApiError::Conflict(
            "contact escrow opens only after the lot settles and sells".into(),
        ));
    }
    // Seller path.
    if require_seller(&db, &jar, &auction).is_ok() {
        if auction.winner_contact.is_some() {
            db::mark_contact_claimed(&db, &id)?;
        }
        return Ok(Json(json!({
            "role": "seller",
            "counterparty_contact": auction.winner_contact,
            "seller_contact_escrowed": auction.seller_contact.is_some(),
        })));
    }
    Err(ApiError::Unauthorized(
        "sign in as the seller to read the winner's contact".into(),
    ))
}

/// Winner-only read of the seller's contact note, keyed by the winning bid ID.
async fn claim_contact(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ClaimPayload>,
) -> Result<Json<Value>, ApiError> {
    let net = state.active();
    let db = net.db();
    let auction = db::get_auction(&db, &id)?
        .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
    if auction.status != "settled" || auction.sold != Some(true) {
        return Err(ApiError::Conflict(
            "contact escrow opens only after the lot settles and sells".into(),
        ));
    }
    if auction.winner_bid_id.as_deref() != Some(body.bid_id.trim()) {
        return Err(ApiError::Forbidden(
            "only the winning bid may claim the seller's contact".into(),
        ));
    }
    if auction.seller_contact.is_some() {
        db::mark_contact_claimed(&db, &id)?;
    }
    Ok(Json(json!({
        "role": "winner",
        "counterparty_contact": auction.seller_contact,
        "winner_contact_escrowed": auction.winner_contact.is_some(),
    })))
}

#[derive(Serialize)]
struct BidStatusResponse {
    id: String,
    auction_id: String,
    status: String,
    confirmations: i64,
    registered_amount_zats: i64,
    confirmed_amount_zats: Option<i64>,
    txid: Option<String>,
    refund_txid: Option<String>,
    refund_amount_zats: Option<i64>,
}

async fn get_bid(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(bid_id): Path<String>,
) -> Result<Json<BidStatusResponse>, ApiError> {
    let net = state.active();
    let db = net.db();
    require_session(&db, &jar)?;
    let bid =
        db::get_bid(&db, &bid_id)?.ok_or_else(|| ApiError::NotFound("bid not found".into()))?;
    Ok(Json(BidStatusResponse {
        id: bid.id,
        auction_id: bid.auction_id,
        status: bid.status,
        confirmations: bid.confirmations,
        registered_amount_zats: bid.registered_amount_zats,
        confirmed_amount_zats: bid.confirmed_amount_zats,
        txid: bid.txid,
        refund_txid: bid.refund_txid,
        refund_amount_zats: bid.refund_amount_zats,
    }))
}

#[derive(Serialize)]
struct DashboardAuction {
    auction: Auction,
    bids: Vec<Bid>,
}

#[derive(Serialize)]
struct Dashboard {
    auctions: Vec<DashboardAuction>,
    wallet_balance_zats: i64,
    auctioneer_ua: String,
    conf_target: i64,
}

async fn dashboard(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Dashboard>, ApiError> {
    let net = state.active();
    {
        let db = net.db();
        require_session(&db, &jar)?;
    }
    let auctions = {
        let db = net.db();
        db::list_auctions(&db)?
    };
    let mut out = Vec::new();
    {
        let db = net.db();
        for auction in auctions {
            // Sealed until settlement: never expose bid rows pre-hammer.
            let bids = if auction.status == "settled" {
                db::bids_for_auction(&db, &auction.id)?
            } else {
                vec![]
            };
            out.push(DashboardAuction { auction, bids });
        }
    }
    let balance = net.zecd.get_balance_zats().await.unwrap_or(0);
    Ok(Json(Dashboard {
        auctions: out,
        wallet_balance_zats: balance,
        auctioneer_ua: net.auctioneer_ua(),
        conf_target: net.conf_target,
    }))
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/// Finalize a settlement from its plan: mark bid refund rows and record the
/// outcome. Used both by the live settle path and by crash recovery, so a
/// restart cannot recompute a different plan. Takes the plan directly — the
/// caller's auction struct may have been fetched before the plan was
/// persisted.
fn finalize_settlement(
    state: &Arc<AppState>,
    net: &NetworkRuntime,
    auction_id: &str,
    plan: &settlement::Settlement,
    settlement_txid: Option<&str>,
) -> Result<(), ApiError> {
    let now_ts = now();
    let db = net.db();
    for p in &plan.payments {
        let (status, amount) = match p.kind {
            settlement::PaymentKind::WinnerExcessRefund => ("won", p.amount_zats),
            settlement::PaymentKind::BidRefund => ("refunded", p.amount_zats),
            // Orchestration-level (collateral return): nothing to mark on a
            // bid row.
            settlement::PaymentKind::SellerProceeds
            | settlement::PaymentKind::CollateralRefund => continue,
        };
        if let Some(bid_id) = &p.bid_id {
            db::mark_bid_refund(
                &db,
                bid_id,
                settlement_txid.unwrap_or_default(),
                amount,
                status,
            )?;
        }
    }
    db::record_settlement(
        &db,
        auction_id,
        plan.sold,
        plan.price_zats,
        plan.winner_bid_id.as_deref(),
        settlement_txid,
        now_ts,
    )?;
    // Two-phase payout: on a sold lot, HELD the seller's proceeds and
    // collateral (they were excluded from the batch above). Arm the
    // auto-release deadline keyed off the delivery kind.
    if plan.sold {
        if let Some(a) = db::get_auction(&db, auction_id)? {
            let window = if a.delivery_kind == "physical" {
                state.cfg.payout_deadline_physical_secs
            } else {
                state.cfg.payout_deadline_digital_secs
            };
            let deadline = if window > 0 { Some(now_ts + window) } else { None };
            if let Err(e) = db::hold_payout(&db, auction_id, deadline) {
                tracing::error!(auction = %auction_id, "failed to arm payout hold: {e}");
            }
        }
    }
    Ok(())
}

/// Revert a `settling` auction back to `closed` when the failure happened
/// before any on-chain effect (RPC rejected, plan computation failed).
fn revert_settling(net: &NetworkRuntime, id: &str) {
    let db = net.db();
    if let Err(e) = db::revert_settling(&db, id) {
        tracing::error!(auction = %id, "failed to revert settling status: {e}");
    }
}

async fn settle_auction(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let net = state.active();

    // Guard the state machine before doing any work.
    {
        let db = net.db();
        let auction = db::get_auction(&db, &id)?
            .ok_or_else(|| ApiError::NotFound("auction not found".into()))?;
        match auction.status.as_str() {
            "settled" => return Err(ApiError::Conflict("auction already settled".into())),
            "canceled" => return Err(ApiError::Conflict("auction canceled".into())),
            "settling" => {
                return Err(ApiError::Conflict(
                    "settlement already in progress; it will finalize automatically".into(),
                ))
            }
            "open" if now() < auction.closes_at => {
                return Err(ApiError::Conflict("auction still open".into()))
            }
            "open" => {
                db::cas_auction_status(&db, &id, "open", "closed")?;
            }
            _ => {}
        }
    }

    // Atomically claim the settlement. Exactly one caller can win this CAS;
    // everyone else gets a conflict instead of a second z_sendmany.
    let claimed = {
        let db = net.db();
        db::cas_auction_status(&db, &id, "closed", "settling")?
    };
    if !claimed {
        return Err(ApiError::Conflict("settlement already in progress".into()));
    }

    let prepared = prepare_settlement(&state, &net, &id).await;
    let settlement = match prepared {
        Ok(s) => s,
        Err(e) => {
            revert_settling(&net, &id);
            return Err(e);
        }
    };

    // Persist the exact plan before touching the chain: crash recovery
    // replays this JSON rather than recomputing (bids could have been
    // marked missed in the interim, which would change the math).
    {
        let db = net.db();
        let plan_json =
            serde_json::to_string(&settlement).map_err(|e| ApiError::Internal(e.to_string()))?;
        db::set_settlement_plan(&db, &id, &plan_json)?;
    }

    // Phase 1 pays bidders only. The seller's proceeds and collateral are
    // HELD in the auctioneer wallet until the winning bidder confirms
    // delivery (or the deadline auto-releases). The full plan (including the
    // seller-side rows) is persisted above so the UI ledger shows them; only
    // the bidder-facing payments go out now.
    let mut outputs: Vec<(String, String)> = Vec::new();
    for p in &settlement.payments {
        // SellerProceeds and CollateralRefund are the held rows.
        if matches!(
            p.kind,
            settlement::PaymentKind::SellerProceeds | settlement::PaymentKind::CollateralRefund
        ) {
            continue;
        }
        outputs.push((p.to.clone(), zecd_client::zec_str(p.amount_zats)));
    }

    let settlement_txid = if outputs.is_empty() {
        None
    } else {
        let opid = match net
            .zecd
            .send_shielded_batch(&net.auctioneer_ua(), &outputs)
            .await
        {
            Ok(opid) => opid,
            Err(e) => {
                revert_settling(&net, &id);
                return Err(ApiError::Zecd(e.to_string()));
            }
        };
        // Persist the opid *before* waiting: a crash here must leave enough
        // state for recovery to finish (or observe failure of) the transfer.
        {
            let db = net.db();
            db::set_settlement_opid(&db, &id, &opid)?;
        }
        match settle_exec::wait_for_op(&net.zecd, &opid, 180).await {
            Ok(txid) => Some(txid),
            Err(e) => {
                // Do NOT revert: the operation may still be live on zecd.
                // Recovery observes the opid and finalizes or reverts later.
                return Err(ApiError::Busy(format!(
                    "settlement submitted (opid {opid}) but not yet confirmed: {e}; it will finalize automatically"
                )));
            }
        }
    };

    finalize_settlement(&state, &net, &id, &settlement, settlement_txid.as_deref())?;

    Ok(Json(json!({
        "settlement": settlement,
        "settlement_txid": settlement_txid,
    })))
}

/// Detector sync + grace handling + Vickrey math. Caller has already
/// CAS'd the auction into `settling`; on error the caller reverts.
async fn prepare_settlement(
    state: &Arc<AppState>,
    net: &NetworkRuntime,
    id: &str,
) -> Result<settlement::Settlement, ApiError> {
    detector::sync_net(state, net).await?;

    let grace = state.cfg.missed_grace_secs;
    let bids = {
        let db = net.db();
        let mut bids = db::bids_for_auction(&db, id)?;
        for b in &mut bids {
            if b.status == "registered" {
                if now() - b.created_at <= grace {
                    return Err(ApiError::Conflict(format!(
                        "bid {} still awaiting detection; wait for confirmation or grace ({grace}s)",
                        b.id
                    )));
                }
                db::mark_bid_status(&db, &b.id, "missed")?;
                b.status = "missed".into();
            } else if b.status == "detected" {
                return Err(ApiError::Conflict(format!(
                    "bid {} has {} confirmations; waiting for {}",
                    b.id, b.confirmations, net.conf_target
                )));
            }
        }
        bids.retain(|b| b.status == "confirmed");
        // One position per identity: an identity that somehow holds several
        // confirmed bids on this lot contributes only its highest. Without
        // this an identity's own lower bid could set the second price it pays.
        let mut best: std::collections::HashMap<String, (i64, String)> =
            std::collections::HashMap::new();
        for b in &bids {
            let amt = b.confirmed_amount_zats.unwrap_or(b.registered_amount_zats);
            if let Some(pk) = b.user_pubkey.as_deref() {
                let e = best
                    .entry(pk.to_string())
                    .or_insert((amt, b.id.clone()));
                if amt > e.0 {
                    *e = (amt, b.id.clone());
                }
            }
        }
        bids.retain(|b| match b.user_pubkey.as_deref() {
            Some(pk) => best.get(pk).map(|(_, id)| *id == b.id).unwrap_or(true),
            None => true,
        });
        bids
    };

    let auction = {
        let db = net.db();
        db::get_auction(&db, id)?.ok_or_else(|| ApiError::NotFound("auction not found".into()))?
    };

    let inputs: Vec<settlement::BidInput> = bids
        .iter()
        .map(|b| settlement::BidInput {
            id: b.id.clone(),
            refund_address: b.refund_address.clone(),
            amount_zats: b.confirmed_amount_zats.unwrap_or(b.registered_amount_zats),
            is_buy_now: b.is_buy_now,
        })
        .collect();

    // Hidden reserve floors the sale: bidders only ever saw the public
    // reserve; the effective floor is whichever is higher.
    let effective_reserve = match auction.hidden_reserve_zats {
        Some(h) => auction.reserve_zats.max(h),
        None => auction.reserve_zats,
    };

    let mut plan = settlement::settle(&inputs, effective_reserve, state.cfg.commission_bps)
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    // Seller collateral rides home in the same settlement batch.
    if auction.collateral_zats > 0 && auction.collateral_txid.is_some() {
        plan.payments.push(settlement::OutgoingPayment {
            bid_id: None,
            to: auction.seller_address.clone(),
            amount_zats: auction.collateral_zats,
            kind: settlement::PaymentKind::CollateralRefund,
        });
    }

    Ok(plan)
}

/// Resolve auctions stuck in `settling` (crash between claim and finalize).
/// - No opid persisted: the z_sendmany was never submitted — safe to revert.
/// - Opid success: finalize from the persisted plan.
/// - Opid failed: revert so the seller can retry.
/// - Opid pending: leave for the next sweep.
/// - Opid unknown to zecd (daemon restart): leave `settling` and log loudly;
///   an operator must confirm on-chain before manual finalize/revert.
pub async fn recover_settling_net(state: &Arc<AppState>, net: &NetworkRuntime) {
    let settling = {
        let db = net.db();
        match db::auctions_with_status(&db, "settling") {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(network = %net.name, "recovery query failed: {e}");
                return;
            }
        }
    };
    for auction in settling {
        let Some(opid) = auction.settlement_opid.clone() else {
            tracing::warn!(
                auction = %auction.id,
                "settling without opid (crash before submit); reverting to closed"
            );
            revert_settling(net, &auction.id);
            continue;
        };
        match net.zecd.operation_status(&opid).await {
            Ok(Some(entry)) => match entry.status.as_deref() {
                Some("success") => {
                    let txid = entry.result.and_then(|r| r.txid);
                    tracing::info!(
                        auction = %auction.id,
                        opid = %opid,
                        "recovery: finalizing settlement from chain result"
                    );
                    let plan = auction
                        .settlement_plan
                        .as_deref()
                        .and_then(|p| serde_json::from_str::<settlement::Settlement>(p).ok());
                    let Some(plan) = plan else {
                        tracing::error!(
                            auction = %auction.id,
                            "recovery: settlement plan missing or unreadable; cannot finalize. \
                             Verify the tx on-chain, then finalize manually."
                        );
                        continue;
                    };
                    if let Err(e) = finalize_settlement(state, net, &auction.id, &plan, txid.as_deref()) {
                        tracing::error!(auction = %auction.id, "recovery finalize failed: {e}");
                    }
                }
                Some("failed") | Some("invalid") | Some("rejected") => {
                    tracing::warn!(
                        auction = %auction.id,
                        opid = %opid,
                        "recovery: on-chain operation failed; reverting to closed"
                    );
                    revert_settling(net, &auction.id);
                }
                _ => {
                    tracing::info!(
                        auction = %auction.id,
                        opid = %opid,
                        "recovery: operation still pending"
                    );
                }
            },
            Ok(None) => {
                tracing::error!(
                    auction = %auction.id,
                    opid = %opid,
                    "recovery: opid unknown to zecd (daemon restarted?). Auction left in \
                     'settling' — verify the tx on-chain, then finalize or revert manually. \
                     Do NOT retry settle blindly: the transfer may have already executed."
                );
            }
            Err(e) => {
                tracing::warn!(auction = %auction.id, "recovery: zecd status query failed: {e}");
            }
        }
    }
}

/// Resolve in-flight payout ops (crash between submit and finalize) and
/// auto-release held payouts whose deadline has passed. Runs on the recovery
/// tick for every ready network.
pub async fn recover_payouts_net(state: &Arc<AppState>, net: &NetworkRuntime) {
    // 1. In-flight: the batch was submitted; observe the opid and finalize.
    let inflight = {
        let db = net.db();
        db::auctions_with_payout_inflight(&db).unwrap_or_default()
    };
    for auction in inflight {
        let Some(opid) = auction.payout_opid.clone() else {
            continue;
        };
        let to_state = match auction.payout_state.as_deref() {
            Some("releasing") => "released",
            Some("slashing") => "slashed",
            _ => continue,
        };
        match net.zecd.operation_status(&opid).await {
            Ok(Some(entry)) => match entry.status.as_deref() {
                Some("success") => {
                    let txid = entry.result.and_then(|r| r.txid);
                    tracing::info!(
                        auction = %auction.id,
                        opid = %opid,
                        "payout recovery: finalizing {to_state} from chain result"
                    );
                    let db = net.db();
                    let _ = db::finalize_payout(&db, &auction.id, auction.payout_state.as_deref().unwrap_or_default(), to_state, txid.as_deref());
                }
                Some("failed") | Some("invalid") | Some("rejected") => {
                    // Revert to where this payout came from: a resolution
                    // (dispute_opened_at set) goes back to 'disputed'; a
                    // confirm/auto-release goes back to 'held'.
                    let target = if auction.dispute_opened_at.is_some() {
                        "disputed"
                    } else {
                        "held"
                    };
                    tracing::warn!(
                        auction = %auction.id,
                        opid = %opid,
                        "payout recovery: on-chain operation failed; reverting to {target}"
                    );
                    let db = net.db();
                    let _ = db::revert_payout_inflight(&db, &auction.id, target);
                }
                _ => {
                    tracing::info!(
                        auction = %auction.id,
                        opid = %opid,
                        "payout recovery: operation still pending"
                    );
                }
            },
            Ok(None) => {
                tracing::error!(
                    auction = %auction.id,
                    opid = %opid,
                    "payout recovery: opid unknown to zecd. Payout left in-flight — verify \
                     the tx on-chain, then finalize manually."
                );
            }
            Err(e) => {
                tracing::warn!(auction = %auction.id, "payout recovery: status query failed: {e}");
            }
        }
    }

    // 2. Auto-release held payouts past their deadline: the seller is paid
    //    without further winner action (protects an absent winner from
    //    indefinitely withholding the seller's money).
    let due = {
        let db = net.db();
        db::held_payouts_due(&db, now()).unwrap_or_default()
    };
    for auction in due {
        // Claim first so only one concurrent sweep executes the transfer.
        {
            let db = net.db();
            if !db::claim_payout(&db, &auction.id, "held", "releasing").unwrap_or(false) {
                continue;
            }
        }
        let outputs = match payout_outputs(&auction, None, state.cfg.commission_bps, false) {
            Ok(o) => o,
            Err(e) => {
                tracing::error!(auction = %auction.id, "auto-release output build failed: {e}");
                let db = net.db();
                let _ = db::revert_payout_inflight(&db, &auction.id, "held");
                continue;
            }
        };
        if let Err(e) =
            exec_payout(net, &auction.id, "releasing", "released", "held", outputs).await
        {
            tracing::warn!(auction = %auction.id, "auto-release payout failed (will retry): {e}");
        } else {
            tracing::info!(auction = %auction.id, "auto-released held payout to seller");
        }
    }

    // 3. Digital fast-path: a DISPUTED digital lot whose payload the winner
    //    already claimed has provable delivery. After the evidence window with
    //    no operator resolution, default to the seller — the "seller delivered,
    //    buyer lied" case resolves without an arbiter.
    let auto_disputed = {
        let db = net.db();
        db::disputed_auto_due(&db, now()).unwrap_or_default()
    };
    for auction in auto_disputed {
        {
            let db = net.db();
            if !db::claim_payout(&db, &auction.id, "disputed", "releasing").unwrap_or(false) {
                continue;
            }
        }
        let outputs = match payout_outputs(&auction, None, state.cfg.commission_bps, false) {
            Ok(o) => o,
            Err(e) => {
                tracing::error!(auction = %auction.id, "digital auto-resolve build failed: {e}");
                let db = net.db();
                let _ = db::revert_payout_inflight(&db, &auction.id, "disputed");
                continue;
            }
        };
        if let Err(e) =
            exec_payout(net, &auction.id, "releasing", "released", "disputed", outputs).await
        {
            tracing::warn!(
                auction = %auction.id,
                "digital auto-resolve failed (will retry): {e}"
            );
        } else {
            tracing::info!(
                auction = %auction.id,
                "digital auto-resolved dispute to seller (payload claimed)"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Network profiles
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct NetworkEntry {
    name: String,
    chain: String,
    ready: bool,
    active: bool,
}

async fn list_networks(State(state): State<Arc<AppState>>) -> Json<Vec<NetworkEntry>> {
    let active_name = state.active().name.clone();
    Json(
        state
            .networks
            .iter()
            .map(|n| NetworkEntry {
                name: n.name.clone(),
                chain: n.chain.clone(),
                ready: n.ready.load(std::sync::atomic::Ordering::Relaxed),
                active: n.name == active_name,
            })
            .collect(),
    )
}

#[derive(serde::Deserialize)]
struct SwitchNetwork {
    name: String,
}

/// Operator action: switch the whole instance to another configured chain
/// backend. Requires a signed-in seller session — it is a server-level
/// control, not a per-user preference. Process-local (resets on restart).
async fn switch_network(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<SwitchNetwork>,
) -> Result<Json<Value>, ApiError> {
    check_origin(&headers, state.cfg.cors_origin.as_deref())?;
    let name = body.name.trim().to_lowercase();
    {
        let net = state.active();
        let db = net.db();
        let Some((pubkey, _)) = session_pubkey(&db, &jar) else {
            return Err(ApiError::Unauthorized(
                "sign in required to switch networks".into(),
            ));
        };
        // Any signed-in identity may switch (demo operator model); the
        // session requirement keeps anonymous visitors from flipping chains.
        let _ = pubkey;
    }
    let known = state
        .networks
        .iter()
        .find(|n| n.name == name)
        .map(|n| n.ready.load(std::sync::atomic::Ordering::Relaxed));
    match known {
        None => Err(ApiError::NotFound(format!(
            "network '{name}' is not configured"
        ))),
        Some(false) => Err(ApiError::Busy(format!(
            "network '{name}' backend is not ready"
        ))),
        Some(true) => {
            if !state.set_active(&name) {
                return Err(ApiError::Busy(format!(
                    "network '{name}' backend is not ready"
                )));
            }
            tracing::info!(network = %name, "active network switched");
            let net = state.active();
            Ok(Json(json!({
                "active": net.name,
                "chain": net.chain,
                "auctioneer_ua": net.auctioneer_ua(),
            })))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_zec_edges() {
        assert_eq!(parse_zec("1.5"), Some(150_000_000));
        assert_eq!(parse_zec("0.00000001"), Some(1));
        assert_eq!(parse_zec("1."), Some(100_000_000));
        assert_eq!(parse_zec("1.123456789"), None); // >8 decimals
        assert_eq!(parse_zec("-1"), None);
        assert_eq!(parse_zec(""), None);
        assert_eq!(parse_zec("1e8"), None);
        assert_eq!(parse_zec("0x10"), None);
        assert_eq!(
            parse_zec("99999999999999999999"),
            None // i64 overflow via checked_mul
        );
        assert_eq!(parse_zec(" 1.5 "), Some(150_000_000));
    }

    #[test]
    fn origin_check() {
        let mut h = HeaderMap::new();
        assert!(check_origin(&h, None).is_ok()); // no Origin: non-browser
        h.insert("host", "example.com".parse().unwrap());
        h.insert("origin", "https://example.com".parse().unwrap());
        assert!(check_origin(&h, None).is_ok());
        h.insert("origin", "https://evil.com".parse().unwrap());
        assert!(check_origin(&h, None).is_err());
        h.insert("origin", "null".parse().unwrap());
        assert!(check_origin(&h, None).is_err());
    }

    #[test]
    fn origin_check_split_frontend() {
        // Split deploy: the configured CORS origin is a legitimate cross-origin
        // browser client even though it differs from Host.
        let allowed = "https://bidshield-demo.vercel.app";
        let mut h = HeaderMap::new();
        h.insert("host", "api.example.com".parse().unwrap());
        h.insert("origin", allowed.parse().unwrap());
        assert!(check_origin(&h, Some(allowed)).is_ok());
        // Other cross-origin clients are still rejected.
        h.insert("origin", "https://evil.com".parse().unwrap());
        assert!(check_origin(&h, Some(allowed)).is_err());
        // Without a configured CORS origin the old host-match rule applies.
        assert!(check_origin(&h, None).is_err());
    }
}
