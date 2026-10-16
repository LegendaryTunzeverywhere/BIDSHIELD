//! Per-IP token-bucket rate limiting + auth-failure lockout.
//! In-memory, no external deps — a single process serves one API instance.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Signature verification and nonce issuing: CPU-heavy (secp256k1).
    Auth,
    /// State-changing endpoints: create, bid, close, settle.
    Write,
    /// Everything else (reads, static).
    Read,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub auth_per_min: u32,
    pub write_per_min: u32,
    pub read_per_min: u32,
    /// Failed auth attempts allowed per window before lockout.
    pub auth_fail_max: u32,
    pub auth_lockout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            auth_per_min: 20,
            write_per_min: 30,
            read_per_min: 240,
            auth_fail_max: 10,
            auth_lockout: Duration::from_secs(60),
        }
    }
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<(String, u8), Bucket>>,
    failures: Mutex<HashMap<String, (u32, Instant)>>,
    limits: std::sync::OnceLock<Limits>,
}

impl RateLimiter {
    pub fn with_limits(limits: Limits) -> Self {
        let limiter = Self::default();
        let _ = limiter.limits.set(limits);
        limiter
    }

    fn limits(&self) -> Limits {
        *self.limits.get().unwrap_or(&Limits::default())
    }

    fn per_min(&self, class: Class) -> u32 {
        let l = self.limits();
        match class {
            Class::Auth => l.auth_per_min,
            Class::Write => l.write_per_min,
            Class::Read => l.read_per_min,
        }
    }

    /// Returns true when the request may proceed.
    pub fn check(&self, ip: &str, class: Class) -> bool {
        self.check_at(ip, class, Instant::now())
    }

    fn check_at(&self, ip: &str, class: Class, now: Instant) -> bool {
        let per_min = self.per_min(class).max(1) as f64;
        let capacity = per_min; // burst = one minute of budget
        let refill_per_sec = per_min / 60.0;
        let mut map = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        // Opportunistic cleanup so the map cannot grow without bound.
        if map.len() > 10_000 {
            let ttl = Duration::from_secs(600);
            map.retain(|_, b| now.duration_since(b.last) < ttl);
        }
        let key = (ip.to_string(), class as u8);
        let bucket = map.entry(key).or_insert(Bucket {
            tokens: capacity,
            last: now,
        });
        let elapsed = now.duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * refill_per_sec).min(capacity);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Record a failed auth verification from `ip`. Locks the IP out once
    /// `auth_fail_max` failures occur inside the lockout window.
    pub fn note_auth_failure(&self, ip: &str) {
        self.note_auth_failure_at(ip, Instant::now());
    }

    fn note_auth_failure_at(&self, ip: &str, now: Instant) {
        let limits = self.limits();
        let mut map = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 10_000 {
            let lock = limits.auth_lockout;
            map.retain(|_, (_, t)| now.duration_since(*t) < lock * 2);
        }
        let entry = map.entry(ip.to_string()).or_insert((0, now));
        if now.duration_since(entry.1) > limits.auth_lockout {
            *entry = (1, now);
        } else {
            entry.0 += 1;
        }
    }

    /// True when this IP has burned too many auth attempts recently.
    pub fn auth_locked(&self, ip: &str) -> bool {
        self.auth_locked_at(ip, Instant::now())
    }

    fn auth_locked_at(&self, ip: &str, now: Instant) -> bool {
        let limits = self.limits();
        let map = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(ip) {
            Some((count, since)) if *count >= limits.auth_fail_max => {
                now.duration_since(*since) < limits.auth_lockout
            }
            _ => false,
        }
    }

    pub fn clear_auth_failures(&self, ip: &str) {
        self.failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(ip);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter() -> RateLimiter {
        RateLimiter::with_limits(Limits {
            auth_per_min: 3,
            write_per_min: 5,
            read_per_min: 100,
            auth_fail_max: 3,
            auth_lockout: Duration::from_secs(60),
        })
    }

    #[test]
    fn burst_then_reject_then_refill() {
        let rl = limiter();
        let t0 = Instant::now();
        for _ in 0..5 {
            assert!(rl.check_at("1.2.3.4", Class::Write, t0));
        }
        assert!(!rl.check_at("1.2.3.4", Class::Write, t0));
        // 1 second refills 5/60 tokens — not enough for one request.
        assert!(!rl.check_at("1.2.3.4", Class::Write, t0 + Duration::from_secs(1)));
        // 20 seconds refills ~1.67 tokens.
        assert!(rl.check_at("1.2.3.4", Class::Write, t0 + Duration::from_secs(20)));
    }

    #[test]
    fn classes_are_independent() {
        let rl = limiter();
        let t0 = Instant::now();
        for _ in 0..5 {
            assert!(rl.check_at("1.2.3.4", Class::Write, t0));
        }
        assert!(!rl.check_at("1.2.3.4", Class::Write, t0));
        assert!(rl.check_at("1.2.3.4", Class::Read, t0));
        assert!(rl.check_at("5.6.7.8", Class::Write, t0));
    }

    #[test]
    fn auth_failure_lockout() {
        let rl = limiter();
        let t0 = Instant::now();
        assert!(!rl.auth_locked_at("9.9.9.9", t0));
        rl.note_auth_failure_at("9.9.9.9", t0);
        rl.note_auth_failure_at("9.9.9.9", t0);
        assert!(!rl.auth_locked_at("9.9.9.9", t0)); // 2 < 3
        rl.note_auth_failure_at("9.9.9.9", t0);
        assert!(rl.auth_locked_at("9.9.9.9", t0));
        // Window expiry unlocks.
        assert!(!rl.auth_locked_at("9.9.9.9", t0 + Duration::from_secs(61)));
        // Another IP is unaffected.
        assert!(!rl.auth_locked_at("8.8.8.8", t0));
    }
}
