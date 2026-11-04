//! Pure renewal policy and certificate lifecycle state.
//!
//! This module deliberately contains no I/O, CA manager, or TLS listener. The
//! listener owns the clock and calls these helpers so the boundary rules stay
//! unit-testable without sleeping for days.

use std::time::Duration;

/// Renew a leaf once less than this much validity remains.
pub(crate) const DEFAULT_RENEW_BEFORE: Duration = Duration::from_secs(7 * 86_400);
/// How often the monitor checks the clock and the active CA generation.
pub(crate) const DEFAULT_RENEWAL_TICK: Duration = Duration::from_secs(3_600);
/// Retry delay after an issuance/build failure while the old leaf is valid.
pub(crate) const DEFAULT_RETRY_AFTER_FAILURE: Duration = Duration::from_secs(300);
/// How long a replaced certificate stays available for explicit rollback.
pub(crate) const DEFAULT_ROLLBACK_GRACE: Duration = Duration::from_secs(3_600);
/// The CA refuses to issue a 30-day leaf with less than this much issuer time.
const MIN_ISSUER_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TlsRenewalPolicy {
    pub renew_before: Duration,
    pub tick: Duration,
    pub retry_after_failure: Duration,
    pub rollback_grace: Duration,
}

impl Default for TlsRenewalPolicy {
    fn default() -> Self {
        Self {
            renew_before: DEFAULT_RENEW_BEFORE,
            tick: DEFAULT_RENEWAL_TICK,
            retry_after_failure: DEFAULT_RETRY_AFTER_FAILURE,
            rollback_grace: DEFAULT_ROLLBACK_GRACE,
        }
    }
}

/// Stable, non-secret lifecycle state exposed to callers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsCertificateState {
    Serving,
    Renewing,
    RenewalFailed {
        code: &'static str,
    },
    IssuerRotationRequired {
        code: &'static str,
    },
    RootChangePending {
        active_root_fingerprint_sha256: String,
    },
    Expired,
    #[allow(dead_code)] // Reserved for a future explicit shutdown snapshot.
    Stopped,
}

impl TlsCertificateState {
    /// Stable code for command/UI snapshots. Never contains certificate data.
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Serving => "serving",
            Self::Renewing => "renewing",
            Self::RenewalFailed { .. } => "renewal-failed",
            Self::IssuerRotationRequired { .. } => "issuer-rotation-required",
            Self::RootChangePending { .. } => "root-change-pending",
            Self::Expired => "expired",
            Self::Stopped => "stopped",
        }
    }
}

/// Current/previous serving certificate metadata. No paths or key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsCertificateSnapshot {
    pub state: TlsCertificateState,
    pub leaf_fingerprint_sha256: String,
    pub leaf_not_after: i64,
    pub root_fingerprint_sha256: String,
    pub root_generation: u32,
    pub intermediate_generation: u32,
    pub last_error_code: Option<&'static str>,
    pub previous_leaf_fingerprint_sha256: Option<String>,
    pub previous_not_after: Option<i64>,
}

/// A leaf is due for renewal before its absolute `notAfter`.
pub(crate) fn renewal_due(now: i64, not_after: i64, before: Duration) -> bool {
    not_after.saturating_sub(now) < before.as_secs() as i64
}

/// Expiry is inclusive: at `notAfter` the certificate must no longer be served.
pub(crate) fn certificate_expired(now: i64, not_after: i64) -> bool {
    now >= not_after
}

/// The CA refuses issuance when either active issuer has less than 30 days.
pub(crate) fn issuer_rotation_required(
    root_days_remaining: i64,
    intermediate_days_remaining: i64,
) -> bool {
    root_days_remaining < MIN_ISSUER_DAYS || intermediate_days_remaining < MIN_ISSUER_DAYS
}

/// Rollback is only allowed across the same trust anchor, inside the grace
/// window, and before the previous leaf expires.
pub(crate) fn rollback_available(
    now: i64,
    previous_not_after: i64,
    previous_root_generation: u32,
    current_root_generation: u32,
    swapped_at: i64,
    grace: Duration,
) -> bool {
    previous_root_generation == current_root_generation
        && now < previous_not_after
        && now <= swapped_at.saturating_add(grace.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const DAY: i64 = 86_400;

    #[test]
    fn renewal_is_due_only_inside_the_seven_day_window() {
        let before = Duration::from_secs(7 * DAY as u64);
        assert!(!renewal_due(1_000, 1_000 + 7 * DAY, before));
        assert!(renewal_due(1_000, 1_000 + 7 * DAY - 1, before));
        assert!(renewal_due(1_000, 1_000, before));
    }

    #[test]
    fn expiry_is_inclusive_at_not_after() {
        assert!(!certificate_expired(1_000, 1_001));
        assert!(certificate_expired(1_000, 1_000));
        assert!(certificate_expired(1_001, 1_000));
    }

    #[test]
    fn issuer_rotation_is_required_below_thirty_days() {
        assert!(!issuer_rotation_required(30, 30));
        assert!(issuer_rotation_required(29, 30));
        assert!(issuer_rotation_required(30, 29));
        assert!(issuer_rotation_required(-1, 180));
    }

    #[test]
    fn rollback_requires_same_root_valid_window_and_grace() {
        let grace = Duration::from_secs(3_600);
        assert!(rollback_available(1_000, 2_000, 1, 1, 1_000, grace));
        assert!(!rollback_available(1_000, 2_000, 2, 1, 1_000, grace));
        assert!(!rollback_available(2_000, 2_000, 1, 1, 1_000, grace));
        assert!(!rollback_available(4_601, 10_000, 1, 1, 1_000, grace));
    }

    #[test]
    fn policy_defaults_match_the_frozen_values() {
        let policy = TlsRenewalPolicy::default();
        assert_eq!(policy.renew_before, Duration::from_secs(7 * DAY as u64));
        assert_eq!(policy.tick, Duration::from_secs(3_600));
        assert_eq!(policy.retry_after_failure, Duration::from_secs(300));
        assert_eq!(policy.rollback_grace, Duration::from_secs(3_600));
    }

    #[test]
    fn snapshot_carries_no_path_or_private_key_fields() {
        let snapshot = TlsCertificateSnapshot {
            state: TlsCertificateState::Serving,
            leaf_fingerprint_sha256: "AA".into(),
            leaf_not_after: 2_000,
            root_fingerprint_sha256: "BB".into(),
            root_generation: 1,
            intermediate_generation: 1,
            last_error_code: None,
            previous_leaf_fingerprint_sha256: None,
            previous_not_after: None,
        };
        let debug = format!("{snapshot:?}");
        assert!(debug.contains("Serving"));
        assert!(!debug.contains("PRIVATE KEY"));
        assert!(!debug.contains("ca_root"));
        assert!(!debug.contains("key.pem"));
    }
}
