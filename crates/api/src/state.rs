use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use zecd_client::{ZebraClient, ZecdClient};

use crate::auth::AuthNonces;
use crate::ratelimit::{Limits, RateLimiter};

pub struct Config {
    pub bind: String,
    pub db_path: String,
    pub web_dist: String,
    pub zecd_url: String,
    pub zecd_health: String,
    pub zecd_user: Option<String>,
    pub zecd_pass: Option<String>,
    /// Hosted demo wallet: a *separate* zecd (the funder) whose shielded
    /// addresses the in-app wallet hands out. Kept apart from the auctioneer
    /// so user funds never commingle with escrow — and so a hosted address is
    /// never `ismine` on the auctioneer, which would make it an invalid
    /// refund_address (see `validate_user_address`).
    pub funder_url: String,
    pub funder_health: String,
    pub funder_user: Option<String>,
    pub funder_pass: Option<String>,
    /// Zats the in-app faucet credits per claim (default 0.5 ZEC).
    pub faucet_zats: i64,
    /// Minimum seconds between faucet claims by one identity.
    pub faucet_cooldown_secs: i64,
    pub conf_target: i64,
    /// Bidshield commission in basis points of the hammer price (500 = 5%),
    /// deducted from the seller's proceeds only.
    pub commission_bps: i64,
    pub min_bid_zats: i64,
    pub max_bid_zats: i64,
    pub poll_secs: u64,
    pub missed_grace_secs: i64,
    pub min_duration_secs: i64,
    pub max_duration_secs: i64,
    pub session_ttl_secs: i64,
    pub cookie_secure: bool,
    /// Trust `X-Forwarded-For` from a local reverse proxy (the all-in-one
    /// Railway gateway). Without this every request looks like 127.0.0.1 and
    /// rate limits become global.
    pub trust_proxy: bool,
    /// Split frontend (e.g. a Vercel-hosted SPA): exact origin allowed
    /// cross-origin, with cookies. `None` = same-origin only (the API serves
    /// the SPA itself).
    pub cors_origin: Option<String>,
    pub rate_auth_per_min: u32,
    pub rate_write_per_min: u32,
    pub rate_read_per_min: u32,
    pub auth_fail_max: u32,
    pub auth_lockout_secs: u64,
    pub max_concurrent_requests: usize,
    /// Zebra's verificationprogress floor for a profile to count as ready
    /// (regtest always reports 1.0; a syncing public chain ramps to it).
    pub sync_progress_min: f64,
    /// Seconds between regtest miner ticks. The regtest chain has no
    /// built-in miner, so without this nothing ever confirms. 0 disables it
    /// (and it never runs off regtest regardless).
    pub miner_interval_secs: u64,
    /// Confirmations a regtest bid must reach before it is `confirmed`.
    /// Public chains keep the stricter `conf_target`; regtest is a demo, so
    /// it trades reorg margin for a confirmation that lands in seconds.
    pub regtest_conf_target: i64,
    /// Auto-release deadline for HELD seller payouts on a digital-delivery
    /// lot (payload/contact). After this, the payout is released to the
    /// seller without further winner action. Default 24h.
    pub payout_deadline_digital_secs: i64,
    /// Auto-release deadline for HELD seller payouts on a physical-delivery
    /// lot (shipping). Longer by default; set 0 to require manual
    /// confirm/dispute only (no auto-release).
    pub payout_deadline_physical_secs: i64,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_num<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Load a `.env` file into the process environment without overriding any
/// variable that is already set (real environment always wins). Called once
/// at startup; harmless when the file is absent (e.g. inside Docker, where
/// Compose injects the variables itself).
pub fn load_dotenv() {
    let Ok(text) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"');
        if key.is_empty() || std::env::var(key).is_ok() {
            continue;
        }
        // Best-effort; ignore failures (e.g. invalid key bytes).
        std::env::set_var(key, value);
    }
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            bind: env_or("BIND", "0.0.0.0:8080"),
            db_path: env_or("DB_PATH", "data/bidshield.db"),
            web_dist: env_or("WEB_DIST", "web/dist"),
            zecd_url: env_or("ZECD_URL", "http://127.0.0.1:18232/"),
            zecd_health: env_or("ZECD_HEALTH", "http://127.0.0.1:9233/readyz"),
            zecd_user: std::env::var("ZECD_USER").ok().filter(|s| !s.is_empty()),
            zecd_pass: std::env::var("ZECD_PASS").ok().filter(|s| !s.is_empty()),
            funder_url: env_or("FUNDER_URL", "http://127.0.0.1:18242/"),
            funder_health: env_or("FUNDER_HEALTH", "http://127.0.0.1:9243/readyz"),
            funder_user: std::env::var("FUNDER_USER").ok().filter(|s| !s.is_empty()),
            funder_pass: std::env::var("FUNDER_PASS").ok().filter(|s| !s.is_empty()),
            faucet_zats: env_num("FAUCET_ZATS", 50_000_000),
            faucet_cooldown_secs: env_num("FAUCET_COOLDOWN_SECS", 60),
            conf_target: env_num("CONF_TARGET", 10),
            commission_bps: env_num("COMMISSION_BPS", 500),
            min_bid_zats: env_num("MIN_BID_ZATS", 100_000),
            // Hard ceiling: 100_000 ZEC. Above this the amount is almost
            // certainly an input error or an attempted overflow probe.
            max_bid_zats: env_num("MAX_BID_ZATS", 10_000_000_000_000),
            poll_secs: env_num("POLL_SECS", 5),
            missed_grace_secs: env_num("MISSED_GRACE_SECS", 120),
            min_duration_secs: env_num("MIN_DURATION_SECS", 30),
            max_duration_secs: env_num("MAX_DURATION_SECS", 2_592_000),
            session_ttl_secs: env_num("SESSION_TTL_SECS", 604_800),
            cookie_secure: env_num("COOKIE_SECURE", 0) == 1,
            trust_proxy: env_num("TRUST_PROXY", 0) == 1,
            // Split frontend (e.g. a Vercel-hosted SPA): exact origin allowed
            // cross-origin with cookies. Empty = same-origin only (the API
            // serves the SPA itself).
            cors_origin: std::env::var("CORS_ORIGIN")
                .ok()
                .filter(|s| !s.is_empty()),
            rate_auth_per_min: env_num("RATE_AUTH_PER_MIN", 20),
            rate_write_per_min: env_num("RATE_WRITE_PER_MIN", 30),
            rate_read_per_min: env_num("RATE_READ_PER_MIN", 240),
            auth_fail_max: env_num("AUTH_FAIL_MAX", 10),
            auth_lockout_secs: env_num("AUTH_LOCKOUT_SECS", 60),
            max_concurrent_requests: env_num("MAX_CONCURRENT_REQUESTS", 64),
            sync_progress_min: env_num("SYNC_PROGRESS_MIN", 0.9999),
            miner_interval_secs: env_num("MINER_INTERVAL_SECS", 5),
            regtest_conf_target: env_num("REGTEST_CONF_TARGET", 3),
            payout_deadline_digital_secs: env_num("PAYOUT_DEADLINE_DIGITAL_SECS", 86_400),
            payout_deadline_physical_secs: env_num("PAYOUT_DEADLINE_PHYSICAL_SECS", 604_800),
        }
    }

    /// Confirmations required before a bid counts as `confirmed` on `chain`.
    /// Public chains keep the strict global target; regtest is a demo and
    /// uses the faster override so a bid confirms in seconds.
    pub fn conf_target_for(&self, chain: &str) -> i64 {
        if chain == "regtest" {
            self.regtest_conf_target.max(1)
        } else {
            self.conf_target.max(1)
        }
    }

    pub fn rate_limits(&self) -> Limits {
        Limits {
            auth_per_min: self.rate_auth_per_min,
            write_per_min: self.rate_write_per_min,
            read_per_min: self.rate_read_per_min,
            auth_fail_max: self.auth_fail_max,
            auth_lockout: std::time::Duration::from_secs(self.auth_lockout_secs),
        }
    }
}

