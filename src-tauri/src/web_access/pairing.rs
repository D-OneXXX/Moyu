//! In-memory pairing window/claim state machine (D1a).
//!
//! Frozen contract: `docs/dev/W7_DATA_PAIRING_DESIGN_DRAFT.md` §4.1 and
//! `.superpowers/sdd/2026-11-01-w7-d1a-pairing-session/interfaces.md`.
//!
//! Invariants:
//! - A pairing window (`pair_` + 128-bit hex) lives [`PAIRING_TTL`]. Several
//!   `(pairingId, claimNonce)` claims may coexist in one window, but only one
//!   claim can ever be approved; approval closes the window and cancels the
//!   remaining claims.
//! - The plaintext claim secret is returned exactly once (in [`ClaimIssued`])
//!   and only `sha256(secret)` is stored. The digest is cleared after one
//!   terminal receipt read, on consumption, or when an approved claim misses
//!   its 5 s pickup deadline. A `(pairingId, claimNonce)` claim is never
//!   re-issued: duplicates always report `pairing-claimed`, even after the
//!   claim reached a terminal state.
//! - `deny` closes the whole window as well (the frozen contract invalidates
//!   the window for new claims). Design §6.3 reserves `pairing-claimed` for a
//!   duplicate `(pairingId, claimNonce)` only: new claim attempts on an
//!   approved or denied window report `pairing-not-found`, and only a window
//!   explicitly cancelled through [`PairingStore::cancel_window`] reports
//!   `pairing-cancelled`. Unknown or TTL-expired windows always report
//!   `pairing-not-found` and are never distinguished.
//! - This type never reserves a session slot. Task 3 reserves a slot, then
//!   calls [`PairingState::approve_locked`] with the reservation id while the
//!   pairing lock is held (pairing state first, session state second).
//! - Expired windows, terminal claims and rate-limit buckets are swept on
//!   every operation; terminal claims are retained for
//!   [`TERMINAL_RETENTION`] so one receipt read (or a `pairing-consumed`
//!   answer) stays possible.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use super::clock::Clock;
use super::secret::{
    constant_time_eq, is_valid_claim_nonce, random_b64, random_hex, sanitize_device_name,
    sha256_bytes,
};

/// Pairing window lifetime, counted on the monotonic clock.
pub(crate) const PAIRING_TTL: Duration = Duration::from_secs(120);
/// How long an approved claim may wait for its one-time pickup.
pub(crate) const PICKUP_TIMEOUT: Duration = Duration::from_secs(5);
/// How long terminal claim records are kept after reaching a terminal state.
pub(crate) const TERMINAL_RETENTION: Duration = Duration::from_secs(120);

const MAX_PENDING_PER_IP: usize = 3;
const MAX_CLAIMS_PER_MINUTE: usize = 10;
const MAX_GLOBAL_PENDING: usize = 20;
const CLAIM_RATE_WINDOW: Duration = Duration::from_secs(60);

const PAIRING_ID_PREFIX: &str = "pair_";
const CLAIM_ID_PREFIX: &str = "claim_";
const ID_RANDOM_BYTES: usize = 16;
const CLAIM_SECRET_BYTES: usize = 32;
const MIN_RETRY_AFTER: Duration = Duration::from_millis(1);

/// Claim lifecycle state exposed to the HTTP layer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ClaimState {
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled,
    Consumed,
}

impl ClaimState {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
            Self::Consumed => "consumed",
        }
    }
}

/// Read-only answer to a claim status poll.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ClaimStatus {
    pub state: ClaimState,
    pub terminal_receipt: bool,
}

/// Desktop-facing view of one claim awaiting approval. Identity material
/// (secret/hash/reservation id) is deliberately absent.
#[derive(Clone, Debug)]
pub(crate) struct PendingClaimView {
    pub claim_id: String,
    pub device_name: String,
    pub source_ip: Ipv4Addr,
    pub created_at: Instant,
    pub expires_at: Instant,
}

/// One-time claim issuance result. The secret is zeroized on drop and is
/// never re-issued for the same `(pairingId, claimNonce)`.
pub(crate) struct ClaimIssued {
    pub claim_id: String,
    pub claim_secret: Zeroizing<String>,
}

impl fmt::Debug for ClaimIssued {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaimIssued").finish_non_exhaustive()
    }
}

/// A freshly created pairing window. Only the desktop control plane (D1b)
/// hands the id to a QR code; it is never logged.
pub(crate) struct PairingWindow {
    pub id: String,
    pub expires_at: Instant,
}

impl fmt::Debug for PairingWindow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingWindow").finish_non_exhaustive()
    }
}

/// Successful low-level approval. The session slot reservation is owned by
/// the caller and only referenced by the claim until it is consumed.
pub(crate) struct Approval {
    pub claim_id: String,
}

impl fmt::Debug for Approval {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Approval").finish_non_exhaustive()
    }
}

/// Stable pairing error codes. Display text never contains ids or secrets.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PairingError {
    #[error("pairing not found")]
    NotFound,
    #[error("pairing already claimed")]
    Claimed,
    #[error("pairing rate limited")]
    RateLimited { retry_after: Duration },
    #[error("pairing expired")]
    Expired,
    #[error("pairing denied")]
    Denied,
    #[error("pairing cancelled")]
    Cancelled,
    #[error("claim already consumed")]
    Consumed,
    #[error("invalid parameter")]
    InvalidParameter,
}

impl PairingError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "pairing-not-found",
            Self::Claimed => "pairing-claimed",
            Self::RateLimited { .. } => "pairing-rate-limited",
            Self::Expired => "pairing-expired",
            Self::Denied => "pairing-denied",
            Self::Cancelled => "pairing-cancelled",
            Self::Consumed => "pairing-consumed",
            Self::InvalidParameter => "invalid-parameter",
        }
    }
}

/// Why a window stopped accepting new claims.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ClosedReason {
    Approved,
    Denied,
    Cancelled,
}

struct WindowEntry {
    expires_at: Instant,
    closed: Option<ClosedReason>,
    /// Every nonce ever issued in this window, retained for the window TTL so
    /// duplicates keep reporting `pairing-claimed` after their claim record is
    /// gone (terminal receipt read, consumption).
    issued_nonces: HashSet<String>,
}

struct ClaimEntry {
    pairing_id: String,
    /// Sanitized with [`sanitize_device_name`]; rendered by the D1b desktop UI.
    device_name: String,
    source_ip: Ipv4Addr,
    created_at: Instant,
    state: ClaimState,
    /// Window expiry: pending claims expire with their window.
    expires_at: Instant,
    pickup_deadline: Option<Instant>,
    secret_hash: Option<Zeroizing<[u8; 32]>>,
    terminal_receipt_pending: bool,
    terminal_at: Option<Instant>,
    reservation_id: Option<String>,
}

