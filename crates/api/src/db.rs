use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Auction {
    pub id: String,
    pub title: String,
    pub description: String,
    pub reserve_zats: i64,
    pub seller_address: String,
    pub seller_pubkey: Option<String>,
    pub created_at: i64,
    pub closes_at: i64,
    pub status: String,
    pub settled_at: Option<i64>,
    pub sold: Option<bool>,
    pub price_zats: Option<i64>,
    pub winner_bid_id: Option<String>,
    pub settlement_txid: Option<String>,
    /// Internal: zecd opid of an in-flight settlement. Never serialized to
    /// API clients (recovery state, not public data).
    #[serde(skip)]
    pub settlement_opid: Option<String>,
    /// Internal: JSON snapshot of the computed settlement plan, persisted
    /// before the z_sendmany is submitted so crash recovery can finalize
    /// identically. Contains refund addresses — never leaves the server.
    #[serde(skip)]
    pub settlement_plan: Option<String>,
    /// Public image gallery: JSON array of https URLs (max 6).
    pub images: Vec<String>,
    /// Marketplace category tag (wl, wallet, nft, alpha, collectible, other).
    pub category: String,
    /// Freeform public tags: JSON array of short strings.
    pub tags: Vec<String>,
    /// Seller's hidden floor. Sealed from every API client until settlement;
    /// settlement floors at max(public reserve, this).
    #[serde(skip)]
    pub hidden_reserve_zats: Option<i64>,
    /// Optional buy-it-now price. Public. A confirmed BIN payment ends the
    /// Vickrey round early and sells at this price.
    pub bin_price_zats: Option<i64>,
    /// Seller skin-in-the-game: escrowed via `collateral:<id>` memo, returned
    /// with settlement. Public amount; txid revealed post-payment.
    pub collateral_zats: i64,
    pub collateral_txid: Option<String>,
    /// How the winner receives the goods: "digital" (payload/contact — short
    /// auto-release window) or "physical" (shipping — long window). Drives the
    /// seller-payout deadline after settlement.
    pub delivery_kind: String,
    /// Two-phase seller payout: after settlement the seller's proceeds and
    /// collateral are HELD, not paid. The winning bidder confirms delivery
    /// ("released") or disputes ("slashed" — proceeds refunded, collateral
    /// forfeited to the winner). NULL until a sold lot settles; then one of
    /// "held" | "released" | "slashed".
    pub payout_state: Option<String>,
    /// Auto-release deadline: after this the held payout is released to the
    /// seller without further winner action (protects an absent winner from
    /// silently holding the seller's money forever). NULL = no auto-release.
    pub payout_deadline: Option<i64>,
    pub payout_txid: Option<String>,
    /// Internal: zecd opid of an in-flight payout release/slash. Recovery
    /// state, never serialized.
    #[serde(skip)]
    pub payout_opid: Option<String>,
    /// Winning bidder's dispute reason (they claim non-delivery). Recorded when
    /// the payout is disputed; public after settlement so both sides see the
    /// claim in the review.
    pub dispute_reason: Option<String>,
    /// Seller's delivery proof (tracking number, signed payload hash…),
    /// submitted during the dispute evidence window. Public after settlement.
    pub delivery_proof: Option<String>,
    /// When the dispute was opened (freezes auto-release, starts the evidence
    /// window).
    pub dispute_opened_at: Option<i64>,
    /// Encrypted-delivery payload (WL code, seed, invite…). Server-held;
    /// released only to the winning bid after settlement. Never serialized
    /// on auction reads.
    #[serde(skip)]
    pub delivery_payload: Option<String>,
    /// True once the winning bid claimed the delivery payload.
    pub payload_claimed: bool,
    /// Seller's declared refund policy (plain text). Public transparency
    /// label only — Bidshield cannot enforce it on-chain; it pairs with the
    /// seller collateral as the seller's skin-in-the-game.
    pub refund_policy: Option<String>,
    /// Seller's contact note for the winning bidder (Telegram/email…).
    /// Escrowed server-side; readable only by the winning bidder after
    /// settlement. Never public, never serialized on auction reads.
    #[serde(skip)]
    pub seller_contact: Option<String>,
    /// Winning bidder's contact note for the seller. Same escrow rules as
    /// `seller_contact` — readable only by the seller after settlement.
    #[serde(skip)]
    pub winner_contact: Option<String>,
    /// True once the winning bidder claimed the seller's contact note.
    pub contact_claimed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bid {
    pub id: String,
    pub auction_id: String,
    pub refund_address: String,
    pub registered_amount_zats: i64,
    pub created_at: i64,
    pub status: String,
    pub txid: Option<String>,
    pub confirmed_amount_zats: Option<i64>,
    pub detected_at: Option<i64>,
    pub confirmations: i64,
    pub refund_txid: Option<String>,
    pub refund_amount_zats: Option<i64>,
    pub user_pubkey: Option<String>,
    /// Buy-it-now registration (amount equals the lot's BIN price).
    pub is_buy_now: bool,
    /// What this server has already moved on chain toward this bid, in zats.
    /// A top-up sends `registered_amount_zats - paid_zats`, never the whole
    /// total again. Distinct from `confirmed_amount_zats`, which is the
    /// escrow's own view and lags the mempool.
    pub paid_zats: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub pubkey: String,
    pub first_seen: i64,
    pub last_seen: i64,
    pub sign_in_count: i64,
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS auctions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            reserve_zats INTEGER NOT NULL,
            seller_address TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            closes_at INTEGER NOT NULL,
            status TEXT NOT NULL,
            settled_at INTEGER,
            sold INTEGER,
            price_zats INTEGER,
            winner_bid_id TEXT,
            settlement_txid TEXT,
            images TEXT NOT NULL DEFAULT '[]',
            category TEXT NOT NULL DEFAULT 'other',
            tags TEXT NOT NULL DEFAULT '[]',
            hidden_reserve_zats INTEGER,
            bin_price_zats INTEGER,
            collateral_zats INTEGER NOT NULL DEFAULT 0,
            collateral_txid TEXT,
            delivery_payload TEXT,
            payload_claimed INTEGER NOT NULL DEFAULT 0,
            refund_policy TEXT,
            seller_contact TEXT,
            winner_contact TEXT,
            contact_claimed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS bids (
            id TEXT PRIMARY KEY,
            auction_id TEXT NOT NULL REFERENCES auctions(id),
            refund_address TEXT NOT NULL,
            registered_amount_zats INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            status TEXT NOT NULL,
            txid TEXT,
            confirmed_amount_zats INTEGER,
            detected_at INTEGER,
            confirmations INTEGER NOT NULL DEFAULT 0,
            refund_txid TEXT,
            refund_amount_zats INTEGER,
            user_pubkey TEXT,
            is_buy_now INTEGER NOT NULL DEFAULT 0,
            paid_zats INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id);
        CREATE INDEX IF NOT EXISTS idx_bids_status ON bids(status);
        CREATE TABLE IF NOT EXISTS identities (
            pubkey TEXT PRIMARY KEY,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            sign_in_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            pubkey TEXT NOT NULL REFERENCES identities(pubkey),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_pubkey ON sessions(pubkey);
        CREATE TABLE IF NOT EXISTS wallets (
            pubkey TEXT PRIMARY KEY REFERENCES identities(pubkey),
            address TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_faucet_at INTEGER NOT NULL DEFAULT 0,
            balance_zats INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    // Migrate pre-auth databases: bids predating the identity column.
    let has_user_col: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('bids') WHERE name = 'user_pubkey'",
        [],
        |r| r.get(0),
    )?;
    if has_user_col == 0 {
        conn.execute("ALTER TABLE bids ADD COLUMN user_pubkey TEXT", [])?;
    }
    // Migrate pre-top-up databases: `paid_zats` tracks what this server has
    // actually moved on chain for a bid, so a top-up sends only the remainder
    // instead of re-sending the whole registered total.
    let has_paid_col: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('bids') WHERE name = 'paid_zats'",
        [],
        |r| r.get(0),
    )?;
    if has_paid_col == 0 {
        conn.execute("ALTER TABLE bids ADD COLUMN paid_zats INTEGER NOT NULL DEFAULT 0", [])?;
    }
    // Migrate pre-hardening auctions: seller identity + settlement opid.
    let has_seller_col: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('auctions') WHERE name = 'seller_pubkey'",
        [],
        |r| r.get(0),
    )?;
    if has_seller_col == 0 {
        conn.execute("ALTER TABLE auctions ADD COLUMN seller_pubkey TEXT", [])?;
    }
    let has_opid_col: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('auctions') WHERE name = 'settlement_opid'",
        [],
        |r| r.get(0),
    )?;
    if has_opid_col == 0 {
        conn.execute("ALTER TABLE auctions ADD COLUMN settlement_opid TEXT", [])?;
    }
    let has_plan_col: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('auctions') WHERE name = 'settlement_plan'",
        [],
        |r| r.get(0),
    )?;
    if has_plan_col == 0 {
        conn.execute("ALTER TABLE auctions ADD COLUMN settlement_plan TEXT", [])?;
    }
    // Hosted-wallet ledger. zecd's shielded `fromaddress` selects the whole
    // account's note pool, so a per-address on-chain balance is neither
    // spendable nor reduced by spending — users' money is tracked here.
    let has_balance_col: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('wallets') WHERE name = 'balance_zats'",
        [],
        |r| r.get(0),
    )?;
    if has_balance_col == 0 {
        conn.execute("ALTER TABLE wallets ADD COLUMN balance_zats INTEGER NOT NULL DEFAULT 0", [])?;
    }
    // Listing-schema v2: gallery/category/tags, hidden reserve, BIN,
    // collateral, delivery payload.
    for (col, ddl) in [
        ("images", "ALTER TABLE auctions ADD COLUMN images TEXT NOT NULL DEFAULT '[]'"),
        ("category", "ALTER TABLE auctions ADD COLUMN category TEXT NOT NULL DEFAULT 'other'"),
        ("tags", "ALTER TABLE auctions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'"),
        ("hidden_reserve_zats", "ALTER TABLE auctions ADD COLUMN hidden_reserve_zats INTEGER"),
        ("bin_price_zats", "ALTER TABLE auctions ADD COLUMN bin_price_zats INTEGER"),
        ("collateral_zats", "ALTER TABLE auctions ADD COLUMN collateral_zats INTEGER NOT NULL DEFAULT 0"),
        ("collateral_txid", "ALTER TABLE auctions ADD COLUMN collateral_txid TEXT"),
        ("delivery_payload", "ALTER TABLE auctions ADD COLUMN delivery_payload TEXT"),
        ("payload_claimed", "ALTER TABLE auctions ADD COLUMN payload_claimed INTEGER NOT NULL DEFAULT 0"),
        ("refund_policy", "ALTER TABLE auctions ADD COLUMN refund_policy TEXT"),
        ("seller_contact", "ALTER TABLE auctions ADD COLUMN seller_contact TEXT"),
        ("winner_contact", "ALTER TABLE auctions ADD COLUMN winner_contact TEXT"),
        ("contact_claimed", "ALTER TABLE auctions ADD COLUMN contact_claimed INTEGER NOT NULL DEFAULT 0"),
        ("delivery_kind", "ALTER TABLE auctions ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'digital'"),
        ("payout_state", "ALTER TABLE auctions ADD COLUMN payout_state TEXT"),
        ("payout_deadline", "ALTER TABLE auctions ADD COLUMN payout_deadline INTEGER"),
        ("payout_txid", "ALTER TABLE auctions ADD COLUMN payout_txid TEXT"),
        ("payout_opid", "ALTER TABLE auctions ADD COLUMN payout_opid TEXT"),
        ("dispute_reason", "ALTER TABLE auctions ADD COLUMN dispute_reason TEXT"),
        ("delivery_proof", "ALTER TABLE auctions ADD COLUMN delivery_proof TEXT"),
        ("dispute_opened_at", "ALTER TABLE auctions ADD COLUMN dispute_opened_at INTEGER"),
    ] {
        let has: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('auctions') WHERE name = '{col}'"),
            [],
            |r| r.get(0),
        )?;
        if has == 0 {
            conn.execute(ddl, [])?;
        }
    }
    let has_bin_bid_col: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('bids') WHERE name = 'is_buy_now'",
        [],
        |r| r.get(0),
    )?;
    if has_bin_bid_col == 0 {
        conn.execute("ALTER TABLE bids ADD COLUMN is_buy_now INTEGER NOT NULL DEFAULT 0", [])?;
    }
    // Safe to index only after the column is guaranteed to exist.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_bids_user ON bids(user_pubkey)",
        [],
    )?;
    Ok(())
}

