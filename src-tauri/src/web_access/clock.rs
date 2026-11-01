//! Monotonic clock used by the in-memory pairing/session state machines.
//!
//! Wall-clock time is never used for TTL or refresh decisions. Production
//! wiring (D1b) will inject [`SystemClock`]; D1a tests inject a fake clock.

use std::time::Instant;

pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// Reserved for the D1b control plane; D1a only exercises the fake clock.
#[allow(dead_code)]
pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::Clock;

    pub(crate) struct FakeClock {
        now: Mutex<Instant>,
    }

    impl FakeClock {
        pub(crate) fn new() -> Self {
            Self {
                now: Mutex::new(Instant::now()),
            }
        }

        pub(crate) fn shared() -> Arc<Self> {
            Arc::new(Self::new())
        }

        pub(crate) fn advance(&self, by: Duration) {
            let mut now = self.now.lock().unwrap_or_else(|err| err.into_inner());
            *now += by;
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            *self.now.lock().unwrap_or_else(|err| err.into_inner())
        }
    }
}