/// Pairing state guarded by a single mutex. Task 3 locks this state first and
/// the session state second, never the other way around.
#[derive(Default)]
pub(crate) struct PairingState {
    windows: HashMap<String, WindowEntry>,
    claims: HashMap<String, ClaimEntry>,
    claim_times: HashMap<Ipv4Addr, VecDeque<Instant>>,
}

impl PairingState {
    /// Expire windows/claims and prune terminal records and rate buckets.
    /// Idempotent and cheap; every store operation runs it before acting.
    pub(crate) fn purge_locked(&mut self, now: Instant) {
        // An approved claim that nobody picked up expires on its own deadline
        // and loses its secret: no terminal receipt is offered.
        for claim in self.claims.values_mut() {
            if claim.state == ClaimState::Approved
                && claim
                    .pickup_deadline
                    .is_some_and(|deadline| now >= deadline)
            {
                claim.state = ClaimState::Expired;
                claim.secret_hash = None;
                claim.terminal_receipt_pending = false;
                claim.terminal_at = Some(now);
                claim.pickup_deadline = None;
            }
        }

        // Pending claims expire with their window and keep the secret hash for
        // exactly one terminal receipt.
        let expired_windows: Vec<String> = self
            .windows
            .iter()
            .filter(|(_, window)| now >= window.expires_at)
            .map(|(id, _)| id.clone())
            .collect();
        for window_id in expired_windows {
            for claim in self.claims.values_mut() {
                if claim.pairing_id == window_id && claim.state == ClaimState::Pending {
                    claim.state = ClaimState::Expired;
                    claim.terminal_receipt_pending = claim.secret_hash.is_some();
                    claim.terminal_at = Some(now);
                }
            }
            self.windows.remove(&window_id);
        }

        // Terminal claims are retained briefly for receipts/consumed answers.
        self.claims.retain(|_, claim| {
            if !matches!(
                claim.state,
                ClaimState::Denied
                    | ClaimState::Cancelled
                    | ClaimState::Expired
                    | ClaimState::Consumed
            ) {
                return true;
            }
            claim
                .terminal_at
                .is_none_or(|at| now.saturating_duration_since(at) < TERMINAL_RETENTION)
        });

        self.prune_rate_buckets_locked(now);
    }

    /// Low-level approval used by Task 3 while both stores are locked. The
    /// caller has already reserved a session slot (if it wants one); this
    /// method only performs the claim/window transition. Like a new claim, a
    /// window closed by approval or denial reports `pairing-not-found`; only an
    /// explicit [`PairingStore::cancel_window`] reports `pairing-cancelled`.
    pub(crate) fn approve_locked(
        &mut self,
        claim_id: &str,
        now: Instant,
        reservation_id: Option<String>,
    ) -> Result<Approval, PairingError> {
        self.purge_locked(now);

        let (pairing_id, state) = match self.claims.get(claim_id) {
            Some(claim) => (claim.pairing_id.clone(), claim.state),
            None => return Err(PairingError::NotFound),
        };
        match state {
            ClaimState::Pending => {}
            ClaimState::Approved => return Err(PairingError::Claimed),
            ClaimState::Denied => return Err(PairingError::Denied),
            ClaimState::Expired => return Err(PairingError::Expired),
            ClaimState::Cancelled => return Err(PairingError::Cancelled),
            ClaimState::Consumed => return Err(PairingError::Consumed),
        }

        let (window_expires_at, closed) = match self.windows.get(&pairing_id) {
            Some(window) => (window.expires_at, window.closed),
            None => return Err(PairingError::NotFound),
        };
        if now >= window_expires_at {
            return Err(PairingError::Expired);
        }
        match closed {
            Some(ClosedReason::Approved | ClosedReason::Denied) => {
                return Err(PairingError::NotFound)
            }
            Some(ClosedReason::Cancelled) => return Err(PairingError::Cancelled),
            None => {}
        }

        let pickup_deadline = (now + PICKUP_TIMEOUT).min(window_expires_at);
        if let Some(window) = self.windows.get_mut(&pairing_id) {
            window.closed = Some(ClosedReason::Approved);
        }
        self.cancel_other_pending_locked(&pairing_id, claim_id, now);

        if let Some(claim) = self.claims.get_mut(claim_id) {
            claim.state = ClaimState::Approved;
            claim.pickup_deadline = Some(pickup_deadline);
            claim.reservation_id = reservation_id;
        }
        Ok(Approval {
            claim_id: claim_id.to_owned(),
        })
    }

    /// Verify that a claim may be consumed right now. On success the caller
    /// commits the reserved session token and then calls
    /// [`Self::mark_consumed_locked`] while still holding both locks.
    pub(crate) fn consume_precheck_locked(
        &mut self,
        claim_id: &str,
        claim_secret: &str,
        now: Instant,
    ) -> Result<(), PairingError> {
        self.purge_locked(now);

        let claim = match self.claims.get(claim_id) {
            Some(claim) => claim,
            None => return Err(PairingError::NotFound),
        };
        match claim.state {
            // A pending claim can never issue a token.
            ClaimState::Pending => Err(PairingError::NotFound),
            ClaimState::Approved => {
                if secret_matches(claim, claim_secret) {
                    Ok(())
                } else {
                    Err(PairingError::NotFound)
                }
            }
            ClaimState::Consumed => Err(PairingError::Consumed),
            ClaimState::Denied => {
                if secret_matches(claim, claim_secret) {
                    Err(PairingError::Denied)
                } else {
                    Err(PairingError::NotFound)
                }
            }
            ClaimState::Cancelled => {
                if secret_matches(claim, claim_secret) {
                    Err(PairingError::Cancelled)
                } else {
                    Err(PairingError::NotFound)
                }
            }
            ClaimState::Expired => {
                // Pickup-timeout expiries have no hash and offer no receipt;
                // window-expiry expiries require the secret before disclosing.
                if claim.terminal_receipt_pending && !secret_matches(claim, claim_secret) {
                    return Err(PairingError::NotFound);
                }
                Err(PairingError::Expired)
            }
        }
    }

