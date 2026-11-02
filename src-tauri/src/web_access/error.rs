use std::net::Ipv4Addr;

use thiserror::Error;

use crate::ca::CaError;

#[derive(Debug, Error)]
pub enum WebAccessError {
    #[error("CA error: {0}")]
    Ca(#[from] CaError),
    #[error("no private LAN IPv4 address available")]
    NoLanAddress,
    #[error("too many private LAN IPv4 addresses (maximum 8)")]
    TooManyLanAddresses,
    #[error("invalid private LAN IPv4 SAN: {0}")]
    InvalidSan(Ipv4Addr),
    #[error("TLS bind address must be IPv4")]
    InvalidBindAddress,
    #[error("TLS configuration failed: {0}")]
    TlsConfig(String),
    #[error("TLS server I/O failed")]
    Io(#[from] std::io::Error),
    #[error("TLS server task failed")]
    ServerJoin,
    #[error("TLS serving certificate requires an explicit root-rotation reload")]
    RootChangePending,
    #[error("TLS root-rotation reload fingerprint does not match the active root")]
    RootChangeMismatch,
    #[error("TLS previous certificate is not available for rollback")]
    RollbackUnavailable,
    #[error("TLS listener has stopped after certificate expiry")]
    CertificateExpired,
}

impl WebAccessError {
    /// Stable code for future command/UI localization. CA failures keep the
    /// underlying CA code so callers do not lose the precise cause.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ca(err) => err.code(),
            Self::NoLanAddress => "web-access-no-lan-address",
            Self::TooManyLanAddresses => "web-access-too-many-lan-addresses",
            Self::InvalidSan(_) => "web-access-invalid-san",
            Self::InvalidBindAddress => "web-access-invalid-bind",
            Self::TlsConfig(_) => "web-access-tls-config",
            Self::Io(_) => "web-access-io",
            Self::ServerJoin => "web-access-server-join",
            Self::RootChangePending => "web-access-root-change-pending",
            Self::RootChangeMismatch => "web-access-root-change-mismatch",
            Self::RollbackUnavailable => "web-access-rollback-unavailable",
            Self::CertificateExpired => "web-access-certificate-expired",
        }
    }
}

pub type WebAccessResult<T> = Result<T, WebAccessError>;
