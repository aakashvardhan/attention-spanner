//! Base64 (RFC 4648): the vault's standard alphabet and OAuth's URL-safe one.

pub(crate) const STANDARD: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub(crate) const URL_SAFE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// `bytes` in `alphabet`, `=`-padded to a multiple of four when `pad`.
pub(crate) fn encode(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(alphabet[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

/// Standard base64 decoded as `atob` does (the WHATWG forgiving decode):
/// ASCII whitespace ignored, at most two `=` and only to fill the last group,
/// and `None` for a length no encoder writes or any other character.
pub(crate) fn decode(s: &str) -> Option<Vec<u8>> {
    let mut s: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if s.len().is_multiple_of(4) {
        for _ in 0..2 {
            if s.last() == Some(&b'=') {
                s.pop();
            }
        }
    }
    if s.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s {
        acc = acc << 6 | STANDARD.iter().position(|&x| x == c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_rejects_what_atob_rejects() {
        assert_eq!(decode("Zm8=").as_deref(), Some(&b"fo"[..]));
        assert_eq!(
            decode("Zm8").as_deref(),
            Some(&b"fo"[..]),
            "padding is optional"
        );
        assert_eq!(decode(" Zm9v\n").as_deref(), Some(&b"foo"[..]));
        assert_eq!(decode("Z"), None, "a lone sixth of a byte");
        assert_eq!(decode("Zm9vZ"), None);
        assert_eq!(decode("Zg==="), None, "three pads");
        assert_eq!(decode("Zm8=="), None, "a pad beyond the group");
        assert_eq!(decode("Zg=a"), None, "a pad in the middle");
        assert_eq!(decode("Zm-_"), None, "URL-safe letters");
        assert_eq!(decode("").as_deref(), Some(&b""[..]));
    }
}