fn json_str_array(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn auction_from_row(row: &rusqlite::Row) -> rusqlite::Result<Auction> {
    Ok(Auction {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        reserve_zats: row.get(3)?,
        seller_address: row.get(4)?,
        seller_pubkey: row.get(5)?,
        created_at: row.get(6)?,
        closes_at: row.get(7)?,
        status: row.get(8)?,
        settled_at: row.get(9)?,
        sold: row.get::<_, Option<i64>>(10)?.map(|v| v != 0),
        price_zats: row.get(11)?,
        winner_bid_id: row.get(12)?,
        settlement_txid: row.get(13)?,
        settlement_opid: row.get(14)?,
        settlement_plan: row.get(15)?,
        images: json_str_array(&row.get::<_, String>(16)?),
        category: row.get(17)?,
        tags: json_str_array(&row.get::<_, String>(18)?),
        hidden_reserve_zats: row.get(19)?,
        bin_price_zats: row.get(20)?,
        collateral_zats: row.get(21)?,
        collateral_txid: row.get(22)?,
        delivery_kind: row.get(23)?,
        payout_state: row.get(24)?,
        payout_deadline: row.get(25)?,
        payout_txid: row.get(26)?,
        payout_opid: row.get(27)?,
        dispute_reason: row.get(28)?,
        delivery_proof: row.get(29)?,
        dispute_opened_at: row.get(30)?,
        delivery_payload: row.get(31)?,
        payload_claimed: row.get::<_, i64>(32)? != 0,
        refund_policy: row.get(33)?,
        seller_contact: row.get(34)?,
        winner_contact: row.get(35)?,
        contact_claimed: row.get::<_, i64>(36)? != 0,
    })
}

fn bid_from_row(row: &rusqlite::Row) -> rusqlite::Result<Bid> {
    Ok(Bid {
        id: row.get(0)?,
        auction_id: row.get(1)?,
        refund_address: row.get(2)?,
        registered_amount_zats: row.get(3)?,
        created_at: row.get(4)?,
        status: row.get(5)?,
        txid: row.get(6)?,
        confirmed_amount_zats: row.get(7)?,
        detected_at: row.get(8)?,
        confirmations: row.get(9)?,
        refund_txid: row.get(10)?,
        refund_amount_zats: row.get(11)?,
        user_pubkey: row.get(12)?,
        is_buy_now: row.get::<_, i64>(13)? != 0,
        paid_zats: row.get(14)?,
    })
}

const AUCTION_COLS: &str = "id, title, description, reserve_zats, seller_address, seller_pubkey, created_at, closes_at, status, settled_at, sold, price_zats, winner_bid_id, settlement_txid, settlement_opid, settlement_plan, images, category, tags, hidden_reserve_zats, bin_price_zats, collateral_zats, collateral_txid, delivery_kind, payout_state, payout_deadline, payout_txid, payout_opid, dispute_reason, delivery_proof, dispute_opened_at, delivery_payload, payload_claimed, refund_policy, seller_contact, winner_contact, contact_claimed";
const BID_COLS: &str = "id, auction_id, refund_address, registered_amount_zats, created_at, status, txid, confirmed_amount_zats, detected_at, confirmations, refund_txid, refund_amount_zats, user_pubkey, is_buy_now, paid_zats";

pub fn insert_auction(conn: &Connection, a: &Auction) -> rusqlite::Result<()> {
    let images =
        serde_json::to_string(&a.images).unwrap_or_else(|_| "[]".into());
    let tags = serde_json::to_string(&a.tags).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO auctions (id, title, description, reserve_zats, seller_address, seller_pubkey, created_at, closes_at, status, settled_at, sold, price_zats, winner_bid_id, settlement_txid, settlement_opid, settlement_plan, images, category, tags, hidden_reserve_zats, bin_price_zats, collateral_zats, collateral_txid, delivery_kind, payout_state, payout_deadline, payout_txid, payout_opid, dispute_reason, delivery_proof, dispute_opened_at, delivery_payload, payload_claimed, refund_policy, seller_contact, winner_contact, contact_claimed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?10, ?11, ?12, ?13, ?14, ?15, NULL, ?16, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?17, 0, ?18, ?19, NULL, 0)",
        params![
            a.id,
            a.title,
            a.description,
            a.reserve_zats,
            a.seller_address,
            a.seller_pubkey,
            a.created_at,
            a.closes_at,
            a.status,
            images,
            a.category,
            tags,
            a.hidden_reserve_zats,
            a.bin_price_zats,
            a.collateral_zats,
            a.delivery_kind,
            a.delivery_payload,
            a.refund_policy,
            a.seller_contact,
        ],
    )?;
    Ok(())
}

