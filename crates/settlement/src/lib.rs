use serde::{Deserialize, Serialize};

/// Bidshield's take: a percentage of the hammer price (the seller's proceeds),
/// expressed in basis points. 500 bps = 5%. It is deducted from the seller's
/// side only — every bidder is always refunded in full.
pub const COMMISSION_BPS: i64 = 500;

/// The commission, in zats, withheld from a hammer price of `price_zats`.
pub fn commission_zats(price_zats: i64, commission_bps: i64) -> i64 {
    if price_zats <= 0 || commission_bps <= 0 {
        return 0;
    }
    (price_zats as i128 * commission_bps as i128 / 10_000_i128) as i64
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BidInput {
    pub id: String,
    pub refund_address: String,
    pub amount_zats: i64,
    /// Buy-it-now bid: the winner pays their own amount (the listed BIN
    /// price) instead of the second-price rule.
    #[serde(default)]
    pub is_buy_now: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutgoingPayment {
    pub bid_id: Option<String>,
    pub to: String,
    pub amount_zats: i64,
    pub kind: PaymentKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PaymentKind {
    BidRefund,
    WinnerExcessRefund,
    SellerProceeds,
    /// Return of the seller's escrowed listing collateral. Orchestration-level
    /// (the settlement math never computes it); the API appends it.
    CollateralRefund,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settlement {
    pub sold: bool,
    pub price_zats: i64,
    pub winner_bid_id: Option<String>,
    pub payments: Vec<OutgoingPayment>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SettlementError {
    #[error("reserve must be >= 0")]
    NegativeReserve,
    #[error("bid {0} has non-positive amount")]
    NonPositiveBid(String),
}

pub fn settle(
    bids: &[BidInput],
    reserve_zats: i64,
    commission_bps: i64,
) -> Result<Settlement, SettlementError> {
    if reserve_zats < 0 {
        return Err(SettlementError::NegativeReserve);
    }
    for b in bids {
        if b.amount_zats <= 0 {
            return Err(SettlementError::NonPositiveBid(b.id.clone()));
        }
    }

    let mut sorted: Vec<&BidInput> = bids.iter().collect();
    sorted.sort_by(|a, b| {
        b.amount_zats
            .cmp(&a.amount_zats)
            .then_with(|| a.id.cmp(&b.id))
    });

    let top = match sorted.first() {
        Some(t) => *t,
        None => {
            return Ok(Settlement {
                sold: false,
                price_zats: 0,
                winner_bid_id: None,
                payments: vec![],
            });
        }
    };

    if top.amount_zats < reserve_zats {
        // No sale: every bidder is refunded in full, no commission taken.
        let payments: Vec<OutgoingPayment> = sorted
            .iter()
            .map(|b| OutgoingPayment {
                bid_id: Some(b.id.clone()),
                to: b.refund_address.clone(),
                amount_zats: b.amount_zats,
                kind: PaymentKind::BidRefund,
            })
            .collect();
        return Ok(Settlement {
            sold: false,
            price_zats: 0,
            winner_bid_id: None,
            payments,
        });
    }

    // Buy-it-now: a confirmed BIN bid beats every sealed bid — that is the
    // point of "buy it now". The winner pays the listed price they posted;
    // no excess refund (escrowed amount already equals the hammer). BIN
    // below the public reserve is not exercised (matches plain-bid floor).
    if let Some(bin) = sorted.iter().find(|b| b.is_buy_now && b.amount_zats >= reserve_zats) {
        let price = bin.amount_zats;
        let commission = commission_zats(price, commission_bps);
        let mut payments = Vec::new();
        for b in sorted.iter().filter(|b| b.id != bin.id) {
            payments.push(OutgoingPayment {
                bid_id: Some(b.id.clone()),
                to: b.refund_address.clone(),
                amount_zats: b.amount_zats,
                kind: PaymentKind::BidRefund,
            });
        }
        payments.push(OutgoingPayment {
            bid_id: None,
            to: String::new(),
            amount_zats: price - commission,
            kind: PaymentKind::SellerProceeds,
        });
        payments.retain(|p| p.amount_zats > 0);
        return Ok(Settlement {
            sold: true,
            price_zats: price,
            winner_bid_id: Some(bin.id.clone()),
            payments,
        });
    }

    let second = sorted.get(1).map(|b| b.amount_zats);
    let price = match second {
        Some(s) if s >= reserve_zats => s,
        _ => reserve_zats,
    };
    let commission = commission_zats(price, commission_bps);

    let mut payments = Vec::new();
    for b in sorted.iter().skip(1) {
        payments.push(OutgoingPayment {
            bid_id: Some(b.id.clone()),
            to: b.refund_address.clone(),
            amount_zats: b.amount_zats,
            kind: PaymentKind::BidRefund,
        });
    }
    payments.push(OutgoingPayment {
        bid_id: Some(top.id.clone()),
        to: top.refund_address.clone(),
        amount_zats: top.amount_zats - price,
        kind: PaymentKind::WinnerExcessRefund,
    });
    payments.push(OutgoingPayment {
        bid_id: None,
        to: String::new(),
        amount_zats: price - commission,
        kind: PaymentKind::SellerProceeds,
    });
    payments.retain(|p| p.amount_zats > 0);

    Ok(Settlement {
        sold: true,
        price_zats: price,
        winner_bid_id: Some(top.id.clone()),
        payments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bid(id: &str, amount_zats: i64) -> BidInput {
        BidInput {
            id: id.into(),
            refund_address: format!("uregtest1addr_for_{id}"),
            amount_zats,
            is_buy_now: false,
        }
    }

    fn bin_bid(id: &str, amount_zats: i64) -> BidInput {
        BidInput {
            is_buy_now: true,
            ..bid(id, amount_zats)
        }
    }

    #[test]
    fn commission_is_five_percent_of_hammer_price() {
        assert_eq!(commission_zats(200_000_000, 500), 10_000_000);
        assert_eq!(commission_zats(0, 500), 0);
        assert_eq!(commission_zats(100_000_000, 0), 0);
        assert_eq!(commission_zats(1, 500), 0);
    }

    #[test]
    fn vickrey_winner_pays_second_price() {
        let bids = vec![
            bid("a", 300_000_000),
            bid("b", 200_000_000),
            bid("c", 100_000_000),
        ];
        let s = settle(&bids, 50_000_000, 500).unwrap();
        assert!(s.sold);
        assert_eq!(s.price_zats, 200_000_000);
        assert_eq!(s.winner_bid_id.as_deref(), Some("a"));

        let winner_refund = s
            .payments
            .iter()
            .find(|p| p.kind == PaymentKind::WinnerExcessRefund)
            .unwrap();
        // Winner is refunded their full excess (bid - hammer), no fee.
        assert_eq!(winner_refund.amount_zats, 300_000_000 - 200_000_000);
        assert_eq!(winner_refund.to, "uregtest1addr_for_a");

        let seller = s
            .payments
            .iter()
            .find(|p| p.kind == PaymentKind::SellerProceeds)
            .unwrap();
        // Seller receives the hammer price less the 5% commission.
        assert_eq!(seller.amount_zats, 200_000_000 - 10_000_000);

        let loser_refunds: Vec<_> = s
            .payments
            .iter()
            .filter(|p| p.kind == PaymentKind::BidRefund)
            .collect();
        assert_eq!(loser_refunds.len(), 2);
        // Losers are refunded in full, no fee.
        assert_eq!(loser_refunds[0].amount_zats, 200_000_000);
        assert_eq!(loser_refunds[1].amount_zats, 100_000_000);
    }

    #[test]
    fn reserve_beats_second_price() {
        let bids = vec![bid("a", 500_000_000), bid("b", 100_000_000)];
        let s = settle(&bids, 400_000_000, 500).unwrap();
        assert!(s.sold);
        assert_eq!(s.price_zats, 400_000_000);
        let seller = s
            .payments
            .iter()
            .find(|p| p.kind == PaymentKind::SellerProceeds)
            .unwrap();
        assert_eq!(seller.amount_zats, 400_000_000 - 20_000_000);
    }

    #[test]
    fn below_reserve_is_no_sale_all_refunded_in_full() {
        let bids = vec![bid("a", 100_000_000), bid("b", 50_000_000)];
        let s = settle(&bids, 200_000_000, 500).unwrap();
        assert!(!s.sold);
        assert_eq!(s.price_zats, 0);
        assert_eq!(s.winner_bid_id, None);
        assert_eq!(s.payments.len(), 2);
        assert!(s.payments.iter().all(|p| p.kind == PaymentKind::BidRefund));
        // No sale means no commission — every bidder gets their full deposit.
        assert_eq!(s.payments[0].amount_zats, 100_000_000);
        assert_eq!(s.payments[1].amount_zats, 50_000_000);
    }

    #[test]
    fn single_bid_pays_reserve() {
        let bids = vec![bid("a", 250_000_000)];
        let s = settle(&bids, 200_000_000, 500).unwrap();
        assert!(s.sold);
        assert_eq!(s.price_zats, 200_000_000);
        assert_eq!(s.payments.len(), 2);
        let winner_refund = s
            .payments
            .iter()
            .find(|p| p.kind == PaymentKind::WinnerExcessRefund)
            .unwrap();
        assert_eq!(winner_refund.amount_zats, 50_000_000);
    }

    #[test]
    fn single_bid_at_reserve_sends_only_seller_payment() {
        let bids = vec![bid("a", 200_000_000)];
        let s = settle(&bids, 200_000_000, 500).unwrap();
        assert!(s.sold);
        assert!(s
            .payments
            .iter()
            .all(|p| p.kind != PaymentKind::WinnerExcessRefund));
        let seller = s
            .payments
            .iter()
            .find(|p| p.kind == PaymentKind::SellerProceeds)
            .unwrap();
        assert_eq!(seller.amount_zats, 200_000_000 - 10_000_000);
    }

    #[test]
    fn empty_bids_no_sale_no_payments() {
        let s = settle(&[], 100_000_000, 500).unwrap();
        assert!(!s.sold);
        assert!(s.payments.is_empty());
    }

    #[test]
    fn ties_break_deterministically_by_id() {
        let a = bid("a", 200_000_000);
        let b = bid("b", 200_000_000);
        let s1 = settle(&[a.clone(), b.clone()], 100_000_000, 500).unwrap();
        let s2 = settle(&[b, a], 100_000_000, 500).unwrap();
        assert_eq!(s1.winner_bid_id, s2.winner_bid_id);
        assert_eq!(s1.payments, s2.payments);
    }

    #[test]
    fn rejects_non_positive_bid() {
        let s = settle(&[bid("a", 0)], 0, 500);
        assert!(s.is_err());
    }

    #[test]
    fn wallet_never_overdrawn() {
        let bids = vec![
            bid("a", 500_000_000),
            bid("b", 300_000_000),
            bid("c", 200_000_000),
        ];
        let s = settle(&bids, 100_000_000, 500).unwrap();
        let total_in: i64 = bids.iter().map(|b| b.amount_zats).sum();
        let total_out: i64 = s.payments.iter().map(|p| p.amount_zats).sum();
        assert!(total_out <= total_in);
    }

    #[test]
    fn commission_never_exceeds_hammer_price() {
        let bids = vec![bid("a", 200_000_000), bid("b", 100_000_000)];
        // 50% commission: seller keeps half the hammer price (100M - 50M).
        let s = settle(&bids, 50_000_000, 5_000).unwrap();
        let seller = s
            .payments
            .iter()
            .find(|p| p.kind == PaymentKind::SellerProceeds)
            .unwrap();
        assert_eq!(seller.amount_zats, 100_000_000 - 50_000_000);
        // The commission itself is never more than the hammer price.
        assert!(commission_zats(100_000_000, 5_000) <= 100_000_000);
    }

    #[test]
    fn buy_now_beats_higher_sealed_bid() {
        // A sealed bid of 5ZEC is already escrowed; the buyer exercises
        // BIN at 3ZEC. BIN wins at 3ZEC, the 5ZEC bidder is refunded in full.
        let bids = vec![bid("sealed", 500_000_000), bin_bid("bin", 300_000_000)];
        let s = settle(&bids, 100_000_000, 500).unwrap();
        assert!(s.sold);
        assert_eq!(s.winner_bid_id.as_deref(), Some("bin"));
        assert_eq!(s.price_zats, 300_000_000);
        assert!(s
            .payments
            .iter()
            .all(|p| p.kind != PaymentKind::WinnerExcessRefund));
        let seller = s
            .payments
            .iter()
            .find(|p| p.kind == PaymentKind::SellerProceeds)
            .unwrap();
        assert_eq!(seller.amount_zats, 300_000_000 - 15_000_000);
        let refund = s
            .payments
            .iter()
            .find(|p| p.kind == PaymentKind::BidRefund)
            .unwrap();
        assert_eq!(refund.amount_zats, 500_000_000);
        assert_eq!(refund.to, "uregtest1addr_for_sealed");
    }

    #[test]
    fn buy_now_alone_still_pays_itself() {
        let bids = vec![bin_bid("bin", 250_000_000)];
        let s = settle(&bids, 100_000_000, 500).unwrap();
        assert!(s.sold);
        assert_eq!(s.price_zats, 250_000_000);
        assert_eq!(s.winner_bid_id.as_deref(), Some("bin"));
    }

    #[test]
    fn buy_now_below_reserve_is_no_sale() {
        let bids = vec![bin_bid("bin", 50_000_000)];
        let s = settle(&bids, 100_000_000, 500).unwrap();
        assert!(!s.sold);
        assert_eq!(s.price_zats, 0);
    }
}
