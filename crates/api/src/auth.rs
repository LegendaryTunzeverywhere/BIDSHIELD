use std::collections::HashMap;

use axum_extra::extract::cookie::{Cookie, SameSite};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub const SESSION_COOKIE: &str = "bidshield_session";
const NONCE_TTL_SECS: i64 = 300;
const MAX_NONCE_ATTEMPTS: u8 = 10;
const MAX_LIVE_NONCES: usize = 1000;

pub struct NonceEntry {
    pub message: String,
    pub expires_at: i64,
    pub attempts: u8,
}

#[derive(Default)]
pub struct AuthNonces {
    map: std::sync::Mutex<HashMap<String, NonceEntry>>,
}

impl AuthNonces {
    pub fn issue(&self, now: i64) -> (String, String, i64) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, e| e.expires_at > now);
        if map.len() >= MAX_LIVE_NONCES {
            let oldest = map
                .iter()
                .min_by_key(|(_, e)| e.expires_at)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                map.remove(&k);
            }
        }
        let mut raw = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut raw);
        let nonce: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        let expires_at = now + NONCE_TTL_SECS;
        let message = format!(
            "Bidshield sign-in\nNonce: {nonce}\nIssued-At: {now}\nExpires-At: {expires_at}"
        );
        map.insert(
            nonce.clone(),
            NonceEntry {
                message: message.clone(),
                expires_at,
                attempts: 0,
            },
        );
        (nonce, message, expires_at)
    }

    /// Consume a nonce: marks one verification attempt. Returns the exact
    /// message the client was asked to sign, or None when the nonce is
    /// unknown, expired, or burned after too many failed attempts.
    pub fn consume(&self, nonce: &str, now: i64) -> Option<String> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get_mut(nonce)?;
        if entry.expires_at <= now {
            map.remove(nonce);
            return None;
        }
        entry.attempts += 1;
        if entry.attempts > MAX_NONCE_ATTEMPTS {
            map.remove(nonce);
            return None;
        }
        Some(entry.message.clone())
    }

    pub fn burn(&self, nonce: &str) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(nonce);
    }
}

fn compact_size(n: usize) -> Vec<u8> {
    if n < 253 {
        vec![n as u8]
    } else if n <= u16::MAX as usize {
        let mut v = vec![0xfd];
        v.extend_from_slice(&(n as u16).to_le_bytes());
        v
    } else if n <= u32::MAX as usize {
        let mut v = vec![0xfe];
        v.extend_from_slice(&(n as u32).to_le_bytes());
        v
    } else {
        let mut v = vec![0xff];
        v.extend_from_slice(&(n as u64).to_le_bytes());
        v
    }
}

/// Bitcoin/Zcash `Zcash Signed Message:` payload: compact-size-prefixed
/// prefix + message, the standard Zcash message-signing wire format.
pub fn zcash_message_payload(message: &str) -> Vec<u8> {
    const PREFIX: &str = "Zcash Signed Message:\n";
    let prefix = PREFIX.as_bytes();
    let msg = message.as_bytes();
    let mut out = Vec::with_capacity(prefix.len() + msg.len() + 10);
    out.extend_from_slice(&compact_size(prefix.len()));
    out.extend_from_slice(prefix);
    out.extend_from_slice(&compact_size(msg.len()));
    out.extend_from_slice(msg);
    out
}

pub fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    Sha256::digest(first).into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim().trim_start_matches("0x");
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Verify a Zcash Signed Message signature (65-byte recoverable secp256k1,
/// header 27-34) over the Zcash Signed Message payload.
/// Returns the compressed public key (hex) of the signer.
pub fn verify_zcash_signature(message: &str, signature_hex: &str) -> Result<String, String> {
    let bytes = hex_decode(signature_hex).ok_or("signature must be hex")?;
    if bytes.len() != 65 {
        return Err(format!("signature must be 65 bytes, got {}", bytes.len()));
    }
    let header = bytes[0];
    if !(27..=34).contains(&header) {
        return Err(format!("invalid signature header byte {header}"));
    }
    let compressed = header >= 31;
    let recid_byte = header - if compressed { 31 } else { 27 };
    let recid = RecoveryId::from_byte(recid_byte).ok_or("invalid recovery id")?;
    let sig = Signature::from_slice(&bytes[1..65]).map_err(|e| format!("bad signature: {e}"))?;

    let payload = zcash_message_payload(message);
    let prehash = double_sha256(&payload);
    let recovered =
        VerifyingKey::recover_from_prehash(&prehash, &sig, recid).map_err(|e| format!("{e}"))?;
    Ok(hex_encode(recovered.to_encoded_point(true).as_bytes()))
}

pub fn new_session_token() -> (String, String) {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, raw);
    let hash = hex_encode(&Sha256::digest(token.as_bytes()));
    (token, hash)
}

pub fn hash_token(token: &str) -> String {
    hex_encode(&Sha256::digest(token.as_bytes()))
}

pub fn session_cookie(token: &str, max_age_secs: i64, secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token.to_string()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(secure)
        .max_age(time::Duration::seconds(max_age_secs))
        .build()
}

pub fn clear_cookie(secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(secure)
        .max_age(time::Duration::seconds(0))
        .build()
}

pub fn short_key(pubkey_hex: &str) -> String {
    if pubkey_hex.len() > 16 {
        format!(
            "{}…{}",
            &pubkey_hex[..8],
            &pubkey_hex[pubkey_hex.len() - 6..]
        )
    } else {
        pubkey_hex.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    #[test]
    fn roundtrip_sign_and_recover() {
        let signing_key = SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
        let message = "Bidshield sign-in\nNonce: abc\nIssued-At: 1\nExpires-At: 2";
        let payload = zcash_message_payload(message);
        let prehash = double_sha256(&payload);
        let (sig, recid) = signing_key.sign_prehash_recoverable(&prehash).unwrap();

        let mut bytes = Vec::with_capacity(65);
        bytes.push(31 + recid.to_byte()); // compressed header
        bytes.extend_from_slice(&sig.to_bytes());
        let sig_hex = hex_encode(&bytes);

        let recovered = verify_zcash_signature(message, &sig_hex).unwrap();
        let expected = hex_encode(
            signing_key
                .verifying_key()
                .to_encoded_point(true)
                .as_bytes(),
        );
        assert_eq!(recovered, expected);
    }

    #[test]
    fn payload_matches_reference_vector() {
        // compact_size(22) || "Zcash Signed Message:\n" || compact_size(3) || "abc"
        let p = zcash_message_payload("abc");
        assert_eq!(p[0], 22);
        assert_eq!(&p[1..23], b"Zcash Signed Message:\n");
        assert_eq!(p[23], 3);
        assert_eq!(&p[24..], b"abc");
    }

    #[test]
    fn nonce_single_use_and_expiry() {
        let nonces = AuthNonces::default();
        let (nonce, message, _) = nonces.issue(1000);
        assert_eq!(nonces.consume(&nonce, 1001).unwrap(), message);
        assert!(nonces.consume(&nonce, 1002).is_some()); // attempts++ path
        for _ in 0..9 {
            nonces.consume(&nonce, 1003);
        }
        assert!(nonces.consume(&nonce, 1004).is_none()); // burned
        let (n2, _, exp) = nonces.issue(1000);
        assert!(nonces.consume(&n2, exp).is_none()); // expired
    }
}
