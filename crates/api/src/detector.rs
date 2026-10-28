use std::collections::HashMap;
use std::sync::Arc;

use tracing::{info, warn};
use zecd_client::zats;

use crate::db;
use crate::routes::ApiError;
use crate::state::{AppState, NetworkRuntime};

/// Index confirmed-receive rows by memo, keeping every row per memo so the
/// detector can prefer an amount-exact match over a forged squat payment.
fn receive_rows_by_memo(rows: &[zecd_client::TxRow]) -> HashMap<String, Vec<&zecd_client::TxRow>> {
    let mut map: HashMap<String, Vec<&zecd_client::TxRow>> = HashMap::new();
    for r in rows {
        if r.category != "receive" {
            continue;
        }
        if let Some(memo) = &r.memo_str {
            if memo.starts_with("bid:") || memo.starts_with("collateral:") {
                map.entry(memo.clone()).or_default().push(r);
            }
        }
    }
    map
}

/// Pick the row that exactly matches the registered amount; fall back to
/// `None` when no row matches (the caller treats that as a mismatch only if
/// *some* row carried the memo - squat payments never credit the bid).
fn pick_exact<'a>(
    rows: &[&'a zecd_client::TxRow],
    expected_zats: i64,
) -> Option<&'a zecd_client::TxRow> {
    rows.iter()
        .copied()
        .find(|r| zats(r.amount) == expected_zats)
}

/// Sum every payment carrying a bid's memo, and report the *least*-confirmed
/// of those payments. A bid's escrowed amount is the running total of all
/// deposits under its memo, so a top-up raises the amount instead of replacing
/// it. The least-confirmed row drives the confirmation count because the bid
/// is only as deep as its shallowest contributing payment - a top-up still in
/// the mempool therefore holds the whole bid at `detected` until it confirms.
fn sum_memo_rows(rows: &[&zecd_client::TxRow]) -> Option<(i64, i64, String)> {
    let mut sum = 0i64;
    let mut min_conf = i64::MAX;
    let mut limiting_txid = String::new();
    for r in rows {
        sum += zats(r.amount);
        if r.confirmations < min_conf {
            min_conf = r.confirmations;
            limiting_txid = r.txid.clone();
        }
    }
    if sum <= 0 {
        None
    } else {
        Some((sum, min_conf, limiting_txid))
    }
}

fn status_for(confirmed: bool) -> &'static str {
    if confirmed { "confirmed" } else { "detected" }
}