    /// Mark a claim consumed after the session token was committed. Clears the
    /// secret hash and the reservation reference; later status/consume answers
    /// report `pairing-consumed` without a token.
    pub(crate) fn mark_consumed_locked(&mut self, claim_id: &str, now: Instant) {
        if let Some(claim) = self.claims.get_mut(claim_id) {
            if claim.state != ClaimState::Approved {
                return;
            }
            claim.state = ClaimState::Consumed;
            claim.secret_hash = None;
            claim.reservation_id = None;
            claim.terminal_receipt_pending = false;
            claim.terminal_at = Some(now);
            claim.pickup_deadline = None;
        }
    }

    /// Reservation id still attached to a claim, if any.
    pub(crate) fn reservation_for(&self, claim_id: &str) -> Option<String> {
        self.claims
            .get(claim_id)
            .and_then(|claim| claim.reservation_id.clone())
    }

    /// Forget the session reservation a claim still references. The caller has
    /// already released that slot on the session side; only the id is cleared,
    /// so the claim state, its secret digest and its timestamps are untouched
    /// and a terminal receipt (or a `pairing-consumed` answer) stays possible.
    pub(crate) fn clear_reservation_locked(&mut self, claim_id: &str) {
        if let Some(claim) = self.claims.get_mut(claim_id) {
            claim.reservation_id = None;
        }
    }

    /// Read-only lifecycle state of a claim. Task 3 reads it before touching
    /// the session store so an unapprovable claim reports its own state
    /// instead of `device-limit`. It exposes no secret, digest, device name or
    /// reservation id, and never mutates anything.
    pub(crate) fn claim_state_locked(&self, claim_id: &str) -> Option<ClaimState> {
        self.claims.get(claim_id).map(|claim| claim.state)
    }

    /// Sanitized device name captured when the claim was issued. Task 3 reads
    /// this before reserving a session slot and while the pairing lock is
    /// held; it never exposes the claim secret or its digest.
    pub(crate) fn claim_device_name_locked(&self, claim_id: &str) -> Option<String> {
        self.claims
            .get(claim_id)
            .map(|claim| claim.device_name.clone())
    }

    fn deny_locked(&mut self, claim_id: &str, now: Instant) -> Result<(), PairingError> {
        let (pairing_id, state) = match self.claims.get(claim_id) {
            Some(claim) => (claim.pairing_id.clone(), claim.state),
            None => return Err(PairingError::NotFound),
        };
        match state {
            // Double-click on the desktop is not an error.
            ClaimState::Denied => return Ok(()),
            ClaimState::Pending => {}
            ClaimState::Approved => return Err(PairingError::Claimed),
            ClaimState::Expired => return Err(PairingError::Expired),
            ClaimState::Cancelled => return Err(PairingError::Cancelled),
            ClaimState::Consumed => return Err(PairingError::Consumed),
        }

        if let Some(window) = self.windows.get_mut(&pairing_id) {
            if window.closed.is_none() {
                window.closed = Some(ClosedReason::Denied);
            }
        }
        self.cancel_other_pending_locked(&pairing_id, claim_id, now);

        if let Some(claim) = self.claims.get_mut(claim_id) {
            claim.state = ClaimState::Denied;
            claim.terminal_receipt_pending = claim.secret_hash.is_some();
            claim.terminal_at = Some(now);
        }
        Ok(())
    }

    fn cancel_other_pending_locked(&mut self, window_id: &str, except: &str, now: Instant) {
        let others: Vec<String> = self
            .claims
            .iter()
            .filter(|(id, claim)| {
                claim.pairing_id == window_id
                    && claim.state == ClaimState::Pending
                    && id.as_str() != except
            })
            .map(|(id, _)| id.clone())
            .collect();
        for claim_id in others {
            if let Some(claim) = self.claims.get_mut(&claim_id) {
                claim.state = ClaimState::Cancelled;
                claim.terminal_receipt_pending = claim.secret_hash.is_some();
                claim.terminal_at = Some(now);
            }
        }
    }

    fn cancel_all_locked(&mut self, now: Instant) -> Vec<String> {
        let active: Vec<String> = self
            .claims
            .iter()
            .filter(|(_, claim)| matches!(claim.state, ClaimState::Pending | ClaimState::Approved))
            .map(|(id, _)| id.clone())
            .collect();

        let mut reservations = Vec::new();
        for claim_id in active {
            if let Some(claim) = self.claims.get_mut(&claim_id) {
                if let Some(reservation_id) = claim.reservation_id.take() {
                    reservations.push(reservation_id);
                }
                claim.state = ClaimState::Cancelled;
                claim.terminal_receipt_pending = claim.secret_hash.is_some();
                claim.terminal_at = Some(now);
                claim.pickup_deadline = None;
            }
        }
        for window in self.windows.values_mut() {
            // An explicit cancel wins over an earlier approval/denial: every
            // window now reports `pairing-cancelled` to new claim attempts.
            window.closed = Some(ClosedReason::Cancelled);
        }
        reservations
    }

    fn check_rate_limits_locked(
        &mut self,
        source_ip: Ipv4Addr,
        now: Instant,
    ) -> Result<(), PairingError> {
        let pending_for_ip = self
            .claims
            .values()
            .filter(|claim| claim.state == ClaimState::Pending && claim.source_ip == source_ip)
            .count();
        if pending_for_ip >= MAX_PENDING_PER_IP {
            return Err(PairingError::RateLimited {
                retry_after: self.pending_retry_after(now, Some(source_ip)),
            });
        }

        if let Some(times) = self.claim_times.get(&source_ip) {
            if times.len() >= MAX_CLAIMS_PER_MINUTE {
                let oldest = times.front().copied().unwrap_or(now);
                let retry_after = (oldest + CLAIM_RATE_WINDOW)
                    .saturating_duration_since(now)
                    .max(MIN_RETRY_AFTER);
                return Err(PairingError::RateLimited { retry_after });
            }
        }

        let global_pending = self
            .claims
            .values()
            .filter(|claim| claim.state == ClaimState::Pending)
            .count();
        if global_pending >= MAX_GLOBAL_PENDING {
            return Err(PairingError::RateLimited {
                retry_after: self.pending_retry_after(now, None),
            });
        }
        Ok(())
    }

    fn pending_retry_after(&self, now: Instant, source_ip: Option<Ipv4Addr>) -> Duration {
        self.claims
            .values()
            .filter(|claim| {
                claim.state == ClaimState::Pending
                    && source_ip.is_none_or(|ip| claim.source_ip == ip)
            })
            .map(|claim| claim.expires_at.saturating_duration_since(now))
            .min()
            .unwrap_or(CLAIM_RATE_WINDOW)
            .max(MIN_RETRY_AFTER)
    }

