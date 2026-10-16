use std::time::{Duration, Instant};

use zecd_client::ZecdClient;

use crate::routes::ApiError;

pub async fn wait_for_op(
    zecd: &ZecdClient,
    opid: &str,
    timeout_secs: u64,
) -> Result<String, ApiError> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        let entry = zecd
            .operation_status(opid)
            .await
            .map_err(|e| ApiError::Zecd(e.to_string()))?;
        if let Some(entry) = entry {
            let status = entry.status.unwrap_or_default();
            match status.as_str() {
                "success" => {
                    return entry.result.and_then(|r| r.txid).ok_or_else(|| {
                        ApiError::Internal("operation succeeded without txid".into())
                    });
                }
                "failed" | "invalid" | "rejected" => {
                    let msg = entry
                        .error
                        .and_then(|e| e.message)
                        .unwrap_or_else(|| format!("status {status}"));
                    return Err(ApiError::Zecd(format!("operation {opid}: {msg}")));
                }
                _ => {}
            }
        }
        if Instant::now() >= deadline {
            return Err(ApiError::Zecd(format!(
                "operation {opid} timed out after {timeout_secs}s"
            )));
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}