pub struct AppState {
    pub cfg: Config,
    pub networks: Vec<std::sync::Arc<NetworkRuntime>>,
    pub active: AtomicUsize,
    pub auth_nonces: AuthNonces,
    pub rate: RateLimiter,
    pub concurrency: std::sync::Arc<tokio::sync::Semaphore>,
}

/// One configured chain backend: its own zecd connection, SQLite file, and
/// auctioneer address. Multiple runtimes let the same deployment serve
/// regtest for demos and point at testnet/mainnet zecd nodes for real
/// testing; the UI switches the active one.
pub struct NetworkRuntime {
    pub name: String,
    pub chain: String,
    pub zecd: ZecdClient,
    pub zebra: ZebraClient,
    /// Hosted in-app wallet backend (`None` when the profile has no funder).
    pub funder: Option<ZecdClient>,
    pub db: Mutex<Connection>,
    auctioneer_ua: Mutex<String>,
    pub ready: AtomicBool,
    /// Confirmations this profile's bids must reach before `confirmed`.
    /// Resolved once at startup from the chain, so a regtest demo confirms
    /// fast without loosening the target on a public chain.
    pub conf_target: i64,
}

impl NetworkRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        name: String,
        chain: String,
        zecd: ZecdClient,
        zebra: ZebraClient,
        funder: Option<ZecdClient>,
        db: Connection,
        auctioneer_ua: String,
        ready: bool,
        conf_target: i64,
    ) -> Self {
        Self {
            name,
            chain,
            zecd,
            zebra,
            funder,
            db: Mutex::new(db),
            auctioneer_ua: Mutex::new(auctioneer_ua),
            ready: AtomicBool::new(ready),
            conf_target,
        }
    }

    /// The hosted-wallet backend, or `BadRequest` if this profile has none.
    pub fn funder(&self) -> Result<&ZecdClient, crate::routes::ApiError> {
        self.funder.as_ref().ok_or_else(|| {
            crate::routes::ApiError::BadRequest(
                "hosted wallet is not configured for this network".into(),
            )
        })
    }

    pub fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn auctioneer_ua(&self) -> String {
        self.auctioneer_ua
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_auctioneer_ua(&self, ua: &str) {
        *self.auctioneer_ua.lock().unwrap_or_else(|e| e.into_inner()) = ua.to_string();
    }
}