    fn prune_rate_buckets_locked(&mut self, now: Instant) {
        self.claim_times.retain(|_, times| {
            times.retain(|at| now.saturating_duration_since(*at) < CLAIM_RATE_WINDOW);
            !times.is_empty()
        });
    }

    fn fresh_claim_id(&self) -> String {
        loop {
            let candidate = format!("{CLAIM_ID_PREFIX}{}", random_hex(ID_RANDOM_BYTES));
            if !self.claims.contains_key(&candidate) {
                return candidate;
            }
        }
    }
}

impl fmt::Debug for PairingState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let pending = self
            .claims
            .values()
            .filter(|claim| claim.state == ClaimState::Pending)
            .count();
        f.debug_struct("PairingState")
            .field("windows", &self.windows.len())
            .field("claims", &self.claims.len())
            .field("pending", &pending)
            .finish()
    }
}

/// Thread-safe pairing store. All public wrappers recover from a poisoned
/// mutex so a panic in one request never wedges pairing.
pub(crate) struct PairingStore {
    inner: Mutex<PairingState>,
    clock: Arc<dyn Clock>,
}

impl PairingStore {
    pub(crate) fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            inner: Mutex::new(PairingState::default()),
            clock,
        }
    }

    /// Create a pairing window. Only the desktop control plane calls this;
    /// starting the service itself never creates one.
    pub(crate) fn start_window(&self) -> PairingWindow {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);

        let expires_at = now + PAIRING_TTL;
        let id = loop {
            let candidate = format!("{PAIRING_ID_PREFIX}{}", random_hex(ID_RANDOM_BYTES));
            if !state.windows.contains_key(&candidate) {
                break candidate;
            }
        };
        state.windows.insert(
            id.clone(),
            WindowEntry {
                expires_at,
                closed: None,
                issued_nonces: HashSet::new(),
            },
        );
        PairingWindow { id, expires_at }
    }

    pub(crate) fn claim(
        &self,
        pairing_id: &str,
        device_name: &str,
        claim_nonce: &str,
        source_ip: Ipv4Addr,
    ) -> Result<ClaimIssued, PairingError> {
        if !is_valid_claim_nonce(claim_nonce) {
            return Err(PairingError::InvalidParameter);
        }

        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);

        let (duplicate, closed, expires_at) = match state.windows.get(pairing_id) {
            Some(window) => (
                window.issued_nonces.contains(claim_nonce),
                window.closed,
                window.expires_at,
            ),
            None => return Err(PairingError::NotFound),
        };
        // Idempotency first: the same (pairingId, nonce) is always
        // `pairing-claimed`, even after the claim reached a terminal state.
        if duplicate {
            return Err(PairingError::Claimed);
        }
        // An approved or denied window is indistinguishable from a missing one;
        // only an explicit cancel of the whole window reports `pairing-cancelled`.
        if let Some(reason) = closed {
            return Err(match reason {
                ClosedReason::Approved | ClosedReason::Denied => PairingError::NotFound,
                ClosedReason::Cancelled => PairingError::Cancelled,
            });
        }
        state.check_rate_limits_locked(source_ip, now)?;

        let claim_id = state.fresh_claim_id();
        let claim_secret = random_b64(CLAIM_SECRET_BYTES);
        let secret_hash = Zeroizing::new(sha256_bytes(claim_secret.as_str()));
        let claim = ClaimEntry {
            pairing_id: pairing_id.to_owned(),
            device_name: sanitize_device_name(device_name),
            source_ip,
            created_at: now,
            state: ClaimState::Pending,
            expires_at,
            pickup_deadline: None,
            secret_hash: Some(secret_hash),
            terminal_receipt_pending: false,
            terminal_at: None,
            reservation_id: None,
        };
        state.claims.insert(claim_id.clone(), claim);
        if let Some(window) = state.windows.get_mut(pairing_id) {
            window.issued_nonces.insert(claim_nonce.to_owned());
        }
        state
            .claim_times
            .entry(source_ip)
            .or_default()
            .push_back(now);

        Ok(ClaimIssued {
            claim_id,
            claim_secret,
        })
    }

    pub(crate) fn status(
        &self,
        claim_id: &str,
        claim_secret: &str,
    ) -> Result<ClaimStatus, PairingError> {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);

        let (status, remove) = {
            let claim = match state.claims.get(claim_id) {
                Some(claim) => claim,
                None => return Err(PairingError::NotFound),
            };
            match claim.state {
                ClaimState::Consumed => return Err(PairingError::Consumed),
                ClaimState::Pending | ClaimState::Approved => {
                    if !secret_matches(claim, claim_secret) {
                        return Err(PairingError::NotFound);
                    }
                    (
                        ClaimStatus {
                            state: claim.state,
                            terminal_receipt: false,
                        },
                        false,
                    )
                }
                ClaimState::Denied | ClaimState::Cancelled => {
                    if !claim.terminal_receipt_pending || !secret_matches(claim, claim_secret) {
                        return Err(PairingError::NotFound);
                    }
                    (
                        ClaimStatus {
                            state: claim.state,
                            terminal_receipt: true,
                        },
                        true,
                    )
                }
                ClaimState::Expired => {
                    // Pickup-timeout expiries never offer a receipt.
                    if !claim.terminal_receipt_pending {
                        return Err(PairingError::Expired);
                    }
                    if !secret_matches(claim, claim_secret) {
                        return Err(PairingError::NotFound);
                    }
                    (
                        ClaimStatus {
                            state: ClaimState::Expired,
                            terminal_receipt: true,
                        },
                        true,
                    )
                }
            }
        };
        if remove {
            state.claims.remove(claim_id);
        }
        Ok(status)
    }

    /// Low-level approval without a session reservation. Task 3 uses
    /// [`PairingState::approve_locked`] directly while holding both locks.
    pub(crate) fn approve(&self, claim_id: &str) -> Result<Approval, PairingError> {
        let now = self.clock.now();
        let mut state = self.lock();
        state.approve_locked(claim_id, now, None)
    }

    pub(crate) fn deny(&self, claim_id: &str) -> Result<(), PairingError> {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);
        state.deny_locked(claim_id, now)
    }

    /// Cancel every active/approved claim and close every window. Returns the
    /// session reservation ids the caller must release.
    pub(crate) fn cancel_window(&self) -> Vec<String> {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);
        state.cancel_all_locked(now)
    }

    /// Expiry of a still-open pairing window, or `None` when it is unknown,
    /// expired, or closed by approval/denial/cancel. Used by the desktop UI to
    /// drop a stale QR code after a reload.
    pub(crate) fn window_expiry(&self, pairing_id: &str) -> Option<Instant> {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);
        state
            .windows
            .get(pairing_id)
            .filter(|window| window.closed.is_none())
            .map(|window| window.expires_at)
    }

    /// One snapshot of every claim still awaiting approval, oldest first.
    /// Contains no secret, hash, or reservation id.
    pub(crate) fn pending_claims(&self) -> Vec<PendingClaimView> {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);
        let mut views = state
            .claims
            .iter()
            .filter(|(_, claim)| claim.state == ClaimState::Pending)
            .map(|(claim_id, claim)| PendingClaimView {
                claim_id: claim_id.clone(),
                device_name: claim.device_name.clone(),
                source_ip: claim.source_ip,
                created_at: claim.created_at,
                expires_at: claim.expires_at,
            })
            .collect::<Vec<_>>();
        views.sort_by_key(|view| view.created_at);
        views
    }

    /// Number of claims still awaiting approval. Cheap status-card count.
    pub(crate) fn pending_count(&self) -> usize {
        self.pending_claims().len()
    }

    /// Reservation ids currently attached to active claims, without changing
    /// state. Used by the Task 3 `stop_all` path before clearing stores.
    pub(crate) fn cancellation_reservations(&self) -> Vec<String> {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);
        state
            .claims
            .values()
            .filter(|claim| matches!(claim.state, ClaimState::Pending | ClaimState::Approved))
            .filter_map(|claim| claim.reservation_id.clone())
            .collect()
    }

    pub(crate) fn reservation_for(&self, claim_id: &str) -> Option<String> {
        self.lock().reservation_for(claim_id)
    }

    /// Delegating convenience wrapper for [`PairingState::claim_device_name_locked`].
    /// Task 3 normally calls the state method while already holding `lock()`.
    pub(crate) fn claim_device_name_locked(&self, claim_id: &str) -> Option<String> {
        self.lock().claim_device_name_locked(claim_id)
    }

    /// Poison-recovering lock helper shared with Task 3 (pairing lock first).
    pub(crate) fn lock(&self) -> MutexGuard<'_, PairingState> {
        self.inner.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub(crate) fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }
}