/// Record the seller's on-chain collateral payment (detected by the scanner
/// from the `collateral:<id>` memo).
pub fn mark_collateral_paid(
    conn: &Connection,
    id: &str,
    txid: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET collateral_txid = ?2 WHERE id = ?1 AND collateral_txid IS NULL AND collateral_zats > 0",
        params![id, txid],
    )?;
    Ok(n == 1)
}

/// Mark the delivery payload as claimed by the winner.
pub fn mark_payload_claimed(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET payload_claimed = 1 WHERE id = ?1 AND payload_claimed = 0",
        params![id],
    )?;
    Ok(n == 1)
}

/// Escrow the seller's contact note for the winning bidder. One-shot: a
/// second write is refused so the seller cannot swap details after the
/// bidder has already seen them. Only possible on a settled, sold lot.
pub fn set_seller_contact(
    conn: &Connection,
    id: &str,
    contact: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET seller_contact = ?2 WHERE id = ?1 AND seller_contact IS NULL AND status = 'settled' AND sold = 1",
        params![id, contact],
    )?;
    Ok(n == 1)
}

/// Escrow the winning bidder's contact note for the seller. One-shot, same
/// rules as `set_seller_contact`.
pub fn set_winner_contact(
    conn: &Connection,
    id: &str,
    contact: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET winner_contact = ?2 WHERE id = ?1 AND winner_contact IS NULL AND status = 'settled' AND sold = 1",
        params![id, contact],
    )?;
    Ok(n == 1)
}

