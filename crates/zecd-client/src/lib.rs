use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("transport: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("rpc error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("decode: {0}")]
    Decode(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone)]
pub struct ZecdClient {
    http: reqwest::Client,
    url: String,
    health_url: String,
    user: Option<String>,
    password: Option<String>,
}

impl ZecdClient {
    pub fn new(url: impl Into<String>, health_url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            url: url.into(),
            health_url: health_url.into(),
            user: None,
            password: None,
        }
    }

    pub fn with_basic_auth(mut self, user: impl Into<String>, password: impl Into<String>) -> Self {
        self.user = Some(user.into());
        self.password = Some(password.into());
        self
    }

    pub async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        let mut req = self.http.post(&self.url).json(
            &json!({"jsonrpc": "1.0", "id": "bidshield", "method": method, "params": params}),
        );
        if let (Some(u), Some(p)) = (&self.user, &self.password) {
            req = req.basic_auth(u, Some(p));
        }
        let res: Value = req.send().await?.json().await?;
        if let Some(err) = res.get("error").filter(|e| !e.is_null()) {
            return Err(Error::Rpc {
                code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        serde_json::from_value(res.get("result").cloned().unwrap_or(Value::Null))
            .map_err(|e| Error::Decode(e.to_string()))
    }

    pub async fn ready(&self) -> bool {
        self.http
            .get(&self.health_url)
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    pub async fn get_balance_zats(&self) -> Result<i64> {
        let zec: f64 = self.call("getbalance", json!([])).await?;
        Ok(zats(zec))
    }

    /// Raw chain id from zecd: "regtest", "test", or "main".
    pub async fn get_blockchain_info(&self) -> Result<BlockchainInfo> {
        self.call("getblockchaininfo", json!([])).await
    }

    pub async fn get_new_address(&self, addr_type: Option<&str>) -> Result<String> {
        self.call("getnewaddress", json!(["", addr_type.unwrap_or("")]))
            .await
    }

    pub async fn list_transactions(&self, count: usize) -> Result<Vec<TxRow>> {
        self.call("listtransactions", json!(["*", count])).await
    }

    pub async fn get_transaction(&self, txid: &str) -> Result<GetTx> {
        self.call("gettransaction", json!([txid])).await
    }

    pub async fn get_unconfirmed_balance_zats(&self) -> Result<i64> {
        let zec: f64 = self.call("getunconfirmedbalance", json!([])).await?;
        Ok(zats(zec))
    }

    pub async fn send_shielded(
        &self,
        from: &str,
        address: &str,
        amount_zec: &str,
    ) -> Result<String> {
        let opid: String = self
            .call(
                "z_sendmany",
                json!([from, [{ "address": address, "amount": amount_zec }]]),
            )
            .await?;
        Ok(opid)
    }

    pub async fn send_shielded_batch(
        &self,
        from: &str,
        outputs: &[(String, String)],
    ) -> Result<String> {
        let outs: Vec<Value> = outputs
            .iter()
            .map(|(address, amount_zec)| json!({ "address": address, "amount": amount_zec }))
            .collect();
        let opid: String = self.call("z_sendmany", json!([from, outs])).await?;
        Ok(opid)
    }

    pub async fn operation_result(&self, opid: &str) -> Result<Option<OpEntry>> {
        let entries: Vec<OpEntry> = self.call("z_getoperationresult", json!([[opid]])).await?;
        Ok(entries.into_iter().next())
    }

    pub async fn operation_status(&self, opid: &str) -> Result<Option<OpEntry>> {
        let entries: Vec<OpEntry> = self.call("z_getoperationstatus", json!([[opid]])).await?;
        Ok(entries.into_iter().next())
    }

    pub async fn shield_coinbase(&self, source: &str, dest: &str, limit: u64) -> Result<String> {
        self.call("z_shieldcoinbase", json!([source, dest, null, limit]))
            .await
    }

    /// Validate an address with zecd (syntax + network). `ismine` is true
    /// when the address belongs to this wallet — callers reject those for
    /// user-supplied destinations to prevent funds circling into escrow.
    pub async fn z_validateaddress(&self, address: &str) -> Result<ValidateAddress> {
        self.call("z_validateaddress", json!([address])).await
    }

    /// Unspent notes (shielded and transparent) held by this wallet.
    /// `listunspent` carries the owning address for shielded pools too, so
    /// callers can compute a per-address balance by filtering the result.
    pub async fn list_unspent(&self) -> Result<Vec<UnspentNote>> {
        self.call("listunspent", json!([0, 999_999])).await
    }

    /// Sum of spendable zats at one address, from `listunspent`.
    pub async fn balance_at_zats(&self, address: &str) -> Result<i64> {
        let notes = self.list_unspent().await?;
        Ok(notes
            .iter()
            .filter(|n| n.address.as_deref() == Some(address))
            .map(|n| zats(n.amount))
            .sum())
    }

    /// Shielded send with an optional 512-byte memo, hex-encoded as zecd
    /// requires (`memo must be in hexadecimal format`). `from` must be an
    /// explicit wallet address: zecd rejects the empty string that zcashd
    /// accepts for "any funds in this wallet".
    pub async fn send_with_memo(
        &self,
        from: &str,
        address: &str,
        amount_zec: &str,
        memo: Option<&str>,
    ) -> Result<String> {
        let mut out = json!({ "address": address, "amount": amount_zec });
        if let Some(m) = memo {
            if !m.is_empty() {
                out["memo"] = Value::String(hex_encode(m.as_bytes()));
            }
        }
        let opid: String = self
            .call("z_sendmany", json!([from, [out]]))
            .await?;
        Ok(opid)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ValidateAddress {
    pub isvalid: bool,
    #[serde(default)]
    pub ismine: bool,
    pub address: Option<String>,
}

/// One row of `listunspent`. `address` is populated for shielded pools
/// (orchard/ironwood), which is what makes per-address balances computable.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UnspentNote {
    #[serde(default)]
    pub address: Option<String>,
    pub amount: f64,
    pub confirmations: i64,
    #[serde(default)]
    pub pool: Option<String>,
    #[serde(default)]
    pub spendable: Option<bool>,
    pub txid: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BlockchainInfo {
    pub chain: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TxRow {
    pub address: Option<String>,
    pub category: String,
    pub amount: f64,
    pub confirmations: i64,
    pub txid: String,
    #[serde(rename = "memoStr")]
    pub memo_str: Option<String>,
    pub memo: Option<String>,
    pub pool: Option<String>,
    pub time: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GetTx {
    pub amount: f64,
    pub confirmations: i64,
    pub txid: Option<String>,
    #[serde(rename = "memoStr")]
    pub memo_str: Option<String>,
    pub details: Option<Vec<TxDetail>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TxDetail {
    pub address: Option<String>,
    pub category: String,
    pub amount: f64,
    #[serde(rename = "memoStr")]
    pub memo_str: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpEntry {
    pub status: Option<String>,
    pub result: Option<OpResult>,
    pub error: Option<OpError>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpResult {
    pub txid: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpError {
    pub code: Option<i64>,
    pub message: Option<String>,
}

pub fn zats(zec: f64) -> i64 {
    (zec * 100_000_000.0).round() as i64
}

pub fn zec_str(zats: i64) -> String {
    format!("{:.8}", zats as f64 / 100_000_000.0)
}

/// Zebra's getblockchaininfo. The API reads `verificationprogress` to tell
/// "zecd answers" apart from "the chain is actually caught up": zecd's
/// /readyz goes green the moment RPC + wallet load, which on a syncing
/// public chain is hours before the chain is usable for auctions.
#[derive(Debug, Clone, Deserialize)]
pub struct ZebraChainInfo {
    #[serde(default)]
    pub blocks: u64,
    #[serde(default)]
    pub verificationprogress: Option<f64>,
}

impl ZebraChainInfo {
    /// Regtest always reports 1.0 (zebra short-circuits private chains);
    /// a syncing public chain reports blocks/estimatedheight until near tip.
    /// Missing or non-finite progress counts as synced so an odd build never
    /// bricks a profile whose backend is otherwise answering.
    pub fn is_synced(&self, min_progress: f64) -> bool {
        match self.verificationprogress {
            Some(p) if p.is_finite() => p >= min_progress,
            _ => true,
        }
    }
}

/// Client for zebra's JSON-RPC (open on the compose network in our configs —
/// no cookie auth), used only for the sync-progress probe.
#[derive(Debug, Clone)]
pub struct ZebraClient {
    http: reqwest::Client,
    url: String,
}

impl ZebraClient {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            url: url.into(),
        }
    }

    /// One JSON-RPC call against zebra (open on the compose network, no auth).
    async fn call(&self, method: &str, params: Value, timeout_secs: u64) -> Result<Value> {
        let res: Value = self
            .http
            .post(&self.url)
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .json(&json!({
                "jsonrpc": "2.0",
                "id": "bidshield",
                "method": method,
                "params": params,
            }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = res.get("error").filter(|e| !e.is_null()) {
            return Err(Error::Rpc {
                code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        Ok(res.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn get_blockchain_info(&self) -> Result<ZebraChainInfo> {
        let value = self.call("getblockchaininfo", json!([]), 3).await?;
        serde_json::from_value(value).map_err(|e| Error::Decode(e.to_string()))
    }

    pub async fn synced(&self, min_progress: f64) -> bool {
        match self.get_blockchain_info().await {
            Ok(info) => info.is_synced(min_progress),
            Err(_) => false,
        }
    }

    /// Transaction ids waiting in the mempool. This is what tells the regtest
    /// miner there is something to confirm.
    pub async fn mempool_txids(&self) -> Result<Vec<String>> {
        let value = self.call("getrawmempool", json!([]), 3).await?;
        serde_json::from_value(value).map_err(|e| Error::Decode(e.to_string()))
    }

    /// Mine `blocks` blocks (regtest only: `disable_pow = true`), returning
    /// the hashes of the blocks created.
    pub async fn generate(&self, blocks: u32) -> Result<Vec<String>> {
        let value = self.call("generate", json!([blocks]), 30).await?;
        serde_json::from_value(value).map_err(|e| Error::Decode(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zats_roundtrip() {
        assert_eq!(zats(1.5), 150_000_000);
        assert_eq!(zec_str(149_990_000), "1.49990000");
        assert_eq!(zats(0.1), 10_000_000);
    }

    #[test]
    fn zebra_synced_gate() {
        let behind = ZebraChainInfo {
            blocks: 338_400,
            verificationprogress: Some(0.0988),
        };
        assert!(!behind.is_synced(0.9999));

        let at_tip = ZebraChainInfo {
            blocks: 3_425_497,
            verificationprogress: Some(1.0),
        };
        assert!(at_tip.is_synced(0.9999));

        // regtest-style: progress forced to 1.0 on a private chain.
        let regtest = ZebraChainInfo {
            blocks: 279,
            verificationprogress: Some(1.0),
        };
        assert!(regtest.is_synced(0.9999));

        // Missing progress must not brick an otherwise-answering backend.
        let no_progress = ZebraChainInfo {
            blocks: 10,
            verificationprogress: None,
        };
        assert!(no_progress.is_synced(0.9999));

        let nan = ZebraChainInfo {
            blocks: 10,
            verificationprogress: Some(f64::NAN),
        };
        assert!(nan.is_synced(0.9999));
    }
}
