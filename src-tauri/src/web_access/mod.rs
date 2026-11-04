//! W7 Web Access.
//!
//! This module provides the local CA/leaf TLS listener, G1 root-CA
//! distribution, the in-memory pairing/session state machines, and the D1b
//! control plane. The production router is mounted only by
//! [`WebAccessRuntime`], which starts `Disabled` and listens only after an
//! explicit Tauri command. The router stays pair-only until a
//! [`data::WebDataAccess`] provider is injected; until then every data path is
//! 404. Callers that still use [`start_tls_server`] directly get the
//! health-only listener.

mod addrs;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod auth;
mod ca_distribution;
pub(crate) mod ca_distribution_commands;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod clock;
pub(crate) mod data;
pub(crate) mod data_app;
mod error;
mod events;
mod http;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod pairing;
pub(crate) mod progress_write;
pub(crate) mod progress_write_app;
mod reader_http;
mod router;
mod runtime;
pub(crate) use data_app::AppData;
pub(crate) use events::TauriEventSink;
pub(crate) use progress_write_app::AppProgress;
pub(crate) use runtime::{StopReason, WebAccessRuntime};
pub(crate) mod commands;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod secret;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod session;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod session_auth;
mod session_http;
#[cfg(test)]
mod test_http;
mod tls;
mod tls_renewal;

pub use addrs::{is_private_lan_ipv4, local_private_ipv4s, select_san_ips};
pub use error::{WebAccessError, WebAccessResult};
pub use tls::{start_tls_server, TlsServerConfig, TlsServerHandle};
#[cfg(test)]
pub(crate) use tls_renewal::TlsRenewalPolicy;
pub use tls_renewal::{TlsCertificateSnapshot, TlsCertificateState};

pub(crate) use ca_distribution::CaDistributionRuntime;

#[cfg(test)]
mod data_tests;
#[cfg(test)]
mod tests;