/// Mark the seller's contact note as claimed by the winning bidder.
pub fn mark_contact_claimed(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET contact_claimed = 1 WHERE id = ?1 AND contact_claimed = 0",
        params![id],
    )?;
    Ok(n == 1)
}

pub fn get_auction(conn: &Connection, id: &str) -> rusqlite::Result<Option<Auction>> {
    conn.query_row(
        &format!("SELECT {AUCTION_COLS} FROM auctions WHERE id = ?1"),
        params![id],
        auction_from_row,
    )
    .optional()
}

pub fn list_auctions(conn: &Connection) -> rusqlite::Result<Vec<Auction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {AUCTION_COLS} FROM auctions ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map([], auction_from_row)?;
    rows.collect()
}

/// Compare-and-swap an auction status transition. Returns true only when the
/// row existed and was in `from` status — the atomic guard that prevents
/// double-settle and close/settle races.
pub fn cas_auction_status(
    conn: &Connection,
    id: &str,
    from: &str,
    to: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET status = ?3 WHERE id = ?1 AND status = ?2",
        params![id, from, to],
    )?;
    Ok(n == 1)
}

/// Persist the zecd operation id for an in-flight settlement. Written
/// *before* waiting on the operation so a crash cannot lose the link between
/// auction and on-chain transfer (recovery resumes via this opid).
pub fn set_settlement_opid(conn: &Connection, id: &str, opid: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE auctions SET settlement_opid = ?2 WHERE id = ?1",
        params![id, opid],
    )?;
    Ok(())
}

/// Persist the computed settlement plan (JSON) before submitting the
/// z_sendmany, so crash recovery can replay the exact same outputs instead
/// of recomputing (bids may have been marked missed in the interim).
pub fn set_settlement_plan(conn: &Connection, id: &str, plan_json: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE auctions SET settlement_plan = ?2 WHERE id = ?1",
        params![id, plan_json],
    )?;
    Ok(())
}

pub fn auctions_with_status(conn: &Connection, status: &str) -> rusqlite::Result<Vec<Auction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {AUCTION_COLS} FROM auctions WHERE status = ?1"
    ))?;
    let rows = stmt.query_map(params![status], auction_from_row)?;
    rows.collect()
}

pub fn close_due_auctions(conn: &Connection, now: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM auctions WHERE status = 'open' AND closes_at <= ?1")?;
    let ids: Vec<String> = stmt
        .query_map(params![now], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut closed = Vec::new();
    for id in &ids {
        if cas_auction_status(conn, id, "open", "closed")? {
            closed.push(id.clone());
        }
    }
    Ok(closed)
}

/// Finalize a settlement: only applies when the auction is in `settling`
/// (or `closed` for the no-opid zero-payment path), so a replayed call
/// cannot re-record or double-credit.
pub fn record_settlement(
    conn: &Connection,
    auction_id: &str,
    sold: bool,
    price_zats: i64,
    winner_bid_id: Option<&str>,
    settlement_txid: Option<&str>,
    now: i64,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET status = 'settled', settled_at = ?2, sold = ?3, price_zats = ?4, winner_bid_id = ?5, settlement_txid = ?6 WHERE id = ?1 AND status IN ('settling', 'closed')",
        params![auction_id, now, sold as i64, price_zats, winner_bid_id, settlement_txid],
    )?;
    Ok(n == 1)
}

/// Arm the two-phase seller payout: the seller's proceeds and collateral are
/// HELD (not paid in the settlement batch) until the winning bidder confirms
/// delivery or the deadline auto-releases. Only fires for a sold lot that was
/// actually settled.
pub fn hold_payout(
    conn: &Connection,
    auction_id: &str,
    deadline: Option<i64>,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET payout_state = 'held', payout_deadline = ?2
         WHERE id = ?1 AND status = 'settled' AND sold = 1 AND payout_state IS NULL",
        params![auction_id, deadline],
    )?;
    Ok(n == 1)
}

/// Atomically claim a payout for the next step. `from_state` is the state we
/// claim FROM ('held' for confirm/auto-release, 'disputed' for a resolution);
/// `to_state` is the in-flight marker ('releasing'/'slashing'). Exactly one
/// caller wins the CAS; everyone else sees false.
pub fn claim_payout(
    conn: &Connection,
    auction_id: &str,
    from_state: &str,
    to_state: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET payout_state = ?3 WHERE id = ?1 AND payout_state = ?2",
        params![auction_id, from_state, to_state],
    )?;
    Ok(n == 1)
}

/// Freeze a held payout on the winner's dispute: no money moves, auto-release
/// pauses, and the buyer's reason is recorded. The funds stay in escrow until
/// an operator resolves (release to seller / slash to winner) or the digital
/// auto-rule fires. One-shot from 'held'.
pub fn open_dispute(
    conn: &Connection,
    auction_id: &str,
    reason: &str,
    now: i64,
    evidence_deadline: Option<i64>,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET payout_state = 'disputed', dispute_reason = ?2,
         dispute_opened_at = ?3, payout_deadline = ?4
         WHERE id = ?1 AND payout_state = 'held'",
        params![auction_id, reason, now, evidence_deadline],
    )?;
    Ok(n == 1)
}

/// Seller submits delivery proof during the dispute evidence window.
pub fn set_delivery_proof(
    conn: &Connection,
    auction_id: &str,
    proof: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET delivery_proof = ?2
         WHERE id = ?1 AND payout_state = 'disputed' AND delivery_proof IS NULL",
        params![auction_id, proof],
    )?;
    Ok(n == 1)
}

