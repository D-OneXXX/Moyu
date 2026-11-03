//! Atomic pairing approval / one-time session pickup orchestration (D1a).
//!
//! [`PairingService`] is the only component allowed to couple the pairing
//! state machine ([`PairingStore`]) with the session state machine
//! ([`SessionStore`]). It enforces the frozen invariants:
//!
//! - approval reserves exactly one session slot and never issues a token;
//! - the first consume with the correct claim secret commits that reservation
//!   into a single session token and marks the claim consumed atomically;
//! - approval validates the claim state before probing the session cap, so a
//!   second approval of an already approved claim reports `pairing-claimed`
//!   even when the device list is full; `device-limit` only applies to claims
//!   that could otherwise be approved;
//! - only a deadline expiry (`pairing-expired`: pickup timeout or window
//!   expiry) releases the reservation a claim still holds and drops the stale
//!   reservation reference, because no pickup can succeed any more; every
//!   other precheck rejection (wrong or missing secret, denied, cancelled,
//!   consumed) is a pure no-op that neither releases the slot nor mutates the
//!   claim, so knowing a claim id alone can never burn an approved pickup;
//! - the pairing state lock is always taken before the session state lock,
//!   never the other way around.
//!
//! This module registers no Tauri command and mounts no HTTP route. D1b's
//! [`super::runtime::WebAccessRuntime`] and the pair router call
//! [`PairingService`] directly; the state machines stay transport-agnostic.

use std::fmt;
use std::net::Ipv4Addr;
use std::sync::Arc;

use thiserror::Error;

use super::pairing::{
    ClaimIssued, ClaimState, ClaimStatus, PairingError, PairingStore, PairingWindow,
    PendingClaimView,
};
use super::session::{
    RefreshOutcome, RefreshTrigger, SessionError, SessionIssued, SessionStore, SessionView,
};

/// Errors surfaced by [`PairingService`]. Both variants keep the stable
/// `code()` of the underlying state machine; no variant carries ids, secrets,
/// tokens, or hashes.
#[derive(Debug, Error)]
pub(crate) enum AuthError {
    #[error("pairing rejected: {0}")]
    Pairing(#[from] PairingError),
    #[error("session rejected: {0}")]
    Session(#[from] SessionError),
}

impl AuthError {
    /// Stable code consumed by the HTTP/UI error mapping.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Pairing(error) => error.code(),
            Self::Session(error) => error.code(),
        }
    }
}

/// Atomic coordinator between [`PairingStore`] and [`SessionStore`].
///
/// Only this type may hold both state locks at the same time, and it always
/// acquires them in the frozen order: pairing state first, session state
/// second. All pairing transitions share the pairing clock's `now`, which is
/// also passed to the session reserve/commit helpers.
pub(crate) struct PairingService {
    pairing: PairingStore,
    session: SessionStore,
}

impl PairingService {
    pub(crate) fn new(pairing: PairingStore, session: SessionStore) -> Self {
        Self { pairing, session }
    }

    pub(crate) fn start_window(&self) -> PairingWindow {
        self.pairing.start_window()
    }

    pub(crate) fn claim(
        &self,
        pairing_id: &str,
        device_name: &str,
        claim_nonce: &str,
        source_ip: Ipv4Addr,
    ) -> Result<ClaimIssued, AuthError> {
        Ok(self
            .pairing
            .claim(pairing_id, device_name, claim_nonce, source_ip)?)
    }

    pub(crate) fn status(
        &self,
        claim_id: &str,
        claim_secret: &str,
    ) -> Result<ClaimStatus, AuthError> {
        Ok(self.pairing.status(claim_id, claim_secret)?)
    }