impl fmt::Debug for PairingStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = self.lock();
        let pending = state
            .claims
            .values()
            .filter(|claim| claim.state == ClaimState::Pending)
            .count();
        f.debug_struct("PairingStore")
            .field("windows", &state.windows.len())
            .field("claims", &state.claims.len())
            .field("pending", &pending)
            .finish()
    }
}

fn secret_matches(claim: &ClaimEntry, candidate: &str) -> bool {
    let stored = match claim.secret_hash.as_ref() {
        Some(hash) => hash,
        None => return false,
    };
    let digest = Zeroizing::new(sha256_bytes(candidate));
    constant_time_eq(&digest[..], &stored[..])
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    use super::*;
    use crate::web_access::clock::test_support::FakeClock;

    fn test_store() -> (PairingStore, Arc<FakeClock>) {
        let clock = FakeClock::shared();
        let store = PairingStore::new(clock.clone());
        (store, clock)
    }

    fn ip(last: u8) -> Ipv4Addr {
        Ipv4Addr::new(192, 168, 1, last)
    }

    fn nonce(seed: u8) -> String {
        URL_SAFE_NO_PAD.encode([seed; 16])
    }

    fn issue(store: &PairingStore, window: &PairingWindow, seed: u8, last_ip: u8) -> ClaimIssued {
        store
            .claim(&window.id, "Pixel 8", &nonce(seed), ip(last_ip))
            .expect("claim should be issued")
    }

    #[test]
    fn claim_secret_is_256_bit_and_only_hash_is_stored() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        assert!(window.id.starts_with("pair_"));
        assert_eq!(window.id.len(), "pair_".len() + 32);
        assert!(window.id[5..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert!(window.expires_at > store.clock().now());

        let issued = issue(&store, &window, 1, 20);
        assert!(issued.claim_id.starts_with("claim_"));
        assert_eq!(issued.claim_id.len(), "claim_".len() + 32);
        assert_eq!(issued.claim_secret.len(), 43);
        assert!(!issued.claim_secret.contains('='));
        assert!(issued
            .claim_secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));

        let stored = {
            let state = store.lock();
            let claim = state.claims.get(&issued.claim_id).expect("claim exists");
            assert_eq!(claim.device_name, "Pixel 8");
            claim
                .secret_hash
                .as_ref()
                .map(|hash| hash.to_vec())
                .expect("only the hash is stored")
        };
        assert!(
            stored.as_slice()
                == crate::web_access::secret::sha256_bytes(issued.claim_secret.as_str()).as_slice()
        );

        let store_debug = format!("{store:?}");
        assert!(!store_debug.contains(issued.claim_secret.as_str()));
        assert!(!store_debug.contains(&issued.claim_id));
        assert!(!store_debug.contains(&window.id));
        assert!(!store_debug.contains("secret_hash"));

        let issued_debug = format!("{issued:?}");
        assert!(!issued_debug.contains(issued.claim_secret.as_str()));
        assert!(!issued_debug.contains(&issued.claim_id));

        let window_debug = format!("{window:?}");
        assert!(!window_debug.contains(&window.id));
    }

    #[test]
    fn claim_device_name_accessor_returns_only_the_sanitized_name() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        let issued = store
            .claim(&window.id, "  Pixel\u{0} 8\u{200b}  ", &nonce(1), ip(20))
            .expect("claim should be issued");

        {
            let state = store.lock();
            assert_eq!(
                state.claim_device_name_locked(&issued.claim_id).as_deref(),
                Some("Pixel 8")
            );
            assert!(state.claim_device_name_locked("claim_unknown").is_none());
        }
        assert_eq!(
            store.claim_device_name_locked(&issued.claim_id).as_deref(),
            Some("Pixel 8")
        );
        assert!(store.claim_device_name_locked("claim_unknown").is_none());

        let anonymous = store
            .claim(&window.id, "\n\t", &nonce(2), ip(21))
            .expect("claim should be issued");
        assert_eq!(
            store
                .claim_device_name_locked(&anonymous.claim_id)
                .as_deref(),
            Some("Unknown device")
        );
    }

    #[test]
    fn claim_state_accessor_reports_every_state_without_mutation() {
        let (store, clock) = test_store();

        let pending_window = store.start_window();
        let pending = issue(&store, &pending_window, 1, 20);
        {
            let state = store.lock();
            assert_eq!(
                state.claim_state_locked(&pending.claim_id),
                Some(ClaimState::Pending)
            );
            assert!(state.claim_state_locked("claim_unknown").is_none());
        }
        // Read-only: the pending claim and its secret still work unchanged.
        assert_eq!(
            store
                .status(&pending.claim_id, &pending.claim_secret)
                .expect("still pending")
                .state,
            ClaimState::Pending
        );

        let approved_window = store.start_window();
        let approved = issue(&store, &approved_window, 2, 21);
        store.approve(&approved.claim_id).expect("approve");
        assert_eq!(
            store.lock().claim_state_locked(&approved.claim_id),
            Some(ClaimState::Approved)
        );

        let denied_window = store.start_window();
        let denied = issue(&store, &denied_window, 3, 22);
        store.deny(&denied.claim_id).expect("deny");
        assert_eq!(
            store.lock().claim_state_locked(&denied.claim_id),
            Some(ClaimState::Denied)
        );

        let consumed_window = store.start_window();
        let consumed = issue(&store, &consumed_window, 4, 23);
        store.approve(&consumed.claim_id).expect("approve");
        let now = clock.now();
        {
            let mut state = store.lock();
            state
                .consume_precheck_locked(&consumed.claim_id, &consumed.claim_secret, now)
                .expect("consume allowed");
            state.mark_consumed_locked(&consumed.claim_id, now);
            assert_eq!(
                state.claim_state_locked(&consumed.claim_id),
                Some(ClaimState::Consumed)
            );
        }

        let expired_window = store.start_window();
        let expired = issue(&store, &expired_window, 5, 24);
        clock.advance(PAIRING_TTL);
        // Any store operation purges; starting a window is enough.
        let _fresh = store.start_window();
        assert_eq!(
            store.lock().claim_state_locked(&expired.claim_id),
            Some(ClaimState::Expired)
        );

        let cancelled_window = store.start_window();
        let cancelled = issue(&store, &cancelled_window, 6, 25);
        store.cancel_window();
        assert_eq!(
            store.lock().claim_state_locked(&cancelled.claim_id),
            Some(ClaimState::Cancelled)
        );

        // The accessor yields a bare state: no secret or digest leaks.
        assert!(!format!("{store:?}").contains(pending.claim_secret.as_str()));
        assert!(!format!("{store:?}").contains(consumed.claim_secret.as_str()));
    }

    #[test]
    fn duplicate_same_nonce_is_409_and_never_reissues_secret() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        let first = issue(&store, &window, 1, 20);

        let error = store
            .claim(&window.id, "Other device", &nonce(1), ip(21))
            .unwrap_err();
        assert_eq!(error.code(), "pairing-claimed");
        assert!(!format!("{error:?}").contains(first.claim_secret.as_str()));

        store.deny(&first.claim_id).expect("deny");
        let after_terminal = store
            .claim(&window.id, "Other device", &nonce(1), ip(21))
            .unwrap_err();
        assert_eq!(after_terminal.code(), "pairing-claimed");
        assert!(!format!("{after_terminal:?}").contains(first.claim_secret.as_str()));
    }

    #[test]
    fn different_nonces_are_independent_but_only_one_can_be_approved() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        let first = issue(&store, &window, 1, 20);
        let second = issue(&store, &window, 2, 21);
        assert!(first.claim_secret.as_str() != second.claim_secret.as_str());
        assert_eq!(
            store
                .status(&second.claim_id, &second.claim_secret)
                .expect("pending")
                .state,
            ClaimState::Pending
        );

        store.approve(&first.claim_id).expect("approve");
        assert_eq!(
            store
                .status(&first.claim_id, &first.claim_secret)
                .expect("approved")
                .state,
            ClaimState::Approved
        );

        let cancelled = store
            .status(&second.claim_id, &second.claim_secret)
            .expect("receipt");
        assert_eq!(cancelled.state, ClaimState::Cancelled);
        assert!(cancelled.terminal_receipt);

        assert_eq!(
            store
                .claim(&window.id, "Third device", &nonce(3), ip(22))
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        assert_eq!(
            store.approve(&second.claim_id).unwrap_err().code(),
            "pairing-not-found"
        );
    }

    #[test]
    fn terminal_state_allows_one_receipt_and_never_a_token() {
        let (store, clock) = test_store();
        let window = store.start_window();
        let claim = issue(&store, &window, 1, 20);
        store.deny(&claim.claim_id).expect("deny");

        let receipt = store
            .status(&claim.claim_id, &claim.claim_secret)
            .expect("receipt");
        assert_eq!(receipt.state, ClaimState::Denied);
        assert!(receipt.terminal_receipt);

        assert_eq!(
            store
                .status(&claim.claim_id, &claim.claim_secret)
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );

        let now = clock.now();
        let mut state = store.lock();
        assert_eq!(
            state
                .consume_precheck_locked(&claim.claim_id, &claim.claim_secret, now)
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        assert!(!state.claims.contains_key(&claim.claim_id));
        drop(state);
        assert_eq!(
            store.approve(&claim.claim_id).unwrap_err().code(),
            "pairing-not-found"
        );
    }

    #[test]
    fn deny_invalidates_window_for_new_and_pending_claims() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        let denied = issue(&store, &window, 1, 20);
        let other = issue(&store, &window, 2, 21);

        store.deny(&denied.claim_id).expect("deny");

        let other_receipt = store
            .status(&other.claim_id, &other.claim_secret)
            .expect("receipt");
        assert_eq!(other_receipt.state, ClaimState::Cancelled);
        assert!(other_receipt.terminal_receipt);

        assert_eq!(
            store
                .claim(&window.id, "Pixel 8", &nonce(1), ip(20))
                .unwrap_err()
                .code(),
            "pairing-claimed"
        );
        assert_eq!(
            store
                .claim(&window.id, "Pixel 8", &nonce(3), ip(22))
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );

        let denied_receipt = store
            .status(&denied.claim_id, &denied.claim_secret)
            .expect("receipt");
        assert_eq!(denied_receipt.state, ClaimState::Denied);
        assert!(denied_receipt.terminal_receipt);
    }

    #[test]
    fn approve_cancels_other_claims_and_invalidates_window() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        let approved = issue(&store, &window, 1, 20);
        let other = issue(&store, &window, 2, 21);

        let approval = store.approve(&approved.claim_id).expect("approve");
        assert!(approval.claim_id == approved.claim_id);
        assert!(!format!("{approval:?}").contains(&approved.claim_id));

        assert_eq!(
            store
                .status(&other.claim_id, &other.claim_secret)
                .expect("receipt")
                .state,
            ClaimState::Cancelled
        );
        assert_eq!(
            store.approve(&approved.claim_id).unwrap_err().code(),
            "pairing-claimed"
        );
        assert_eq!(
            store
                .claim(&window.id, "Pixel 8", &nonce(3), ip(22))
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        assert_eq!(
            store.deny(&approved.claim_id).unwrap_err().code(),
            "pairing-claimed"
        );
    }

    #[test]
    fn approve_locked_maps_closed_windows_like_new_claims() {
        let (store, clock) = test_store();
        let now = clock.now();
        let window = store.start_window();
        let claim = issue(&store, &window, 1, 20);

        // Approve/deny always cancel sibling claims, so a pending claim inside
        // a closed window cannot occur naturally; force the state to exercise
        // the defensive closed-window mapping in `approve_locked`.
        let mut state = store.lock();
        assert_eq!(
            state.claims.get(&claim.claim_id).map(|entry| entry.state),
            Some(ClaimState::Pending)
        );
        for (reason, expected) in [
            (ClosedReason::Approved, "pairing-not-found"),
            (ClosedReason::Denied, "pairing-not-found"),
            (ClosedReason::Cancelled, "pairing-cancelled"),
        ] {
            state.windows.get_mut(&window.id).expect("window").closed = Some(reason);
            assert_eq!(
                state
                    .approve_locked(&claim.claim_id, now, None)
                    .unwrap_err()
                    .code(),
                expected
            );
        }
    }

    #[test]
    fn invalid_claim_nonce_is_rejected_without_creating_claims() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        let invalid = [
            String::new(),
            "short".to_owned(),
            "A".repeat(21),
            "A".repeat(23),
            "!".repeat(22),
            "AAAAAAAAAAAAAAAAAAAAAA==".to_owned(),
        ];
        for value in &invalid {
            let error = store
                .claim(&window.id, "Pixel 8", value, ip(20))
                .unwrap_err();
            assert_eq!(error.code(), "invalid-parameter");
        }
        assert!(store.lock().claims.is_empty());

        // Invalid attempts do not consume rate-limit budget.
        let valid = store
            .claim(&window.id, "Pixel 8", &nonce(1), ip(20))
            .expect("valid nonce still works");
        assert!(valid.claim_secret.len() == 43);
    }

    #[test]
    fn wrong_secret_never_reveals_state_and_never_burns_receipts() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        let first = issue(&store, &window, 1, 20);
        let second = issue(&store, &window, 2, 21);

        assert_eq!(
            store
                .status(&first.claim_id, &second.claim_secret)
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        assert_eq!(
            store
                .status(&first.claim_id, "not-the-secret")
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        assert_eq!(
            store
                .status(&first.claim_id, &first.claim_secret)
                .expect("pending")
                .state,
            ClaimState::Pending
        );

        store.deny(&first.claim_id).expect("deny");
        // `second` was cancelled by the deny and still has a receipt; a wrong
        // secret must not consume it.
        assert_eq!(
            store
                .status(&second.claim_id, &first.claim_secret)
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        let receipt = store
            .status(&second.claim_id, &second.claim_secret)
            .expect("receipt");
        assert_eq!(receipt.state, ClaimState::Cancelled);
        assert!(receipt.terminal_receipt);
    }

    #[test]
    fn per_ip_pending_and_global_pending_limits_reject_before_creating() {
        let (store, _clock) = test_store();
        let window = store.start_window();
        for seed in 0..MAX_PENDING_PER_IP as u8 {
            issue(&store, &window, seed, 20);
        }
        let error = store
            .claim(&window.id, "Pixel 8", &nonce(9), ip(20))
            .unwrap_err();
        assert_eq!(error.code(), "pairing-rate-limited");
        match error {
            PairingError::RateLimited { retry_after } => {
                assert!(retry_after > Duration::ZERO);
                assert!(retry_after <= PAIRING_TTL);
            }
            _ => panic!("expected rate limited"),
        }

        let (store, _clock) = test_store();
        let window = store.start_window();
        let mut created = 0usize;
        let mut limited = None;
        'outer: for host in 1..=7u8 {
            for seed in 0..MAX_PENDING_PER_IP as u8 {
                match store.claim(&window.id, "Pixel 8", &nonce(host * 10 + seed), ip(host)) {
                    Ok(_) => created += 1,
                    Err(error) => {
                        limited = Some(error);
                        break 'outer;
                    }
                }
            }
        }
        assert_eq!(created, MAX_GLOBAL_PENDING);
        assert_eq!(
            limited.expect("global pending limit").code(),
            "pairing-rate-limited"
        );
    }

    #[test]
    fn per_ip_claim_rate_limit_is_ten_per_minute() {
        let (store, clock) = test_store();
        let source = ip(30);
        let mut issued_count = 0usize;
        let mut seed = 0u8;
        let mut limited = None;
        'outer: for _ in 0..5 {
            let window = store.start_window();
            let mut claim_ids = Vec::new();
            for _ in 0..MAX_PENDING_PER_IP {
                seed += 1;
                match store.claim(&window.id, "Pixel 8", &nonce(seed), source) {
                    Ok(issued) => {
                        claim_ids.push(issued.claim_id);
                        issued_count += 1;
                    }
                    Err(error) => {
                        limited = Some(error);
                        break 'outer;
                    }
                }
            }
            store
                .approve(&claim_ids[0])
                .expect("approve frees pending slots");
        }
        assert_eq!(issued_count, MAX_CLAIMS_PER_MINUTE);
        let limited = limited.expect("per-ip claim rate limit");
        assert_eq!(limited.code(), "pairing-rate-limited");
        match limited {
            PairingError::RateLimited { retry_after } => {
                assert!(retry_after > Duration::ZERO);
                assert!(retry_after <= CLAIM_RATE_WINDOW);
            }
            _ => panic!("expected rate limited"),
        }

        clock.advance(CLAIM_RATE_WINDOW + Duration::from_secs(1));
        let window = store.start_window();
        assert!(store
            .claim(&window.id, "Pixel 8", &nonce(seed + 1), source)
            .is_ok());
    }

    #[test]
    fn window_expiry_gives_single_receipt_then_not_found() {
        let (store, clock) = test_store();
        let window = store.start_window();
        let claim = issue(&store, &window, 1, 20);

        clock.advance(PAIRING_TTL);
        assert_eq!(
            store
                .status(&claim.claim_id, "wrong-secret")
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        let receipt = store
            .status(&claim.claim_id, &claim.claim_secret)
            .expect("expired receipt");
        assert_eq!(receipt.state, ClaimState::Expired);
        assert!(receipt.terminal_receipt);
        assert_eq!(
            store
                .status(&claim.claim_id, &claim.claim_secret)
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        assert_eq!(
            store
                .claim(&window.id, "Pixel 8", &nonce(2), ip(21))
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
        assert_eq!(
            store
                .claim(&window.id, "Pixel 8", &nonce(1), ip(21))
                .unwrap_err()
                .code(),
            "pairing-not-found"
        );
    }

    #[test]
    fn sweep_removes_expired_windows_claims_and_rate_buckets() {
        let (store, clock) = test_store();
        let window = store.start_window();
        let _claim = issue(&store, &window, 1, 20);

        clock.advance(PAIRING_TTL + Duration::from_secs(1));
        let _fresh = store.start_window();
        {
            let state = store.lock();
            assert!(state.windows.len() == 1);
            assert!(state.claims.len() == 1);
        }

        clock.advance(TERMINAL_RETENTION + Duration::from_secs(1));
        let _fresh_again = store.start_window();
        {
            let state = store.lock();
            assert!(state.claims.is_empty());
            assert!(state.claim_times.is_empty());
        }
    }

    #[test]
    fn approved_pickup_timeout_clears_secret_without_receipt() {
        let (store, clock) = test_store();
        let window = store.start_window();
        let claim = issue(&store, &window, 1, 20);
        store.approve(&claim.claim_id).expect("approve");
        assert_eq!(
            store
                .status(&claim.claim_id, &claim.claim_secret)
                .expect("approved")
                .state,
            ClaimState::Approved
        );

        clock.advance(PICKUP_TIMEOUT + Duration::from_millis(1));
        assert_eq!(
            store
                .status(&claim.claim_id, &claim.claim_secret)
                .unwrap_err()
                .code(),
            "pairing-expired"
        );
        assert_eq!(
            store
                .status(&claim.claim_id, &claim.claim_secret)
                .unwrap_err()
                .code(),
            "pairing-expired"
        );

        let now = clock.now();
        let mut state = store.lock();
        let entry = state.claims.get(&claim.claim_id).expect("retained");
        assert!(entry.secret_hash.is_none());
        assert_eq!(entry.state, ClaimState::Expired);
        assert!(state.reservation_for(&claim.claim_id).is_none());
        assert_eq!(
            state
                .consume_precheck_locked(&claim.claim_id, &claim.claim_secret, now)
                .unwrap_err()
                .code(),
            "pairing-expired"
        );
        assert_eq!(
            state
                .approve_locked(&claim.claim_id, now, None)
                .unwrap_err()
                .code(),
            "pairing-expired"
        );
    }

    #[test]
    fn consumed_claim_reports_consumed_without_secret_or_token() {
        let (store, clock) = test_store();
        let window = store.start_window();
        let claim = issue(&store, &window, 1, 20);
        store.approve(&claim.claim_id).expect("approve");

        let now = clock.now();
        {
            let mut state = store.lock();
            assert_eq!(
                state
                    .consume_precheck_locked(&claim.claim_id, "wrong-secret", now)
                    .unwrap_err()
                    .code(),
                "pairing-not-found"
            );
            state
                .consume_precheck_locked(&claim.claim_id, &claim.claim_secret, now)
                .expect("consume allowed");
            state.mark_consumed_locked(&claim.claim_id, now);
            let entry = state.claims.get(&claim.claim_id).expect("retained");
            assert!(entry.secret_hash.is_none());
            assert_eq!(entry.state, ClaimState::Consumed);
        }

        assert_eq!(
            store
                .status(&claim.claim_id, &claim.claim_secret)
                .unwrap_err()
                .code(),
            "pairing-consumed"
        );
        // Knowing only the claim id learns nothing beyond "consumed".
        assert_eq!(
            store
                .status(&claim.claim_id, "wrong-secret")
                .unwrap_err()
                .code(),
            "pairing-consumed"
        );
        let now = clock.now();
        let mut state = store.lock();
        assert_eq!(
            state
                .consume_precheck_locked(&claim.claim_id, &claim.claim_secret, now)
                .unwrap_err()
                .code(),
            "pairing-consumed"
        );
    }

    #[test]
    fn cancel_window_returns_and_clears_reservation_ids() {
        let (store, clock) = test_store();
        let window = store.start_window();
        let approved = issue(&store, &window, 1, 20);
        let other = issue(&store, &window, 2, 21);

        let now = clock.now();
        {
            let mut state = store.lock();
            state
                .approve_locked(&approved.claim_id, now, Some("res_test".to_owned()))
                .expect("approve locked");
        }
        assert!(store.reservation_for(&approved.claim_id).as_deref() == Some("res_test"));
        assert!(store.cancellation_reservations() == vec!["res_test".to_owned()]);

        let released = store.cancel_window();
        assert!(released == vec!["res_test".to_owned()]);
        assert!(store.reservation_for(&approved.claim_id).is_none());
        assert!(store.cancellation_reservations().is_empty());

        let approved_receipt = store
            .status(&approved.claim_id, &approved.claim_secret)
            .expect("receipt");
        assert_eq!(approved_receipt.state, ClaimState::Cancelled);
        assert!(approved_receipt.terminal_receipt);
        assert_eq!(
            store
                .status(&other.claim_id, &other.claim_secret)
                .expect("receipt")
                .state,
            ClaimState::Cancelled
        );
        assert_eq!(
            store
                .claim(&window.id, "Pixel 8", &nonce(3), ip(22))
                .unwrap_err()
                .code(),
            "pairing-cancelled"
        );
    }

    #[test]
    fn error_codes_and_state_strings_are_stable() {
        assert_eq!(PairingError::NotFound.code(), "pairing-not-found");
        assert_eq!(PairingError::Claimed.code(), "pairing-claimed");
        assert_eq!(
            PairingError::RateLimited {
                retry_after: Duration::from_secs(1)
            }
            .code(),
            "pairing-rate-limited"
        );
        assert_eq!(PairingError::Expired.code(), "pairing-expired");
        assert_eq!(PairingError::Denied.code(), "pairing-denied");
        assert_eq!(PairingError::Cancelled.code(), "pairing-cancelled");
        assert_eq!(PairingError::Consumed.code(), "pairing-consumed");
        assert_eq!(PairingError::InvalidParameter.code(), "invalid-parameter");

        assert_eq!(ClaimState::Pending.as_str(), "pending");
        assert_eq!(ClaimState::Approved.as_str(), "approved");
        assert_eq!(ClaimState::Denied.as_str(), "denied");
        assert_eq!(ClaimState::Expired.as_str(), "expired");
        assert_eq!(ClaimState::Cancelled.as_str(), "cancelled");
        assert_eq!(ClaimState::Consumed.as_str(), "consumed");
    }
}