/// Digital fast-path: a disputed DIGITAL lot whose payload the winner already
/// CLAIMED has provable delivery (the platform is the delivery channel and the
/// winner took the goods). After the evidence window with no operator
/// resolution, auto-release to the seller — this is the "seller delivered,
/// buyer lied" default.
pub fn disputed_auto_due(conn: &Connection, now: i64) -> rusqlite::Result<Vec<Auction>> {
    let sql = format!(
        "SELECT {AUCTION_COLS} FROM auctions
         WHERE payout_state = 'disputed' AND delivery_kind = 'digital'
           AND payload_claimed = 1
           AND payout_deadline IS NOT NULL AND payout_deadline <= ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![now], auction_from_row)?;
    rows.collect()
}

pub fn set_payout_opid(conn: &Connection, auction_id: &str, opid: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE auctions SET payout_opid = ?2 WHERE id = ?1",
        params![auction_id, opid],
    )?;
    Ok(())
}

/// Finalize a payout: only from the matching in-flight state, so a replayed
/// call cannot double-pay.
pub fn finalize_payout(
    conn: &Connection,
    auction_id: &str,
    from_state: &str,
    to_state: &str,
    txid: Option<&str>,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET payout_state = ?3, payout_txid = ?4, payout_opid = NULL
         WHERE id = ?1 AND payout_state = ?2",
        params![auction_id, from_state, to_state, txid],
    )?;
    Ok(n == 1)
}

/// Revert an in-flight payout back to `target_state` when the failure happened
/// before any on-chain effect (RPC rejected). Target is 'held' for
/// confirm/auto-release, 'disputed' for a resolution, so a failed resolve keeps
/// the dispute open.
pub fn revert_payout_inflight(
    conn: &Connection,
    auction_id: &str,
    target_state: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET payout_state = ?2, payout_opid = NULL
         WHERE id = ?1 AND payout_state IN ('releasing', 'slashing')",
        params![auction_id, target_state],
    )?;
    Ok(n == 1)
}

/// Auctions whose seller payout is still held and whose auto-release deadline
/// has passed — the sweep pays the seller without further winner action.
pub fn held_payouts_due(conn: &Connection, now: i64) -> rusqlite::Result<Vec<Auction>> {
    let sql = format!(
        "SELECT {AUCTION_COLS} FROM auctions
         WHERE payout_state = 'held' AND payout_deadline IS NOT NULL AND payout_deadline <= ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![now], auction_from_row)?;
    rows.collect()
}

/// Auctions with an in-flight payout opid (crash between submit and finalize).
pub fn auctions_with_payout_inflight(conn: &Connection) -> rusqlite::Result<Vec<Auction>> {
    let sql = format!(
        "SELECT {AUCTION_COLS} FROM auctions
         WHERE payout_state IN ('releasing', 'slashing') AND payout_opid IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], auction_from_row)?;
    rows.collect()
}

/// Revert a failed settlement attempt so it is retryable. Only leaves the
/// `settling` state — never touches already-settled rows.
pub fn revert_settling(conn: &Connection, auction_id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE auctions SET status = 'closed', settlement_opid = NULL WHERE id = ?1 AND status = 'settling'",
        params![auction_id],
    )?;
    Ok(n == 1)
}

pub fn insert_bid(conn: &Connection, b: &Bid) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO bids (id, auction_id, refund_address, registered_amount_zats, created_at, status, txid, confirmed_amount_zats, detected_at, confirmations, refund_txid, refund_amount_zats, user_pubkey, is_buy_now, paid_zats)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, 0, NULL, NULL, ?7, ?8, ?9)",
        params![
            b.id,
            b.auction_id,
            b.refund_address,
            b.registered_amount_zats,
            b.created_at,
            b.status,
            b.user_pubkey,
            b.is_buy_now as i64,
            b.paid_zats
        ],
    )?;
    Ok(())
}

/// Record that the server just moved `amount_zats` on chain toward this bid.
/// Called after a successful hosted-wallet send so the next top-up sends only
/// the remainder. Capped at the registered total so an over-send cannot make
/// the remainder negative.
pub fn credit_bid_paid(
    conn: &Connection,
    id: &str,
    amount_zats: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bids SET paid_zats = MIN(registered_amount_zats, paid_zats + ?2) WHERE id = ?1",
        params![id, amount_zats],
    )?;
    Ok(())
}

pub fn get_bid(conn: &Connection, id: &str) -> rusqlite::Result<Option<Bid>> {
    conn.query_row(
        &format!("SELECT {BID_COLS} FROM bids WHERE id = ?1"),
        params![id],
        bid_from_row,
    )
    .optional()
}

pub fn bids_for_auction(conn: &Connection, auction_id: &str) -> rusqlite::Result<Vec<Bid>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BID_COLS} FROM bids WHERE auction_id = ?1 ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map(params![auction_id], bid_from_row)?;
    rows.collect()
}

pub fn bids_with_status(conn: &Connection, status: &str) -> rusqlite::Result<Vec<Bid>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BID_COLS} FROM bids WHERE status = ?1 ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map(params![status], bid_from_row)?;
    rows.collect()
}

pub fn cas_bid_status(conn: &Connection, id: &str, from: &str, to: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE bids SET status = ?3 WHERE id = ?1 AND status = ?2",
        params![id, from, to],
    )?;
    Ok(n == 1)
}

/// Rewrite a live bid's on-chain position from the escrow's own view of its
/// memo. A bid's amount is the *sum* of every payment carrying its memo, so a
/// top-up raises it rather than replacing it; and a bid is only as confirmed
/// as its least-confirmed contributing payment, so a top-up still sitting in
/// the mempool pulls the whole bid back to `detected`. A bid with no payment
/// yet returns to `registered` so the grace clock can still expire it.
pub fn set_bid_chain_state(
    conn: &Connection,
    id: &str,
    status: &str,
    amount_zats: i64,
    confirmations: i64,
    txid: Option<&str>,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bids SET status = ?2, confirmed_amount_zats = ?3, confirmations = ?4, \
         txid = COALESCE(?5, txid), \
         detected_at = CASE WHEN ?2 = 'registered' THEN NULL ELSE COALESCE(detected_at, ?6) END \
         WHERE id = ?1 AND status IN ('registered','detected','confirmed')",
        params![id, status, amount_zats, confirmations, txid, now],
    )?;
    Ok(())
}