    /// Reserve a session slot for a pending claim and mark the claim approved
    /// in one critical section. No token is generated here; a failed approval
    /// never leaves a reservation behind.
    ///
    /// The claim state is checked after the device name is read and before a
    /// slot is probed, so an unapprovable claim always reports its own state
    /// (a second approval is `pairing-claimed`) even when the device list is
    /// already at the cap and would otherwise answer `device-limit`.
    pub(crate) fn approve(&self, claim_id: &str) -> Result<(), AuthError> {
        let now = self.pairing.clock().now();
        // Frozen lock order: pairing state first, session state second.
        let mut pairing = self.pairing.lock();
        // Purge first so a claim whose window/pickup deadline already passed
        // reports `pairing-expired` instead of a stale pre-purge state.
        pairing.purge_locked(now);
        let Some(device_name) = pairing.claim_device_name_locked(claim_id) else {
            return Err(PairingError::NotFound.into());
        };
        match pairing.claim_state_locked(claim_id) {
            Some(ClaimState::Pending) => {}
            Some(ClaimState::Approved) => return Err(PairingError::Claimed.into()),
            Some(ClaimState::Consumed) => return Err(PairingError::Consumed.into()),
            Some(ClaimState::Denied) => return Err(PairingError::Denied.into()),
            Some(ClaimState::Cancelled) => return Err(PairingError::Cancelled.into()),
            Some(ClaimState::Expired) => return Err(PairingError::Expired.into()),
            None => return Err(PairingError::NotFound.into()),
        }

        let mut session = self.session.lock();
        // A full device list propagates `device-limit` only for a claim that
        // could otherwise be approved, before any pairing state changes.
        let reservation = session.reserve_locked(&device_name, now)?;
        match pairing.approve_locked(claim_id, now, Some(reservation.id.clone())) {
            Ok(_) => Ok(()),
            Err(error) => {
                // The claim transition failed, so the slot reserved above is
                // unused; release it before surfacing the pairing error.
                session.release_locked(&reservation.id);
                Err(error.into())
            }
        }
    }

    pub(crate) fn deny(&self, claim_id: &str) -> Result<(), AuthError> {
        Ok(self.pairing.deny(claim_id)?)
    }

    /// Cancel every claim/window and release the reservations they hold. No
    /// token can be issued for a cancelled claim afterwards.
    pub(crate) fn cancel_window(&self) {
        let reservations = self.pairing.cancel_window();
        self.release_reservations(&reservations);
    }

    /// One-time pickup: commit the reservation into the single session token
    /// and mark the claim consumed while both locks are held.
    pub(crate) fn consume(
        &self,
        claim_id: &str,
        claim_secret: &str,
    ) -> Result<SessionIssued, AuthError> {
        let now = self.pairing.clock().now();
        // Frozen lock order: pairing state first, session state second.
        let mut pairing = self.pairing.lock();
        if let Err(error) = pairing.consume_precheck_locked(claim_id, claim_secret, now) {
            // Only a deadline expiry proves that no pickup is possible any
            // more, so only then is the slot the claim still holds released.
            // Every other rejection (wrong or missing secret, denied,
            // cancelled, consumed) is a pure no-op: a caller who merely knows
            // the claim id must not be able to burn the approved slot or the
            // claim, which would deny the legitimate pickup.
            if matches!(&error, PairingError::Expired) {
                if let Some(reservation_id) = pairing.reservation_for(claim_id) {
                    let mut session = self.session.lock();
                    session.release_locked(&reservation_id);
                    drop(session);
                    // The slot is gone for good; forget the stale reference
                    // while the pairing lock is still held so no later path
                    // can release an unrelated recycled reservation id.
                    pairing.clear_reservation_locked(claim_id);
                }
            }
            return Err(error.into());
        }

        let Some(reservation_id) = pairing.reservation_for(claim_id) else {
            // An approved claim without a reservation can never issue a token.
            return Err(PairingError::Expired.into());
        };
        let mut session = self.session.lock();
        match session.commit_locked(&reservation_id, now) {
            Ok(issued) => {
                // Token issuance and consumption share one critical section:
                // concurrent consumes can never both observe an approved claim
                // with a live reservation.
                pairing.mark_consumed_locked(claim_id, now);
                Ok(issued)
            }
            // A successful precheck plus a missing/expired reservation means
            // the pickup deadline passed. No token was issued and the claim is
            // not resurrected.
            Err(_) => Err(PairingError::Expired.into()),
        }
    }

