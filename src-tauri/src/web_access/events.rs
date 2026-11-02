//! Tauri event sink for D1b. This is the only place the runtime touches a
//! Tauri `AppHandle`; the runtime itself is testable without the desktop
//! runtime. Event payloads contain no pairing id, claim secret, hash, or token.

use tauri::{AppHandle, Emitter};

use super::runtime::{
    PairingEventView, WebAccessEventSink, WebAccessStatusView, PAIRING_EVENT, STATE_EVENT,
};

pub(crate) struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl WebAccessEventSink for TauriEventSink {
    fn emit_state(&self, status: &WebAccessStatusView) {
        // Defense in depth: the remote-content browser window must never
        // receive claim ids/device names. Only the main settings window needs
        // these wake-up events.
        let _ = self.app.emit_to("main", STATE_EVENT, status.clone());
    }

    fn emit_pairing(&self, event: &PairingEventView) {
        let _ = self.app.emit_to("main", PAIRING_EVENT, event.clone());
    }
}
