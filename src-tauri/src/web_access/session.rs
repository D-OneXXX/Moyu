//! In-memory session token state machine (D1a).
//!
//! Sessions live only in process memory: stopping Web Access, quitting, or
//! crashing the desktop drops every token. A token is generated exactly once
//! when a reservation is committed, returned once to the HTTP layer, and only
//! its SHA-256 digest is retained for authentication.
//!
//! Time is monotonic and injected through [`Clock`]. `authenticate` never
//! refreshes a session; only [`SessionStore::refresh_activity`] with an
//! explicit [`RefreshTrigger`] may extend the sliding expiry, at most once per
//! 60 minutes and never past the 90-day absolute deadline.

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

use super::clock::Clock;
use super::secret::{constant_time_eq, random_b64, random_hex, sanitize_device_name, sha256_bytes};

/// Sliding lifetime granted by an eligible activity refresh.
pub(crate) const SLIDING: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Hard lifetime measured from `issued_at`; no refresh may cross it.
pub(crate) const ABSOLUTE: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// Minimum interval between two activity refreshes of the same session.
pub(crate) const REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Maximum number of active sessions plus outstanding reservations.
pub(crate) const MAX_SESSIONS: usize = 8;
/// How long an approved-but-not-yet-consumed reservation holds a slot.
pub(crate) const RESERVATION_TTL: Duration = Duration::from_secs(5);

const TOKEN_PREFIX: &str = "moyus_";
const SESSION_ID_PREFIX: &str = "dev_";
const RESERVATION_ID_PREFIX: &str = "res_";
const TOKEN_BYTES: usize = 32;
const ID_BYTES: usize = 16;

/// Stable failure classes for authentication, reservation and refresh paths.
#[derive(Debug, Error)]
pub(crate) enum SessionError {
    #[error("session unauthorized")]
    Unauthorized,
    #[error("device limit reached")]
    DeviceLimit,
    #[error("session expired")]
    Expired,
}

impl SessionError {
    /// Stable code consumed by the HTTP/UI error mapping.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::DeviceLimit => "device-limit",
            Self::Expired => "session-expired",
        }
    }
}

/// A slot held for an approved pairing claim. It is not a session yet: only
/// [`SessionStore::commit`] turns it into one, and unused reservations expire
/// after [`RESERVATION_TTL`].
#[derive(Clone)]
pub(crate) struct Reservation {
    pub id: String,
    pub device_name: String,
    /// Peer IPv4 captured when the claim was created; never trusted from a
    /// header. `None` only for tests that issue sessions without HTTP.
    pub source_ip: Option<std::net::Ipv4Addr>,
    pub expires_at: Instant,
}

/// A freshly issued session. The plaintext token is returned exactly once and
/// is never available through [`SessionStore::authenticate`].
pub(crate) struct SessionIssued {
    pub id: String,
    pub token: Zeroizing<String>,
}

/// Authenticated, read-only view of a session. Contains no token material.
pub(crate) struct SessionView {
    pub id: String,
    pub device_name: String,
    /// Claim-time private IPv4; never a token, hash, or path.
    pub source_ip: Option<std::net::Ipv4Addr>,
    /// Consume-time User-Agent (already sanitized/truncated).
    pub user_agent: Option<String>,
    pub issued_at: Instant,
    pub expires_at: Instant,
    pub absolute_expires_at: Instant,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_seen_at: chrono::DateTime<chrono::Utc>,
}

/// Request classes allowed to refresh a session. All three share one 60-minute
/// throttle; `authenticate` never implies a refresh.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum RefreshTrigger {
    PageRead,
    TileRead,
    ProgressChanged,
}

#[derive(PartialEq, Eq, Debug)]
pub(crate) enum RefreshOutcome {
    Refreshed {
        expires_at: Instant,
        trigger: RefreshTrigger,
    },
    NotRefreshed,
}

pub(crate) struct SessionStore {
    state: Mutex<SessionState>,
    clock: Arc<dyn Clock>,
}

/// Shared session state. Task 3 locks the pairing store first and this state
/// second; the reverse order is never taken.
pub(crate) struct SessionState {
    sessions: Vec<SessionRecord>,
    reservations: Vec<Reservation>,
}

