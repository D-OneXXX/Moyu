//! W7-TLS transport slice.
//!
//! This module provides a real TLS listener backed by the local CA. It is
//! deliberately **not** wired into Tauri startup, commands, UI, pairing,
//! sessions, or data routes: the only served endpoint is a public health
//! check. The listener is created explicitly by calling
//! [`start_tls_server`] and must be shut down explicitly.

mod addrs;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod auth;
mod ca_distribution;
pub(crate) mod ca_distribution_commands;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod clock;
mod error;
mod http;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod pairing;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod secret;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod session;
#[cfg(test)]
mod test_http;
mod tls;
#[cfg_attr(not(test), allow(dead_code))]
mod tls_renewal;

pub use addrs::{is_private_lan_ipv4, local_private_ipv4s, select_san_ips};
pub use error::{WebAccessError, WebAccessResult};
pub use tls::{start_tls_server, TlsServerConfig, TlsServerHandle};
pub use tls_renewal::{TlsCertificateSnapshot, TlsCertificateState};
pub(crate) use tls_renewal::TlsRenewalPolicy;

pub(crate) use ca_distribution::CaDistributionRuntime;

#[cfg(test)]
mod tests;