/// The one live bid this identity holds on this lot, if any. Bidding is
/// one-per-identity-per-auction so that raising a bid tops up the deposit it
/// already escrowed instead of opening a second competing position.
pub fn live_bid_for_auction_user(
    conn: &Connection,
    auction_id: &str,
    pubkey: &str,
) -> rusqlite::Result<Option<Bid>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BID_COLS} FROM bids WHERE auction_id = ?1 AND user_pubkey = ?2 \
         AND status IN ('registered','detected','confirmed') \
         ORDER BY created_at DESC LIMIT 1"
    ))?;
    let mut rows = stmt.query_map(params![auction_id, pubkey], bid_from_row)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// Raise a live bid's registered total by `by_zats`, returning the new total.
/// Refuses (returns `None`) once the bid leaves the live set.
pub fn raise_bid_registered_amount(
    conn: &Connection,
    id: &str,
    by_zats: i64,
) -> rusqlite::Result<Option<i64>> {
    let n = conn.execute(
        "UPDATE bids SET registered_amount_zats = registered_amount_zats + ?2 \
         WHERE id = ?1 AND status IN ('registered','detected','confirmed')",
        params![id, by_zats],
    )?;
    if n != 1 {
        return Ok(None);
    }
    conn.query_row(
        "SELECT registered_amount_zats FROM bids WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .map(Some)
}

pub fn mark_bid_status(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bids SET status = ?2 WHERE id = ?1",
        params![id, status],
    )?;
    Ok(())
}

/// Bids still waiting on the chain: `registered` ones have not appeared in a
/// block yet, and `detected` ones have not reached their confirmation target.
/// The regtest miner uses this to keep producing blocks after a payment has
/// drained the mempool — otherwise a bid freezes at 1 confirmation forever
/// and its auction can never settle.
pub fn bids_awaiting_chain(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM bids WHERE status IN ('registered', 'detected')",
        [],
        |row| row.get(0),
    )
}

pub fn mark_bid_refund(
    conn: &Connection,
    id: &str,
    txid: &str,
    amount_zats: i64,
    status: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bids SET refund_txid = ?2, refund_amount_zats = ?3, status = ?4 WHERE id = ?1",
        params![id, txid, amount_zats, status],
    )?;
    Ok(())
}

pub fn bids_for_user(conn: &Connection, pubkey: &str) -> rusqlite::Result<Vec<Bid>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BID_COLS} FROM bids WHERE user_pubkey = ?1 ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(params![pubkey], bid_from_row)?;
    rows.collect()
}

pub fn upsert_identity(conn: &Connection, pubkey: &str, now: i64) -> rusqlite::Result<Identity> {
    conn.execute(
        "INSERT INTO identities (pubkey, first_seen, last_seen, sign_in_count)
         VALUES (?1, ?2, ?2, 1)
         ON CONFLICT(pubkey) DO UPDATE SET last_seen = ?2, sign_in_count = sign_in_count + 1",
        params![pubkey, now],
    )?;
    conn.query_row(
        "SELECT pubkey, first_seen, last_seen, sign_in_count FROM identities WHERE pubkey = ?1",
        params![pubkey],
        |row| {
            Ok(Identity {
                pubkey: row.get(0)?,
                first_seen: row.get(1)?,
                last_seen: row.get(2)?,
                sign_in_count: row.get(3)?,
            })
        },
    )
}

pub fn get_identity(conn: &Connection, pubkey: &str) -> rusqlite::Result<Option<Identity>> {
    conn.query_row(
        "SELECT pubkey, first_seen, last_seen, sign_in_count FROM identities WHERE pubkey = ?1",
        params![pubkey],
        |row| {
            Ok(Identity {
                pubkey: row.get(0)?,
                first_seen: row.get(1)?,
                last_seen: row.get(2)?,
                sign_in_count: row.get(3)?,
            })
        },
    )
    .optional()
}

pub fn create_session(
    conn: &Connection,
    token_hash: &str,
    pubkey: &str,
    now: i64,
    expires_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sessions (token_hash, pubkey, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
        params![token_hash, pubkey, now, expires_at],
    )?;
    Ok(())
}

pub fn get_session(
    conn: &Connection,
    token_hash: &str,
    now: i64,
) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row(
        "SELECT pubkey, expires_at FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
        params![token_hash, now],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )
    .optional()
}

pub fn delete_session(conn: &Connection, token_hash: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM sessions WHERE token_hash = ?1",
        params![token_hash],
    )?;
    Ok(())
}

pub fn purge_expired_sessions(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])
}

/// The hosted address minted for one identity, if any. One address per
/// identity (per network DB), created on first wallet read.
pub fn get_wallet_address(conn: &Connection, pubkey: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT address FROM wallets WHERE pubkey = ?1",
        params![pubkey],
        |row| row.get(0),
    )
    .optional()
}

/// Bind a freshly minted funder address to an identity. Create-only: a race
/// between concurrent requests keeps the first winner and returns false so
/// the loser reloads rather than orphaning an address.
pub fn insert_wallet_address(
    conn: &Connection,
    pubkey: &str,
    address: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO wallets (pubkey, address, created_at, last_faucet_at)
         VALUES (?1, ?2, ?3, 0)",
        params![pubkey, address, now],
    )?;
    Ok(n > 0)
}

/// Seconds since this identity last claimed the faucet, or `None` if it
/// never has. `None` always allows a claim.
pub fn wallet_faucet_elapsed(
    conn: &Connection,
    pubkey: &str,
    now: i64,
) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT last_faucet_at FROM wallets WHERE pubkey = ?1",
        params![pubkey],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|o| o.filter(|t| *t > 0).map(|t| (now - t).max(0)))
}