struct SessionRecord {
    id: String,
    device_name: String,
    source_ip: Option<std::net::Ipv4Addr>,
    user_agent: Option<String>,
    token_hash: [u8; 32],
    issued_at: Instant,
    last_refreshed_at: Instant,
    expires_at: Instant,
    absolute_expires_at: Instant,
    created_at: chrono::DateTime<chrono::Utc>,
    last_seen_at: chrono::DateTime<chrono::Utc>,
}

impl SessionRecord {
    fn is_live(&self, now: Instant) -> bool {
        now < self.expires_at && now < self.absolute_expires_at
    }

    fn view(&self) -> SessionView {
        SessionView {
            id: self.id.clone(),
            device_name: self.device_name.clone(),
            source_ip: self.source_ip,
            user_agent: self.user_agent.clone(),
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            absolute_expires_at: self.absolute_expires_at,
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
        }
    }
}

/// Consume-time User-Agent for the desktop device list. Control and
/// zero-width characters are dropped, the value is capped at 256 scalars, and
/// empty input is stored as `None` (never an empty string).
fn sanitize_user_agent(raw: Option<&str>) -> Option<String> {
    const MAX_UA_SCALARS: usize = 256;
    let raw = raw?;
    let mut sanitized = String::new();
    let mut scalars = 0usize;
    for c in raw.chars() {
        if c.is_control() || matches!(c, '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}') {
            continue;
        }
        if scalars == MAX_UA_SCALARS {
            break;
        }
        sanitized.push(c);
        scalars += 1;
    }
    let trimmed = sanitized.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

impl Drop for SessionRecord {
    fn drop(&mut self) {
        self.token_hash.zeroize();
    }
}

impl SessionStore {
    pub(crate) fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            state: Mutex::new(SessionState {
                sessions: Vec::new(),
                reservations: Vec::new(),
            }),
            clock,
        }
    }

    /// Reserve a future session slot without issuing a token yet.
    pub(crate) fn reserve(&self, device_name: &str) -> Result<Reservation, SessionError> {
        self.reserve_client(device_name, None)
    }

    /// Reserve a slot with the claim-time peer address (desktop device list).
    pub(crate) fn reserve_client(
        &self,
        device_name: &str,
        source_ip: Option<std::net::Ipv4Addr>,
    ) -> Result<Reservation, SessionError> {
        let now = self.clock.now();
        self.lock().reserve_locked(device_name, source_ip, now)
    }

    /// Turn a reservation into a session. This is the only token issuance
    /// point; the same reservation can never be committed twice.
    pub(crate) fn commit(&self, reservation: Reservation) -> Result<SessionIssued, SessionError> {
        self.commit_with_user_agent(reservation, None)
    }

    /// Commit with the consume request's User-Agent for the desktop list.
    pub(crate) fn commit_with_user_agent(
        &self,
        reservation: Reservation,
        user_agent: Option<&str>,
    ) -> Result<SessionIssued, SessionError> {
        let now = self.clock.now();
        self.lock().commit_locked(&reservation.id, now, user_agent)
    }

    /// Drop a reservation that will never be consumed.
    pub(crate) fn release(&self, reservation: Reservation) {
        self.lock().release_locked(&reservation.id);
    }

    /// Resolve a token to its session without refreshing anything.
    pub(crate) fn authenticate(&self, token: &str) -> Option<SessionView> {
        let digest = Zeroizing::new(sha256_bytes(token));
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);
        let mut matched = None;
        for record in &mut state.sessions {
            // Compare every record so the lookup does not exit early.
            if constant_time_eq(&record.token_hash, &digest[..]) {
                record.last_seen_at = chrono::Utc::now();
                matched = Some(record.view());
            }
        }
        matched
    }

    /// Extend a live session through an explicit, whitelisted activity.
    /// At most one refresh per [`REFRESH_INTERVAL`] and never beyond
    /// `issued_at + ABSOLUTE`.
    pub(crate) fn refresh_activity(
        &self,
        session_id: &str,
        trigger: RefreshTrigger,
    ) -> Result<RefreshOutcome, SessionError> {
        let now = self.clock.now();
        let mut state = self.lock();
        let Some(index) = state
            .sessions
            .iter()
            .position(|record| record.id == session_id)
        else {
            return Err(SessionError::Unauthorized);
        };
        if !state.sessions[index].is_live(now) {
            state.sessions.remove(index);
            state.purge_locked(now);
            return Err(SessionError::Expired);
        }
        if now < state.sessions[index].last_refreshed_at + REFRESH_INTERVAL {
            return Ok(RefreshOutcome::NotRefreshed);
        }
        let expires_at = (now + SLIDING).min(state.sessions[index].absolute_expires_at);
        let record = &mut state.sessions[index];
        record.last_refreshed_at = now;
        record.expires_at = expires_at;
        Ok(RefreshOutcome::Refreshed {
            expires_at,
            trigger,
        })
    }

    /// Revoke one session immediately. Returns `false` for unknown ids.
    pub(crate) fn revoke(&self, session_id: &str) -> bool {
        let mut state = self.lock();
        let before = state.sessions.len();
        state.sessions.retain(|record| record.id != session_id);
        state.sessions.len() != before
    }

    /// Revoke every session and release every outstanding reservation.
    pub(crate) fn revoke_all(&self) {
        let mut state = self.lock();
        state.sessions.clear();
        state.reservations.clear();
    }

    /// Count (active sessions, unexpired reservations) after purging expired
    /// entries, so a timed-out approval can never leak a slot.
    pub(crate) fn active_and_reserved(&self) -> (usize, usize) {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);
        (state.sessions.len(), state.reservations.len())
    }

    /// Read-only device list. [`SessionView`] carries no token or token hash.
    pub(crate) fn device_views(&self) -> Vec<SessionView> {
        let now = self.clock.now();
        let mut state = self.lock();
        state.purge_locked(now);
        state.sessions.iter().map(SessionRecord::view).collect()
    }

    /// Poison-recovering lock shared with Task 3's orchestration layer.
    pub(crate) fn lock(&self) -> MutexGuard<'_, SessionState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }

    #[cfg(test)]
    pub(crate) fn create_for_test(&self, name: &str) -> SessionIssued {
        let reservation = self.reserve(name).expect("test reservation must succeed");
        self.commit(reservation).expect("test commit must succeed")
    }
}

