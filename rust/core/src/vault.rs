//! The brain-dump vault's encodings. The
//! cryptography itself is WebCrypto, in the extension; these are the bits
//! around it that must match the TypeScript exactly, or old vaults won't open.

use serde::{Deserialize, Serialize};

pub const PBKDF2_ITERATIONS: u32 = 600_000;
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// AES-GCM ciphertext, base64; `salt` when the key came from a secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sealed {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    pub iv: String,
    pub data: String,
}

/// Anyone can seal with the public key; the private key opens only with a secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub public_key: serde_json::Value,
    pub by_passphrase: Sealed,
    pub by_recovery: Sealed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedDump {
    pub id: String,
    pub created_at: i64,
    pub wrapped_key: String,
    pub iv: String,
    pub data: String,
}

/// A brain dump parked in the clear before first-time setup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dump {
    pub id: String,
    pub text: String,
    pub created_at: i64,
}

/// What a locked dump holds. Field order is the JSON order the TS sealed
/// (`JSON.stringify` keeps insertion order); serde writes fields in order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpEntry {
    pub text: String,
    pub bullets: Vec<String>,
    pub created_at: i64,
}

/// Standard base64 with padding (what `btoa` writes).
pub fn b64(bytes: &[u8]) -> String {
    crate::base64::encode(bytes, crate::base64::STANDARD, true)
}

/// The inverse of `b64`, as strict as `atob`: `None` for anything it rejects.
pub fn unb64(s: &str) -> Option<Vec<u8>> {
    crate::base64::decode(s)
}

/// Uppercase, no spaces or dashes, 0/1/8 read as O/I/B: however it was typed.
pub fn normalize_recovery_code(input: &str) -> String {
    input
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c {
            '0' => 'O',
            '1' => 'I',
            '8' => 'B',
            c => c,
        })
        .collect()
}

/// 26 random bytes → 130 bits as base32, grouped in fours for writing down.
pub fn recovery_code(random: &[u8; 26]) -> String {
    let chars: Vec<char> = random
        .iter()
        .map(|b| BASE32[(b & 31) as usize] as char)
        .collect();
    chars
        .chunks(4)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_btoa_and_round_trips() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(&[251, 255, 254]), "+//+");
        for n in 0..40u8 {
            let bytes: Vec<u8> = (0..n).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(unb64(&b64(&bytes)).unwrap(), bytes);
        }
        assert_eq!(unb64("not base64!"), None);
        // What atob rejects: a length no encoder writes, a pad too many.
        assert_eq!(unb64("Zm9vY"), None);
        assert_eq!(unb64("Zm8=="), None);
    }

    #[test]
    fn recovery_codes_normalise_however_typed() {
        let code = recovery_code(&[
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
            24, 25,
        ]);
        assert_eq!(code, "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ");
        assert_eq!(
            normalize_recovery_code("abcd efgh-ijk1-0p8"),
            "ABCDEFGHIJKIOPB"
        );
        assert_eq!(normalize_recovery_code(&code), "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    }

    #[test]
    fn an_entry_serialises_in_the_order_the_ts_sealed() {
        let e = DumpEntry {
            text: "t".into(),
            bullets: vec!["b".into()],
            created_at: 1,
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"text":"t","bullets":["b"],"createdAt":1}"#
        );
    }
}
