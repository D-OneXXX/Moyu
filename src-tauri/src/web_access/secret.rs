//! Shared credential primitives for the pairing/session state machines.
//!
//! Nothing here logs, formats, or stores plaintext secrets. Callers keep
//! generated strings in [`Zeroizing`] and persist only SHA-256 digests.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

const MAX_DEVICE_NAME_SCALARS: usize = 64;
const UNKNOWN_DEVICE: &str = "Unknown device";
const CLAIM_NONCE_BYTES: usize = 16;

pub(crate) fn random_b64(bytes: usize) -> Zeroizing<String> {
    let mut raw = Zeroizing::new(vec![0u8; bytes]);
    OsRng.fill_bytes(raw.as_mut_slice());
    Zeroizing::new(URL_SAFE_NO_PAD.encode(raw.as_slice()))
}

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut raw = Zeroizing::new(vec![0u8; bytes]);
    OsRng.fill_bytes(raw.as_mut_slice());
    hex::encode(raw.as_slice())
}

pub(crate) fn sha256_bytes(value: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher.finalize().into()
}

/// Compares equal-length digests without an early exit. Credential digests are
/// always 32 bytes, so the length check never leaks secret content.
pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    bool::from(left.ct_eq(right))
}

fn is_zero_width(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD
            | 0x061C
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0xE0000..=0xE007F
    )
}

/// Keeps at most 64 visible Unicode scalars, stripping C0/C1 controls and
/// zero-width/bidi formatting characters. Empty input falls back to a neutral
/// sentinel; the desktop localizes it for display.
pub(crate) fn sanitize_device_name(raw: &str) -> String {
    let mut sanitized = String::new();
    let mut scalars = 0usize;
    for c in raw.chars() {
        if c.is_control() || is_zero_width(c) {
            continue;
        }
        if scalars == MAX_DEVICE_NAME_SCALARS {
            break;
        }
        sanitized.push(c);
        scalars += 1;
    }
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        UNKNOWN_DEVICE.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Client-generated idempotency nonce: base64url without padding, 16 random
/// bytes (22 characters). It is never authorization.
pub(crate) fn is_valid_claim_nonce(raw: &str) -> bool {
    if raw.len() != 22 {
        return false;
    }
    URL_SAFE_NO_PAD
        .decode(raw)
        .map(|decoded| decoded.len() == CLAIM_NONCE_BYTES)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_values_have_frozen_lengths_and_alphabets() {
        let secret = random_b64(32);
        assert_eq!(secret.len(), 43);
        assert!(!secret.contains('='));
        assert!(secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));

        assert_eq!(random_hex(16).len(), 32);
        assert!(random_hex(16).chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn nonce_validation_accepts_only_22_char_base64url_of_16_bytes() {
        assert!(is_valid_claim_nonce(&random_b64(16)));
        assert!(!is_valid_claim_nonce(""));
        assert!(!is_valid_claim_nonce("AAAAAAAAAAAAAAAAAAAAAA=="));
        assert!(!is_valid_claim_nonce(&"A".repeat(21)));
        assert!(!is_valid_claim_nonce(&"!".repeat(22)));
    }

    #[test]
    fn device_name_is_bounded_and_strips_controls_and_zero_width() {
        assert_eq!(sanitize_device_name("  Pixel 8  "), "Pixel 8");
        assert_eq!(
            sanitize_device_name("\u{0}\u{200b}\u{feff}"),
            "Unknown device"
        );
        assert_eq!(sanitize_device_name("\n\t"), "Unknown device");

        let long = "界".repeat(100);
        assert_eq!(sanitize_device_name(&long).chars().count(), 64);

        let mixed = "A\u{0}B\u{200b}C\u{202e}D\u{00ad}E\u{061c}F";
        assert_eq!(sanitize_device_name(mixed), "ABCDEF");
    }

    #[test]
    fn constant_time_compare_matches_and_rejects() {
        assert!(constant_time_eq(&[1, 2, 3], &[1, 2, 3]));
        assert!(!constant_time_eq(&[1, 2, 3], &[1, 2, 4]));
        assert!(!constant_time_eq(&[1, 2], &[1, 2, 3]));
    }
}