impl SessionState {
    pub(crate) fn reserve_locked(
        &mut self,
        device_name: &str,
        source_ip: Option<std::net::Ipv4Addr>,
        now: Instant,
    ) -> Result<Reservation, SessionError> {
        self.purge_locked(now);
        if self.sessions.len() + self.reservations.len() >= MAX_SESSIONS {
            return Err(SessionError::DeviceLimit);
        }
        let reservation = Reservation {
            id: format!("{RESERVATION_ID_PREFIX}{}", random_hex(ID_BYTES)),
            device_name: sanitize_device_name(device_name),
            source_ip,
            expires_at: now + RESERVATION_TTL,
        };
        self.reservations.push(reservation.clone());
        Ok(reservation)
    }

    pub(crate) fn commit_locked(
        &mut self,
        reservation_id: &str,
        now: Instant,
        user_agent: Option<&str>,
    ) -> Result<SessionIssued, SessionError> {
        self.purge_locked(now);
        let index = self
            .reservations
            .iter()
            .position(|reservation| reservation.id == reservation_id)
            .ok_or(SessionError::Expired)?;
        let reservation = self.reservations.remove(index);

        // Build the 49-char token in one zeroizing allocation. Growing a
        // `Zeroizing<String>` with `insert_str` frees the original unzeroized
        // 43-byte buffer, so the suffix keeps its own `Zeroizing` and both
        // allocations are wiped on drop.
        let suffix = random_b64(TOKEN_BYTES);
        let mut token = Zeroizing::new(String::with_capacity(TOKEN_PREFIX.len() + suffix.len()));
        token.push_str(TOKEN_PREFIX);
        token.push_str(suffix.as_str());
        let wall_now = chrono::Utc::now();
        let record = SessionRecord {
            id: format!("{SESSION_ID_PREFIX}{}", random_hex(ID_BYTES)),
            device_name: reservation.device_name,
            source_ip: reservation.source_ip,
            user_agent: sanitize_user_agent(user_agent),
            token_hash: sha256_bytes(token.as_str()),
            issued_at: now,
            last_refreshed_at: now,
            expires_at: (now + SLIDING).min(now + ABSOLUTE),
            absolute_expires_at: now + ABSOLUTE,
            created_at: wall_now,
            last_seen_at: wall_now,
        };
        let id = record.id.clone();
        self.sessions.push(record);
        Ok(SessionIssued { id, token })
    }