impl AppState {
    pub fn active(&self) -> std::sync::Arc<NetworkRuntime> {
        let i = self.active.load(Ordering::Relaxed);
        self.networks
            .get(i)
            .or_else(|| self.networks.first())
            .expect("at least one network profile")
            .clone()
    }

    /// Activate a configured profile by name. Returns false when the name is
    /// unknown or its backend is not ready.
    pub fn set_active(&self, name: &str) -> bool {
        for (i, net) in self.networks.iter().enumerate() {
            if net.name == name && net.ready.load(Ordering::Relaxed) {
                self.active.store(i, Ordering::Relaxed);
                return true;
            }
        }
        false
    }
}

/// Map zecd's raw chain id to the display name used in the API and UI.
pub fn map_chain(raw: &str) -> String {
    match raw {
        "regtest" => "regtest".into(),
        "test" => "testnet".into(),
        "main" => "mainnet".into(),
        other => other.to_string(),
    }
}

/// Connection settings for one network profile.
pub struct NetworkSpec {
    pub name: String,
    pub zecd_url: String,
    pub zecd_health: String,
    pub zecd_user: Option<String>,
    pub zecd_pass: Option<String>,
    /// Hosted-wallet zecd; `None` when unset (wallet endpoints then 503).
    pub funder_url: String,
    pub funder_health: String,
    pub funder_user: Option<String>,
    pub funder_pass: Option<String>,
    pub zebra_url: String,
    pub db_path: String,
}