    /// Resolve an issued session token without refreshing it. The returned
    /// view contains no token or hash material. Expired and revoked sessions
    /// both yield `None`; the HTTP layer maps that to the stable
    /// `unauthorized` code.
    pub(crate) fn authenticate(&self, token: &str) -> Option<SessionView> {
        self.session.authenticate(token)
    }

    /// Extend a live session only through an explicit whitelisted activity.
    /// Authentication itself never refreshes; the shared 60-minute throttle
    /// and 90-day absolute deadline remain owned by `SessionStore`. Callers
    /// must pass the view returned by authentication, choose the trigger via
    /// the frozen `refresh_trigger_for` classifier, and only refresh on a
    /// successful (2xx/304) page/tile response.
    pub(crate) fn refresh_activity(
        &self,
        session: &SessionView,
        trigger: RefreshTrigger,
    ) -> Result<RefreshOutcome, SessionError> {
        self.session.refresh_activity(&session.id, trigger)
    }

    pub(crate) fn revoke_device(&self, session_id: &str) -> bool {
        self.session.revoke(session_id)
    }

    /// Desktop device list; no token or token hash is present.
    pub(crate) fn devices(&self) -> Vec<SessionView> {
        self.session.device_views()
    }

    /// Claims awaiting desktop approval, oldest first.
    pub(crate) fn pending_claims(&self) -> Vec<PendingClaimView> {
        self.pairing.pending_claims()
    }

    pub(crate) fn pending_count(&self) -> usize {
        self.pairing.pending_count()
    }

    pub(crate) fn window_expiry(&self, pairing_id: &str) -> Option<std::time::Instant> {
        self.pairing.window_expiry(pairing_id)
    }

    pub(crate) fn clock(&self) -> &Arc<dyn super::clock::Clock> {
        self.pairing.clock()
    }

    /// Stop path: cancel every claim, release outstanding reservations, and
    /// revoke every live session.
    pub(crate) fn stop_all(&self) {
        let reservations = self.pairing.cancel_window();
        self.release_reservations(&reservations);
        self.session.revoke_all();
    }

    pub(crate) fn session_slots(&self) -> (usize, usize) {
        self.session.active_and_reserved()
    }

    fn release_reservations(&self, reservations: &[String]) {
        if reservations.is_empty() {
            return;
        }
        let mut session = self.session.lock();
        for reservation_id in reservations {
            session.release_locked(reservation_id);
        }
    }
}