/// Stamp a faucet claim if this identity is outside its cooldown window.
/// Atomic compare-and-set: `earliest` is `now - cooldown`. A false return
/// means either the wallet row is missing or another claim won the race —
/// the caller must not send funds.
pub fn claim_wallet_faucet(
    conn: &Connection,
    pubkey: &str,
    now: i64,
    earliest: i64,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE wallets SET last_faucet_at = ?2
         WHERE pubkey = ?1 AND (last_faucet_at = 0 OR last_faucet_at <= ?3)",
        params![pubkey, now, earliest],
    )?;
    Ok(n > 0)
}

/// Release a faucet claim that could not pay out (zecd error), so the user
/// is not charged a cooldown for a transfer that never happened.
pub fn release_wallet_faucet(conn: &Connection, pubkey: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE wallets SET last_faucet_at = 0 WHERE pubkey = ?1",
        params![pubkey],
    )?;
    Ok(())
}

/// Every address handed out to a user. The faucet must never draw from
/// these: they are someone else's balance, not its treasury.
pub fn wallet_addresses(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT address FROM wallets")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// The identity owning a hosted address, when it is one of ours. Lets a
/// transfer between two hosted wallets move ledger value without the pool
/// changing hands twice.
pub fn wallet_pubkey_by_address(
    conn: &Connection,
    address: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT pubkey FROM wallets WHERE address = ?1",
        params![address],
        |row| row.get(0),
    )
    .optional()
}

/// The identity's spendable balance, in zats. This is the number users see
/// and spend against: zecd cannot hold a shielded address's notes apart from
/// the rest of the wallet, so the ledger is the balance of record.
pub fn wallet_balance(conn: &Connection, pubkey: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT balance_zats FROM wallets WHERE pubkey = ?1",
        params![pubkey],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|o| o.unwrap_or(0))
}

/// Add to an identity's balance (faucet payout, or a hosted-to-hosted
/// transfer landing here). False when the identity has no wallet row yet.
pub fn credit_wallet(conn: &Connection, pubkey: &str, amount: i64) -> rusqlite::Result<bool> {
    if amount <= 0 {
        return Ok(true);
    }
    let n = conn.execute(
        "UPDATE wallets SET balance_zats = balance_zats + ?2 WHERE pubkey = ?1",
        params![pubkey, amount],
    )?;
    Ok(n > 0)
}

/// Return a reserved amount to an identity after an on-chain transfer that
/// never happened. Only ever called with money that provably did not move.
pub fn refund_wallet(conn: &Connection, pubkey: &str, amount: i64) -> rusqlite::Result<()> {
    if amount <= 0 {
        return Ok(());
    }
    conn.execute(
        "UPDATE wallets SET balance_zats = balance_zats + ?2 WHERE pubkey = ?1",
        params![pubkey, amount],
    )?;
    Ok(())
}

/// Atomically reserve `amount` for an on-chain spend. A false return means
/// the ledger cannot cover it — concurrent sends cannot both pass this
/// check, because SQLite applies the whole predicate before committing.
pub fn debit_wallet(conn: &Connection, pubkey: &str, amount: i64) -> rusqlite::Result<bool> {
    if amount <= 0 {
        return Ok(true);
    }
    let n = conn.execute(
        "UPDATE wallets SET balance_zats = balance_zats - ?2
         WHERE pubkey = ?1 AND balance_zats >= ?2",
        params![pubkey, amount],
    )?;
    Ok(n > 0)
}