impl NetworkSpec {
    /// The default profile: existing ZECD_* / DB_PATH variables, profile
    /// name from NETWORK (default "regtest"). Always present.
    pub fn default_from_env(cfg: &Config) -> Self {
        Self {
            name: env_or("NETWORK", "regtest"),
            zecd_url: cfg.zecd_url.clone(),
            zecd_health: cfg.zecd_health.clone(),
            zecd_user: cfg.zecd_user.clone(),
            zecd_pass: cfg.zecd_pass.clone(),
            funder_url: cfg.funder_url.clone(),
            funder_health: cfg.funder_health.clone(),
            funder_user: cfg.funder_user.clone(),
            funder_pass: cfg.funder_pass.clone(),
            zebra_url: env_or("ZEBRA_URL", "http://127.0.0.1:18234"),
            db_path: cfg.db_path.clone(),
        }
    }

    /// An extra profile, loaded only when its URL is set:
    /// NETWORK_TESTNET_URL / NETWORK_TESTNET_HEALTH / NETWORK_TESTNET_USER /
    /// NETWORK_TESTNET_PASS / NETWORK_TESTNET_DB_PATH (same for MAINNET).
    /// Optional NETWORK_{name}_ZEBRA_URL defaults to the paired compose
    /// service (http://zebra-{name}:18234) for the sync-progress probe.
    pub fn extra_from_env(name: &str) -> Option<Self> {
        let url_key = format!("NETWORK_{name}_URL");
        let url = std::env::var(&url_key).ok().filter(|s| !s.is_empty())?;
        let lower = name.to_lowercase();
        Some(Self {
            name: lower.clone(),
            zecd_url: url,
            zecd_health: std::env::var(format!("NETWORK_{name}_HEALTH"))
                .unwrap_or_else(|_| "http://127.0.0.1:9000/".into()),
            zecd_user: std::env::var(format!("NETWORK_{name}_USER"))
                .ok()
                .filter(|s| !s.is_empty()),
            zecd_pass: std::env::var(format!("NETWORK_{name}_PASS"))
                .ok()
                .filter(|s| !s.is_empty()),
            zebra_url: std::env::var(format!("NETWORK_{name}_ZEBRA_URL"))
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("http://zebra-{lower}:18234")),
            funder_url: std::env::var(format!("NETWORK_{name}_FUNDER_URL"))
                .unwrap_or_default(),
            funder_health: std::env::var(format!("NETWORK_{name}_FUNDER_HEALTH"))
                .unwrap_or_default(),
            funder_user: std::env::var(format!("NETWORK_{name}_FUNDER_USER"))
                .ok()
                .filter(|s| !s.is_empty()),
            funder_pass: std::env::var(format!("NETWORK_{name}_FUNDER_PASS"))
                .ok()
                .filter(|s| !s.is_empty()),
            db_path: std::env::var(format!("NETWORK_{name}_DB_PATH"))
                .unwrap_or_else(|_| format!("data/bidshield-{lower}.db")),
        })
    }

    pub fn build_client(&self) -> ZecdClient {
        let mut zecd = ZecdClient::new(&self.zecd_url, &self.zecd_health);
        if let (Some(u), Some(p)) = (&self.zecd_user, &self.zecd_pass) {
            zecd = zecd.with_basic_auth(u.clone(), p.clone());
        }
        zecd
    }

    /// Hosted-wallet client. Empty URL means "this profile has no funder" —
    /// callers treat `None` as "in-app wallet unavailable here".
    pub fn build_funder(&self) -> Option<ZecdClient> {
        if self.funder_url.is_empty() {
            return None;
        }
        let health = if self.funder_health.is_empty() {
            self.funder_url.clone()
        } else {
            self.funder_health.clone()
        };
        let mut funder = ZecdClient::new(&self.funder_url, &health);
        if let (Some(u), Some(p)) = (&self.funder_user, &self.funder_pass) {
            funder = funder.with_basic_auth(u.clone(), p.clone());
        }
        Some(funder)
    }

    pub fn build_zebra(&self) -> ZebraClient {
        ZebraClient::new(&self.zebra_url)
    }
}