/// Counts only: never renders claims, windows, device names, ids, or secrets.
impl fmt::Debug for PairingService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (active_sessions, reserved_sessions) = self.session.active_and_reserved();
        formatter
            .debug_struct("PairingService")
            .field("pairing", &self.pairing)
            .field("active_sessions", &active_sessions)
            .field("reserved_sessions", &reserved_sessions)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    use super::*;
    use crate::web_access::clock::test_support::FakeClock;
    use crate::web_access::pairing::{PAIRING_TTL, PICKUP_TIMEOUT};

    fn test_service() -> PairingService {
        test_service_with_clock(FakeClock::shared())
    }

    fn test_service_with_clock(clock: Arc<FakeClock>) -> PairingService {
        let pairing = PairingStore::new(clock.clone());
        let session = SessionStore::new(clock);
        PairingService::new(pairing, session)
    }

    fn ip(last: u8) -> Ipv4Addr {
        Ipv4Addr::new(192, 168, 1, last)
    }

    fn nonce(seed: u8) -> String {
        URL_SAFE_NO_PAD.encode([seed; 16])
    }

    fn claim_with(
        service: &PairingService,
        window: &PairingWindow,
        device_name: &str,
        seed: u8,
        last_ip: u8,
    ) -> ClaimIssued {
        service
            .claim(&window.id, device_name, &nonce(seed), ip(last_ip))
            .expect("claim should be issued")
    }

    fn claim_one_with(
        service: &PairingService,
        device_name: &str,
        seed: u8,
        last_ip: u8,
    ) -> ClaimIssued {
        let window = service.start_window();
        claim_with(service, &window, device_name, seed, last_ip)
    }

    fn claim_one(service: &PairingService) -> ClaimIssued {
        claim_one_with(service, "Pixel 8", 1, 20)
    }

    fn pair_and_consume(
        service: &PairingService,
        device_name: &str,
        seed: u8,
        last_ip: u8,
    ) -> SessionIssued {
        let claim = claim_one_with(service, device_name, seed, last_ip);
        service.approve(&claim.claim_id).expect("approval");
        service
            .consume(&claim.claim_id, &claim.claim_secret)
            .expect("consume")
    }

    #[test]
    fn approve_reserves_a_slot_and_issues_no_token() {
        let service = test_service();
        let window = service.start_window();
        let claim = claim_with(&service, &window, "  Pixel\u{0} 8\u{200b}  ", 1, 20);

        service.approve(&claim.claim_id).expect("approval");

        assert!(service.session_slots() == (0, 1));
        let sanitized = {
            let state = service.pairing.lock();
            state.claim_device_name_locked(&claim.claim_id)
        };
        assert!(sanitized.as_deref() == Some("Pixel 8"));
        let status = service
            .status(&claim.claim_id, &claim.claim_secret)
            .expect("approved status");
        assert!(status.state == ClaimState::Approved);
        assert!(!status.terminal_receipt);
        // Still no active session: approval only reserved a slot.
        assert!(service.session_slots() == (0, 1));
    }

    #[test]
    fn repeat_approval_is_claimed_and_keeps_the_reserved_slot() {
        let service = test_service();
        let claim = claim_one(&service);
        service.approve(&claim.claim_id).expect("approval");
        assert!(service.session_slots() == (0, 1));

        let error = service.approve(&claim.claim_id).unwrap_err();
        assert_eq!(error.code(), "pairing-claimed");
        // The rejected re-approval must not leave a second reservation behind,
        // and the original one is still usable.
        assert!(service.session_slots() == (0, 1));

        let issued = service
            .consume(&claim.claim_id, &claim.claim_secret)
            .expect("the original approval is still usable");
        assert!(service.session_slots() == (1, 0));
        assert!(service
            .session
            .authenticate(issued.token.as_str())
            .is_some());
    }

    #[test]
    fn first_consume_issues_token_and_second_consume_is_rejected() {
        let service = test_service();
        let claim = claim_one(&service);
        service.approve(&claim.claim_id).expect("approval");

        let issued = service
            .consume(&claim.claim_id, &claim.claim_secret)
            .expect("first consume");
        assert!(issued.token.starts_with("moyus_"));
        assert!(issued.token.len() == 49);
        assert!(service.session_slots() == (1, 0));
        let view = service
            .session
            .authenticate(issued.token.as_str())
            .expect("issued token authenticates");
        assert!(view.device_name == "Pixel 8");

        let debug = format!("{service:?}");
        assert!(!debug.contains(issued.token.as_str()));
        assert!(!debug.contains(&issued.id));
        assert!(!debug.contains(&claim.claim_id));
        assert!(!debug.contains(claim.claim_secret.as_str()));
        assert!(debug.contains("active_sessions: 1"));

        let error = service
            .consume(&claim.claim_id, &claim.claim_secret)
            .unwrap_err();
        assert_eq!(error.code(), "pairing-consumed");
        assert!(service.session_slots() == (1, 0));
    }

    #[test]
    fn wrong_secret_reports_not_found_and_issues_no_session() {
        let service = test_service();
        let claim = claim_one(&service);
        service.approve(&claim.claim_id).expect("approval");
        assert!(service.session_slots() == (0, 1));

        let error = service
            .consume(&claim.claim_id, "not-the-secret")
            .unwrap_err();
        assert_eq!(error.code(), "pairing-not-found");
        // A wrong secret is a pure no-op: the approved slot stays reserved and
        // no session exists, so a stale cookie or a leaked claim id alone
        // cannot deny the legitimate pickup.
        assert!(service.session_slots() == (0, 1));
        let status = service
            .status(&claim.claim_id, &claim.claim_secret)
            .expect("claim is not burned");
        assert!(status.state == ClaimState::Approved);

        let issued = service
            .consume(&claim.claim_id, &claim.claim_secret)
            .expect("the correct secret still picks up the token");
        assert!(service.session_slots() == (1, 0));
        assert!(service
            .session
            .authenticate(issued.token.as_str())
            .is_some());
    }

    #[test]
    fn pending_and_denied_claims_cannot_consume() {
        let service = test_service();
        let pending = claim_one(&service);
        let error = service
            .consume(&pending.claim_id, &pending.claim_secret)
            .unwrap_err();
        assert_eq!(error.code(), "pairing-not-found");
        assert!(service.session_slots() == (0, 0));

        let denied = claim_one_with(&service, "Tablet", 2, 21);
        service.deny(&denied.claim_id).expect("deny");
        let error = service
            .consume(&denied.claim_id, &denied.claim_secret)
            .unwrap_err();
        assert_eq!(error.code(), "pairing-denied");
        assert!(service.session_slots() == (0, 0));
    }

    #[test]
    fn pickup_timeout_expires_without_orphan_slot() {
        let clock = FakeClock::shared();
        let service = test_service_with_clock(clock.clone());
        let claim = claim_one(&service);
        service.approve(&claim.claim_id).expect("approval");
        assert!(service.session_slots() == (0, 1));

        clock.advance(PICKUP_TIMEOUT + Duration::from_secs(1));
        let error = service
            .consume(&claim.claim_id, &claim.claim_secret)
            .unwrap_err();
        assert_eq!(error.code(), "pairing-expired");
        assert!(service.session_slots() == (0, 0));
        assert!(service.pairing.reservation_for(&claim.claim_id).is_none());
    }

    #[test]
    fn window_expiry_releases_the_still_live_reservation_explicitly() {
        let clock = FakeClock::shared();
        let service = test_service_with_clock(clock.clone());
        let window = service.start_window();

        // Claim shortly before the window expires: the pickup deadline becomes
        // the window expiry, while the 5 s session reservation outlives it.
        clock.advance(PAIRING_TTL - Duration::from_secs(4));
        let claim = claim_with(&service, &window, "Pixel 8", 1, 20);
        service.approve(&claim.claim_id).expect("approval");
        assert!(service.session_slots() == (0, 1));

        clock.advance(Duration::from_secs(4) + Duration::from_millis(1));
        // Window and pickup deadline passed, but the session reservation would
        // still be live for almost another second: only the explicit release
        // can empty the slot.
        assert!(service.session_slots() == (0, 1));

        let error = service
            .consume(&claim.claim_id, &claim.claim_secret)
            .unwrap_err();
        assert_eq!(error.code(), "pairing-expired");
        assert!(service.session_slots() == (0, 0));
        assert!(service.pairing.reservation_for(&claim.claim_id).is_none());
    }

    #[test]
    fn eight_devices_block_approval_without_eviction() {
        let service = test_service();
        let mut issued = Vec::new();
        for index in 0..8u8 {
            issued.push(pair_and_consume(
                &service,
                &format!("Device {index}"),
                index + 1,
                10 + index,
            ));
        }
        assert!(service.session_slots() == (8, 0));

        let ninth = claim_one_with(&service, "Ninth device", 9, 40);
        let error = service.approve(&ninth.claim_id).unwrap_err();
        assert_eq!(error.code(), "device-limit");
        assert!(service.session_slots() == (8, 0));
        for session in &issued {
            assert!(
                service
                    .session
                    .authenticate(session.token.as_str())
                    .is_some(),
                "an existing session must not be evicted"
            );
        }
        // The rejected claim never became approvable without a free slot.
        assert!(service
            .consume(&ninth.claim_id, &ninth.claim_secret)
            .is_err());
    }

    #[test]
    fn repeat_approval_at_capacity_reports_claimed_not_device_limit() {
        let service = test_service();
        for index in 0..7u8 {
            pair_and_consume(&service, &format!("Device {index}"), index + 1, 10 + index);
        }
        assert!(service.session_slots() == (7, 0));

        // 7 active + 1 reserved is exactly the cap, so a blind reserve would
        // report `device-limit` on the second approval.
        let claim = claim_one_with(&service, "Eighth device", 8, 40);
        service.approve(&claim.claim_id).expect("approval");
        assert!(service.session_slots() == (7, 1));

        let error = service.approve(&claim.claim_id).unwrap_err();
        assert_eq!(error.code(), "pairing-claimed");
        assert!(service.session_slots() == (7, 1));
    }

    #[test]
    fn concurrent_consume_has_exactly_one_winner() {
        let service = Arc::new(test_service());
        let claim = claim_one(&service);
        service.approve(&claim.claim_id).expect("approval");
        assert!(service.session_slots() == (0, 1));

        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let service = Arc::clone(&service);
                let claim_id = claim.claim_id.clone();
                let claim_secret = claim.claim_secret.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    service
                        .consume(&claim_id, &claim_secret)
                        .map(|issued| issued.token)
                })
            })
            .collect();

        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("consume thread"))
            .collect();
        let winners = results.iter().filter(|result| result.is_ok()).count();
        assert!(winners == 1);
        for result in &results {
            if let Err(error) = result {
                // The winner marks the claim consumed inside the same pairing
                // critical section, so a loser can only ever observe the
                // consumed state.
                assert_eq!(error.code(), "pairing-consumed");
            }
        }
        assert!(service.session_slots() == (1, 0));
    }

    #[test]
    fn approval_cancels_sibling_claim() {
        let service = test_service();
        let window = service.start_window();
        let approved = claim_with(&service, &window, "Pixel 8", 1, 20);
        let sibling = claim_with(&service, &window, "Tablet", 2, 21);

        service.approve(&approved.claim_id).expect("approval");
        assert!(service.pairing.reservation_for(&sibling.claim_id).is_none());
        let status = service
            .status(&sibling.claim_id, &sibling.claim_secret)
            .expect("terminal receipt");
        assert!(status.state == ClaimState::Cancelled);
        assert!(status.terminal_receipt);
        assert!(service.session_slots() == (0, 1));
    }

    #[test]
    fn cancel_window_releases_the_reserved_slot() {
        let service = test_service();
        let claim = claim_one(&service);
        service.approve(&claim.claim_id).expect("approval");
        assert!(service.session_slots() == (0, 1));

        service.cancel_window();
        assert!(service.session_slots() == (0, 0));

        let error = service
            .consume(&claim.claim_id, &claim.claim_secret)
            .unwrap_err();
        assert_eq!(error.code(), "pairing-cancelled");
        assert!(service.session_slots() == (0, 0));
    }

    #[test]
    fn stop_all_revokes_sessions_and_clears_claims() {
        let service = test_service();
        let first = pair_and_consume(&service, "Device A", 1, 10);
        let second = pair_and_consume(&service, "Device B", 2, 11);
        assert!(service.session_slots() == (2, 0));

        let pending = claim_one_with(&service, "Pending", 3, 20);
        let approved = claim_one_with(&service, "Approved", 4, 21);
        service.approve(&approved.claim_id).expect("approval");
        assert!(service.session_slots() == (2, 1));

        assert!(service.revoke_device(&first.id));
        assert!(!service.revoke_device(&first.id));
        assert!(service.session.authenticate(first.token.as_str()).is_none());
        assert!(service
            .session
            .authenticate(second.token.as_str())
            .is_some());
        assert!(service.session_slots() == (1, 1));

        service.stop_all();
        assert!(service.session_slots() == (0, 0));
        assert!(service
            .session
            .authenticate(second.token.as_str())
            .is_none());

        let receipt = service
            .status(&pending.claim_id, &pending.claim_secret)
            .expect("cancelled receipt");
        assert!(receipt.state == ClaimState::Cancelled);
        let error = service
            .consume(&approved.claim_id, &approved.claim_secret)
            .unwrap_err();
        assert_eq!(error.code(), "pairing-cancelled");
    }
}