    pub(crate) fn release_locked(&mut self, reservation_id: &str) {
        self.reservations
            .retain(|reservation| reservation.id != reservation_id);
    }

    /// Drop expired sessions and reservations. Idempotent; safe to call while
    /// the state lock is already held.
    pub(crate) fn purge_locked(&mut self, now: Instant) {
        self.sessions.retain(|record| record.is_live(now));
        self.reservations
            .retain(|reservation| now < reservation.expires_at);
    }
}

impl fmt::Debug for SessionStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = self.lock();
        formatter
            .debug_struct("SessionStore")
            .field("sessions", &state.sessions.len())
            .field("reservations", &state.reservations.len())
            .finish()
    }
}

impl fmt::Debug for SessionState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionState")
            .field("sessions", &self.sessions.len())
            .field("reservations", &self.reservations.len())
            .finish()
    }
}

impl fmt::Debug for Reservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Reservation")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for SessionIssued {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionIssued")
            .field("id", &"<redacted>")
            .field("token", &"<redacted>")
            .finish()
    }
}

impl fmt::Debug for SessionView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionView")
            .field("issued_at", &self.issued_at)
            .field("expires_at", &self.expires_at)
            .field("absolute_expires_at", &self.absolute_expires_at)
            .finish_non_exhaustive()
    }
}

/// Frozen request classifier for session refresh eligibility. D2/D3 routes
/// must consume this result instead of writing their own refresh rules.
pub(crate) fn refresh_trigger_for(
    method: &str,
    path: &str,
    progress_changed: bool,
) -> Option<RefreshTrigger> {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let segments = path.strip_prefix('/')?.split('/').collect::<Vec<_>>();
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    match (method, segments.as_slice()) {
        ("GET", ["api", "books", _, "pages", page]) if strict_u32(page).is_some() => {
            Some(RefreshTrigger::PageRead)
        }
        ("GET", ["api", "books", _, "pages", page, "tiles", tile])
            if strict_u32(page).is_some() && strict_u32(tile).is_some() =>
        {
            Some(RefreshTrigger::TileRead)
        }
        ("PUT", ["api", "books", _, "progress"]) if progress_changed => {
            Some(RefreshTrigger::ProgressChanged)
        }
        _ => None,
    }
}