/// Every identity's balance summed. Must never exceed what the funder
/// wallet actually holds in shielded notes — the reserve behind the ledger.
pub fn total_wallet_balances(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(SUM(balance_zats), 0) FROM wallets",
        [],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every statement in this module is parameterized; this pins that
    /// property against regressions: hostile strings must round-trip as
    /// inert data and must not alter query structure.
    #[test]
    fn sql_injection_payloads_stay_inert() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();

        let evil_id = "x'; DROP TABLE auctions; --";
        let evil_title = "'; DELETE FROM bids; --";
        let evil_desc = "1; ATTACH DATABASE 'evil.db' AS evil; --";
        let a = Auction {
            id: evil_id.into(),
            title: evil_title.into(),
            description: evil_desc.into(),
            reserve_zats: 1,
            seller_address: "u".into(),
            seller_pubkey: Some("'; PRAGMA writable_schema=1; --".into()),
            created_at: 100,
            closes_at: 200,
            status: "open".into(),
            settled_at: None,
            sold: None,
            price_zats: None,
            winner_bid_id: None,
            settlement_txid: None,
            settlement_opid: None,
            settlement_plan: None,
            images: vec![],
            category: "other".into(),
            tags: vec![],
            hidden_reserve_zats: None,
            bin_price_zats: None,
            collateral_zats: 0,
            collateral_txid: None,
            delivery_kind: "digital".into(),
            payout_state: None,
            payout_deadline: None,
            payout_txid: None,
            payout_opid: None,
            dispute_reason: None,
            delivery_proof: None,
            dispute_opened_at: None,
            delivery_payload: None,
            payload_claimed: false,
            refund_policy: None,
            seller_contact: None,
            winner_contact: None,
            contact_claimed: false,
        };
        insert_auction(&conn, &a).unwrap();

        let bid = Bid {
            id: "b'; DROP TABLE sessions; --".into(),
            auction_id: evil_id.into(),
            refund_address: "'; UPDATE auctions SET status='settled'; --".into(),
            registered_amount_zats: 5,
            created_at: 101,
            status: "pending".into(),
            txid: None,
            confirmed_amount_zats: None,
            detected_at: None,
            confirmations: 0,
            refund_txid: None,
            refund_amount_zats: None,
            user_pubkey: Some("'; DELETE FROM identities; --".into()),
            is_buy_now: false,
            paid_zats: 0,
        };
        insert_bid(&conn, &bid).unwrap();

        // Payloads round-trip as data; tables still exist.
        let got = get_auction(&conn, evil_id)
            .unwrap()
            .expect("auction stored");
        assert_eq!(got.title, evil_title);
        assert_eq!(got.description, evil_desc);
        assert_eq!(got.status, "open"); // not flipped by the title payload
        let bids = bids_for_auction(&conn, evil_id).unwrap();
        assert_eq!(bids.len(), 1);
        assert_eq!(bids[0].refund_address, bid.refund_address);
        // A second legitimate write proves nothing was dropped.
        let ok = Auction {
            id: "ok".into(),
            ..a.clone()
        };
        insert_auction(&conn, &ok).unwrap();
        assert!(get_auction(&conn, "ok").unwrap().is_some());
        assert!(get_session(&conn, "s", 0).unwrap().is_none()); // sessions table intact
        purge_expired_sessions(&conn, 0).unwrap(); // still callable
    }

    /// The seller contact escrowed at create must survive the INSERT —
    /// pins the `seller_contact` VALUES binding against silently NULLing it.
    #[test]
    fn insert_persists_seller_contact() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();

        let a = Auction {
            id: "lot-contact".into(),
            title: "contact lot".into(),
            description: "d".into(),
            reserve_zats: 1,
            seller_address: "u".into(),
            seller_pubkey: Some("pk".into()),
            created_at: 100,
            closes_at: 200,
            status: "open".into(),
            settled_at: None,
            sold: None,
            price_zats: None,
            winner_bid_id: None,
            settlement_txid: None,
            settlement_opid: None,
            settlement_plan: None,
            images: vec![],
            category: "other".into(),
            tags: vec![],
            hidden_reserve_zats: None,
            bin_price_zats: None,
            collateral_zats: 0,
            collateral_txid: None,
            delivery_kind: "digital".into(),
            payout_state: None,
            payout_deadline: None,
            payout_txid: None,
            payout_opid: None,
            dispute_reason: None,
            delivery_proof: None,
            dispute_opened_at: None,
            delivery_payload: Some("payload".into()),
            payload_claimed: false,
            refund_policy: Some("no returns".into()),
            seller_contact: Some("seller@zecathon".into()),
            winner_contact: None,
            contact_claimed: false,
        };
        insert_auction(&conn, &a).unwrap();

        let got = get_auction(&conn, "lot-contact").unwrap().expect("stored");
        assert_eq!(got.seller_contact.as_deref(), Some("seller@zecathon"));
        // VALUES-neighbours bind in the same statement: a shift would corrupt them too.
        assert_eq!(got.refund_policy.as_deref(), Some("no returns"));
        assert_eq!(got.delivery_payload.as_deref(), Some("payload"));
        assert_eq!(got.winner_contact, None);
        assert!(!got.contact_claimed);
    }

    /// The ledger is the balance of record: credits accumulate, debits are
    /// atomic and refuse to overdraw, and a refund returns exactly what was
    /// reserved. A debit that cannot be covered changes nothing.
    #[test]
    fn ledger_credits_debits_and_refunds() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();

        upsert_identity(&conn, "pk1", 1).unwrap();
        assert!(insert_wallet_address(&conn, "pk1", "u1", 1).unwrap());
        assert_eq!(wallet_balance(&conn, "pk1").unwrap(), 0);

        // An identity with no wallet row owns nothing, and cannot be paid.
        assert!(!credit_wallet(&conn, "ghost", 5).unwrap());
        assert_eq!(wallet_balance(&conn, "ghost").unwrap(), 0);

        assert!(credit_wallet(&conn, "pk1", 50_000_000).unwrap());
        assert_eq!(wallet_balance(&conn, "pk1").unwrap(), 50_000_000);

        assert!(debit_wallet(&conn, "pk1", 40_000_000).unwrap());
        assert_eq!(wallet_balance(&conn, "pk1").unwrap(), 10_000_000);

        // Overdraft: refused, and the balance is untouched by the attempt.
        assert!(!debit_wallet(&conn, "pk1", 20_000_000).unwrap());
        assert_eq!(wallet_balance(&conn, "pk1").unwrap(), 10_000_000);

        refund_wallet(&conn, "pk1", 40_000_000).unwrap();
        assert_eq!(wallet_balance(&conn, "pk1").unwrap(), 50_000_000);
        assert_eq!(total_wallet_balances(&conn).unwrap(), 50_000_000);
    }

    /// Only addresses this wallet actually handed out map back to an identity,
    /// so a transfer to an outside recipient never credits a hosted balance.
    #[test]
    fn wallet_lookup_is_address_scoped() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();

        upsert_identity(&conn, "pk1", 1).unwrap();
        upsert_identity(&conn, "pk2", 1).unwrap();
        assert!(insert_wallet_address(&conn, "pk1", "u1", 1).unwrap());
        assert!(insert_wallet_address(&conn, "pk2", "u2", 1).unwrap());
        assert_eq!(
            wallet_pubkey_by_address(&conn, "u2").unwrap().as_deref(),
            Some("pk2")
        );
        assert_eq!(wallet_pubkey_by_address(&conn, "uz_external").unwrap(), None);
        assert_eq!(wallet_pubkey_by_address(&conn, "").unwrap(), None);
    }

    /// A database created before the hosted wallet kept a ledger upgrades in
    /// place: addresses survive, and every balance starts at zero because the
    /// faucet is how money enters the ledger.
    #[test]
    fn legacy_wallets_gain_a_zero_balance() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE wallets (
                pubkey TEXT PRIMARY KEY,
                address TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_faucet_at INTEGER NOT NULL DEFAULT 0
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wallets (pubkey, address, created_at, last_faucet_at)
             VALUES ('pk', 'u1', 1, 42)",
            [],
        )
        .unwrap();

        init(&conn).unwrap();

        assert_eq!(wallet_balance(&conn, "pk").unwrap(), 0);
        assert_eq!(
            get_wallet_address(&conn, "pk").unwrap().as_deref(),
            Some("u1")
        );
        // The migration must not silently forgive a faucet cooldown.
        assert_eq!(wallet_faucet_elapsed(&conn, "pk", 43).unwrap(), Some(1));
        assert!(credit_wallet(&conn, "pk", 7).unwrap());
        assert_eq!(wallet_balance(&conn, "pk").unwrap(), 7);
    }
}