pub async fn sync_net(state: &AppState, net: &NetworkRuntime) -> Result<(), ApiError> {
    let rows = net
        .zecd
        .list_transactions(1000)
        .await
        .map_err(|e| ApiError::Zecd(e.to_string()))?;
    let by_memo = receive_rows_by_memo(&rows);
    let now = chrono::Utc::now().timestamp();
    let conf_target = net.conf_target;
    let grace = state.cfg.missed_grace_secs;

    let db = net.db();
    let registered = db::bids_with_status(&db, "registered")?;
    for b in registered {
        let memo = format!("bid:{}", b.id);
        let candidates = by_memo.get(&memo).map(|v| v.as_slice()).unwrap_or(&[]);
        if let Some((sum, confs, txid)) = sum_memo_rows(candidates) {
            // Any real payment under the memo credits the bid with the running
            // total, so a top-up raises the amount rather than replacing it.
            let confirmed = confs >= conf_target;
            db::set_bid_chain_state(&db, &b.id, status_for(confirmed), sum, confs, Some(&txid), now)?;
            info!(
                bid = %b.id,
                txid = %txid,
                amount_zats = sum,
                registered_zats = b.registered_amount_zats,
                confirmations = confs,
                "bid detected"
            );
        } else if !candidates.is_empty() {
            warn!(
                bid = %b.id,
                expected_zats = b.registered_amount_zats,
                "memo present on chain but total is not positive; ignoring"
            );
        } else if now - b.created_at > grace
            && db::cas_bid_status(&db, &b.id, "registered", "missed")?
        {
            info!(bid = %b.id, "bid missed (never seen on chain within grace)");
        }
    }

    let detected = db::bids_with_status(&db, "detected")?;
    // A confirmed bid is re-examined too: a top-up that lands after the bid
    // already reached depth must grow the amount and, because the new payment
    // is still shallow, pull the bid back to `detected` until it confirms.
    let mut live = db::bids_with_status(&db, "confirmed")?;
    live.extend(detected);
    for b in live {
        // Re-derive from the memo every tick so a top-up that lands after the
        // first detection grows the amount and, if the new payment is still
        // shallow, holds the bid at `detected` until it reaches depth.
        let memo = format!("bid:{}", b.id);
        let candidates = by_memo.get(&memo).map(|v| v.as_slice()).unwrap_or(&[]);
        if let Some((sum, confs, txid)) = sum_memo_rows(candidates) {
            let confirmed = confs >= conf_target;
            let changed = sum != b.confirmed_amount_zats.unwrap_or(0) || confs != b.confirmations;
            db::set_bid_chain_state(&db, &b.id, status_for(confirmed), sum, confs, Some(&txid), now)?;
            if changed {
                info!(bid = %b.id, amount_zats = sum, confirmations = confs, "bid chain state updated");
            }
            // A confirmed buy-it-now payment ends the Vickrey round early:
            // the BIN buyer has already paid the full asking price.
            if confirmed
                && b.is_buy_now
                && db::cas_auction_status(&db, &b.auction_id, "open", "closed")?
            {
                info!(auction = %b.auction_id, bid = %b.id, "auction closed early by buy-it-now");
            }
        } else {
            // Payments vanished (reorg / pruned history). Return the bid to
            // `registered` so it can be re-detected rather than counting an
            // escrow that is no longer on chain.
            db::set_bid_chain_state(&db, &b.id, "registered", 0, 0, None, now)?;
            warn!(bid = %b.id, "detected bid lost its chain rows; reverting to registered");
        }
    }

    // Seller collateral: exact-amount match on the `collateral:<auction_id>`
    // memo. Same squat-resistance rule as bids.
    let open_collateral: Vec<(String, i64)> = {
        let mut stmt = db
            .prepare("SELECT id, collateral_zats FROM auctions WHERE collateral_zats > 0 AND collateral_txid IS NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (auction_id, needed_zats) in open_collateral {
        let memo = format!("collateral:{auction_id}");
        let candidates = by_memo.get(&memo).map(|v| v.as_slice()).unwrap_or(&[]);
        if let Some(row) = pick_exact(candidates, needed_zats) {
            if db::mark_collateral_paid(&db, &auction_id, &row.txid)? {
                info!(auction = %auction_id, txid = %row.txid, "collateral escrowed");
            }
        }
    }

    let closed = db::close_due_auctions(&db, now)?;
    if !closed.is_empty() {
        info!(auctions = ?closed, "auctions auto-closed");
    }
    Ok(())
}

pub async fn run(state: Arc<AppState>, net_idx: usize) {
    let period = std::time::Duration::from_secs(state.cfg.poll_secs.max(1));
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let net = &state.networks[net_idx];
        // Profiles whose backend is down — or whose chain is still syncing —
        // are polled for readiness instead of sweeping; when the backend is
        // up AND zebra reports the chain near the estimated network tip we
        // fetch the auctioneer address once and flip the profile live.
        if !net.ready.load(std::sync::atomic::Ordering::Relaxed) {
            if net.zecd.ready().await && net.zebra.synced(state.cfg.sync_progress_min).await {
                let mut ua = net.auctioneer_ua();
                if ua.is_empty() {
                    if let Ok(a) = net.zecd.get_new_address(None).await {
                        if a.starts_with('u') {
                            net.set_auctioneer_ua(&a);
                            ua = a;
                        }
                    }
                }
                if !ua.is_empty() {
                    net.ready.store(true, std::sync::atomic::Ordering::Relaxed);
                    info!(network = %net.name, "backend became ready");
                }
            }
            continue;
        }
        if let Err(e) = sync_net(&state, net).await {
            warn!(network = %net.name, "detector sweep failed: {e}");
        }
    }
}