pub(crate) fn strict_u32(segment: &str) -> Option<u32> {
    if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    segment.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_access::clock::test_support::FakeClock;

    fn fake_clock() -> Arc<FakeClock> {
        FakeClock::shared()
    }

    fn test_session_store() -> SessionStore {
        SessionStore::new(fake_clock())
    }

    #[test]
    fn token_is_256_bit_and_only_hash_is_stored() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        assert_eq!(store.clock().now(), clock.now());
        let issued = store.create_for_test("Pixel 8");

        let suffix = issued
            .token
            .strip_prefix(TOKEN_PREFIX)
            .expect("token prefix");
        assert_eq!(suffix.len(), 43);
        assert_eq!(issued.token.len(), 49);
        assert!(suffix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(issued.id.starts_with(SESSION_ID_PREFIX));
        assert_eq!(issued.id.len(), SESSION_ID_PREFIX.len() + 32);
        assert!(issued.id[SESSION_ID_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_hexdigit()));

        let reservation = store.reserve("Tablet").expect("reserve");
        assert!(reservation.id.starts_with(RESERVATION_ID_PREFIX));
        assert_eq!(reservation.id.len(), RESERVATION_ID_PREFIX.len() + 32);
        assert!(reservation.id[RESERVATION_ID_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
        store.release(reservation);

        let state = store.lock();
        assert_eq!(state.sessions.len(), 1);
        // Boolean compare so a failure never prints token material or hashes.
        let expected_hash = Zeroizing::new(sha256_bytes(issued.token.as_str()));
        assert!(state.sessions[0].token_hash == *expected_hash);
        assert_eq!(state.sessions[0].device_name, "Pixel 8");
        drop(state);

        assert!(store.authenticate(issued.token.as_str()).is_some());
    }

    #[test]
    fn debug_output_redacts_tokens_ids_and_hashes() {
        let store = test_session_store();
        let issued = store.create_for_test("Pixel 8");
        let view = store.authenticate(issued.token.as_str()).expect("session");

        let store_debug = format!("{store:?}");
        assert!(!store_debug.contains(issued.token.as_str()));
        assert!(!store_debug.contains(&issued.id));
        assert!(!store_debug.contains("Pixel"));
        assert!(store_debug.contains("sessions: 1"));

        let issued_debug = format!("{issued:?}");
        assert!(!issued_debug.contains(issued.token.as_str()));
        assert!(!issued_debug.contains(&issued.id));

        let view_debug = format!("{view:?}");
        assert!(view.id == issued.id);
        assert!(!view_debug.contains(issued.token.as_str()));
        assert!(!view_debug.contains(&issued.id));
        assert!(!view_debug.contains("Pixel"));

        let reservation = store.reserve("Tablet").expect("reserve");
        let reservation_debug = format!("{reservation:?}");
        assert!(!reservation_debug.contains(&reservation.id));
        assert!(!reservation_debug.contains("Tablet"));
    }

    #[test]
    fn refresh_classifier_matches_only_page_tile_and_progress_change() {
        assert_eq!(
            refresh_trigger_for("GET", "/api/books/abc/pages/0", false),
            Some(RefreshTrigger::PageRead)
        );
        assert_eq!(
            refresh_trigger_for("GET", "/api/books/abc/pages/3", false),
            Some(RefreshTrigger::PageRead)
        );
        assert_eq!(
            refresh_trigger_for("GET", "/api/books/abc/pages/3/tiles/1", false),
            Some(RefreshTrigger::TileRead)
        );
        assert_eq!(
            refresh_trigger_for("PUT", "/api/books/abc/progress", true),
            Some(RefreshTrigger::ProgressChanged)
        );
        assert_eq!(
            refresh_trigger_for("PUT", "/api/books/abc/progress", false),
            None
        );

        for (method, path) in [
            ("GET", "/api/books"),
            ("GET", "/api/books/abc"),
            ("GET", "/api/books/abc/pages"),
            ("GET", "/api/books/abc/layout"),
            ("GET", "/api/books/abc/progress"),
            ("GET", "/api/books/abc/thumb"),
            ("GET", "/api/health"),
            ("GET", "/api/session"),
            ("DELETE", "/api/session"),
            ("GET", "/api/pair/claim/claim_x"),
        ] {
            assert_eq!(
                refresh_trigger_for(method, path, false),
                None,
                "{method} {path}"
            );
        }
    }

    #[test]
    fn refresh_classifier_rejects_trailing_slashes_non_numeric_and_unknown_methods() {
        for (method, path) in [
            ("GET", "/api/books/abc/pages/3/"),
            ("GET", "/api/books/abc/pages/3/tiles/1/"),
            ("PUT", "/api/books/abc/progress/"),
            ("GET", "/api/books/abc/pages/not-a-number"),
            ("GET", "/api/books/abc/pages/-1"),
            ("GET", "/api/books/abc/pages/+3"),
            ("GET", "/api/books/abc/pages/3.0"),
            ("GET", "/api/books/abc/pages/4294967296"),
            ("GET", "/api/books/abc/pages/3/tiles/4294967296"),
            ("GET", "/api/books/abc/pages/3/tiles/"),
            ("POST", "/api/books/abc/pages/3"),
            ("PATCH", "/api/books/abc/progress"),
            ("GET", "/api/books//pages/3"),
            ("GET", "api/books/abc/pages/3"),
        ] {
            assert_eq!(
                refresh_trigger_for(method, path, true),
                None,
                "{method} {path}"
            );
        }
    }

    #[test]
    fn only_page_tile_and_progress_change_refresh_and_share_hourly_throttle() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        let issued = store.create_for_test("Pixel 8");

        clock.advance(Duration::from_secs(61 * 60));
        assert!(matches!(
            store
                .refresh_activity(&issued.id, RefreshTrigger::PageRead)
                .expect("page read refresh"),
            RefreshOutcome::Refreshed {
                trigger: RefreshTrigger::PageRead,
                ..
            }
        ));

        clock.advance(Duration::from_secs(30 * 60));
        assert_eq!(
            store
                .refresh_activity(&issued.id, RefreshTrigger::TileRead)
                .expect("tile read is valid but throttled"),
            RefreshOutcome::NotRefreshed
        );

        clock.advance(Duration::from_secs(31 * 60));
        assert!(matches!(
            store
                .refresh_activity(&issued.id, RefreshTrigger::ProgressChanged)
                .expect("progress refresh"),
            RefreshOutcome::Refreshed {
                trigger: RefreshTrigger::ProgressChanged,
                ..
            }
        ));
    }

    #[test]
    fn authenticate_never_refreshes() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        let issued = store.create_for_test("Pixel 8");
        let issued_at = clock.now();

        clock.advance(Duration::from_secs(20 * 86400));
        let view = store
            .authenticate(issued.token.as_str())
            .expect("within 30 days");
        assert_eq!(view.issued_at, issued_at);
        assert_eq!(view.expires_at, issued_at + SLIDING);
        assert_eq!(view.absolute_expires_at, issued_at + ABSOLUTE);

        clock.advance(Duration::from_secs(11 * 86400));
        assert!(store.authenticate(issued.token.as_str()).is_none());
    }

    #[test]
    fn sliding_expiry_is_thirty_days_and_expired_refresh_reports_expired() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        let issued = store.create_for_test("Pixel 8");

        clock.advance(SLIDING - Duration::from_secs(1));
        assert!(store.authenticate(issued.token.as_str()).is_some());

        clock.advance(Duration::from_secs(2));
        let error = store
            .refresh_activity(&issued.id, RefreshTrigger::PageRead)
            .expect_err("expired session cannot refresh");
        assert_eq!(error.code(), "session-expired");
        assert!(store.authenticate(issued.token.as_str()).is_none());
        assert_eq!(store.active_and_reserved(), (0, 0));
    }

    #[test]
    fn refresh_moves_expiry_but_never_past_the_absolute_cap() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        let issued = store.create_for_test("Pixel 8");
        let issued_at = clock.now();

        clock.advance(Duration::from_secs(29 * 86400));
        let outcome = store
            .refresh_activity(&issued.id, RefreshTrigger::TileRead)
            .expect("refresh at day 29");
        assert_eq!(
            outcome,
            RefreshOutcome::Refreshed {
                expires_at: issued_at + Duration::from_secs(59 * 86400),
                trigger: RefreshTrigger::TileRead,
            }
        );

        clock.advance(Duration::from_secs(29 * 86400));
        let outcome = store
            .refresh_activity(&issued.id, RefreshTrigger::TileRead)
            .expect("refresh at day 58");
        assert_eq!(
            outcome,
            RefreshOutcome::Refreshed {
                expires_at: issued_at + Duration::from_secs(88 * 86400),
                trigger: RefreshTrigger::TileRead,
            }
        );

        clock.advance(Duration::from_secs(29 * 86400));
        let outcome = store
            .refresh_activity(&issued.id, RefreshTrigger::PageRead)
            .expect("refresh at day 87");
        assert_eq!(
            outcome,
            RefreshOutcome::Refreshed {
                expires_at: issued_at + ABSOLUTE,
                trigger: RefreshTrigger::PageRead,
            }
        );

        clock.advance(Duration::from_secs(3 * 86400));
        assert!(store.authenticate(issued.token.as_str()).is_none());
    }

    #[test]
    fn absolute_ninety_day_cap_cannot_be_extended() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        let issued = store.create_for_test("Pixel 8");
        let issued_at = clock.now();

        for _ in 0..100 {
            clock.advance(Duration::from_secs(86400));
            store
                .refresh_activity(&issued.id, RefreshTrigger::PageRead)
                .ok();
        }

        assert!(clock.now() >= issued_at + ABSOLUTE);
        assert!(store.authenticate(issued.token.as_str()).is_none());
        assert_eq!(store.active_and_reserved(), (0, 0));
    }

    #[test]
    fn device_limit_counts_active_and_reserved_without_eviction() {
        let clock = fake_clock();
        let store = SessionStore::new(clock);
        let mut issued = Vec::new();
        for index in 0..7 {
            issued.push(store.create_for_test(&format!("Device {index}")));
        }
        let reservation = store.reserve("Pending device").expect("eighth slot");
        assert_eq!(store.active_and_reserved(), (7, 1));

        let error = store.reserve("Ninth device").expect_err("at cap");
        assert_eq!(error.code(), "device-limit");
        assert_eq!(store.active_and_reserved(), (7, 1));

        let committed = store.commit(reservation).expect("reserved slot commits");
        assert_eq!(store.active_and_reserved(), (8, 0));
        let error = store.reserve("Ninth device").expect_err("at cap");
        assert_eq!(error.code(), "device-limit");

        for session in &issued {
            assert!(
                store.authenticate(session.token.as_str()).is_some(),
                "existing sessions must not be evicted"
            );
        }
        assert!(store.authenticate(committed.token.as_str()).is_some());
    }

    #[test]
    fn reservation_timeout_releases_the_slot_and_never_issues_a_session() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        let reservation = store.reserve("Pending").expect("reserve");
        assert_eq!(store.active_and_reserved(), (0, 1));

        clock.advance(RESERVATION_TTL);
        assert_eq!(store.active_and_reserved(), (0, 0));

        let error = store.commit(reservation).expect_err("expired reservation");
        assert_eq!(error.code(), "session-expired");
        assert_eq!(store.active_and_reserved(), (0, 0));
        assert!(store.reserve("Replacement").is_ok());
    }

    #[test]
    fn timed_out_reservation_cannot_leak_a_slot_when_full() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        for index in 0..7 {
            store.create_for_test(&format!("Device {index}"));
        }
        let stale = store.reserve("Pending").expect("eighth slot");
        clock.advance(RESERVATION_TTL);

        let fresh = store
            .reserve("Fresh pending")
            .expect("stale reservation must be purged");
        assert_eq!(store.active_and_reserved(), (7, 1));

        let error = store.commit(stale).expect_err("stale reservation");
        assert_eq!(error.code(), "session-expired");
        store.commit(fresh).expect("fresh reservation commits");
        assert_eq!(store.active_and_reserved(), (8, 0));
    }

    #[test]
    fn revoke_and_revoke_all_take_effect_immediately() {
        let store = test_session_store();
        let first = store.create_for_test("Pixel");
        let second = store.create_for_test("Tablet");
        let pending = store.reserve("Pending").expect("reserve");

        assert!(store.revoke(&first.id));
        assert!(!store.revoke(&first.id));
        assert!(!store.revoke("dev_missing"));
        assert!(store.authenticate(first.token.as_str()).is_none());
        assert!(store.authenticate(second.token.as_str()).is_some());

        store.revoke_all();
        assert!(store.authenticate(second.token.as_str()).is_none());
        assert_eq!(store.active_and_reserved(), (0, 0));
        let error = store.commit(pending).expect_err("reservation released");
        assert_eq!(error.code(), "session-expired");
    }

    #[test]
    fn release_returns_a_reserved_slot_without_issuing_a_session() {
        let store = test_session_store();
        let reservation = store.reserve("Pixel").expect("reserve");
        store.release(reservation);
        assert_eq!(store.active_and_reserved(), (0, 0));

        let replacement = store.reserve("Tablet").expect("slot is free again");
        assert_eq!(replacement.device_name, "Tablet");
    }

    #[test]
    fn commit_issues_exactly_one_token_per_reservation() {
        let clock = fake_clock();
        let store = SessionStore::new(clock.clone());
        let reservation = store.reserve("Pixel").expect("reserve");
        let id = reservation.id.clone();
        let expires_at = reservation.expires_at;
        let issued = store.commit(reservation).expect("first commit");

        let replay = Reservation {
            id,
            device_name: "Pixel".into(),
            source_ip: None,
            expires_at,
        };
        let error = store
            .commit(replay)
            .expect_err("reservation already consumed");
        assert_eq!(error.code(), "session-expired");
        assert_eq!(store.active_and_reserved(), (1, 0));
        assert!(store.authenticate(issued.token.as_str()).is_some());
    }

    #[test]
    fn device_names_are_sanitized_before_being_stored() {
        let store = test_session_store();
        let reservation = store.reserve("  Pixel\u{0} 8\u{200b}  ").expect("reserve");
        assert_eq!(reservation.device_name, "Pixel 8");
        let issued = store.commit(reservation).expect("commit");
        let view = store
            .authenticate(issued.token.as_str())
            .expect("authenticated session");
        assert_eq!(view.device_name, "Pixel 8");

        let anonymous = store.reserve("\n\t").expect("reserve");
        assert_eq!(anonymous.device_name, "Unknown device");
    }
}
