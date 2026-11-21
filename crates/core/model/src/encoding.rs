//! Bytes as base64 text, held to `packages/model`'s codec: the standard
//! alphabet, padded on write, and a strict reader.
//!
//! The reader accepts the alphabet's characters only (whitespace, the url
//! variant's `-_` and anything else are refused), padding optional but, if
//! present, completing the last quartet exactly, and refuses a lone trailing
//! character, which carries under 6 bits and names no byte. Trailing bits of
//! the final character are not required to be zero.

/// The alphabet character of a six-bit value.
fn symbol(six: u8) -> char {
    let byte = match six {
        0..=25 => six.saturating_add(b'A'),
        26..=51 => six.saturating_sub(26).saturating_add(b'a'),
        52..=61 => six.saturating_sub(52).saturating_add(b'0'),
        62 => b'+',
        _ => b'/',
    };
    char::from(byte)
}

/// Standard alphabet, padded.
pub fn bytes_to_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3).saturating_mul(4));
    for chunk in bytes.chunks(3) {
        let mut group = [0u8; 3];
        for (slot, byte) in group.iter_mut().zip(chunk) {
            *slot = *byte;
        }
        let [a, b, c] = group;
        let word = u32::from_be_bytes([0, a, b, c]);
        // A chunk of n bytes fills n + 1 sextets; the rest is padding.
        let filled = chunk.len().saturating_add(1);
        for (index, shift) in [18u32, 12, 6, 0].into_iter().enumerate() {
            if index < filled {
                let [.., six] = ((word >> shift) & 0x3f).to_be_bytes();
                out.push(symbol(six));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn value_of(byte: u8) -> Option<u32> {
    let value = match byte {
        b'A'..=b'Z' => byte.saturating_sub(b'A'),
        b'a'..=b'z' => byte.saturating_sub(b'a').saturating_add(26),
        b'0'..=b'9' => byte.saturating_sub(b'0').saturating_add(52),
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };
    Some(u32::from(value))
}

/// Standard alphabet, padded or not. `None` when `text` is not base64.
pub fn base64_to_bytes(text: &str) -> Option<Vec<u8>> {
    let all = text.as_bytes();
    let body = all.strip_suffix(b"==").or_else(|| all.strip_suffix(b"=")).unwrap_or(all);
    let padding = all.len().saturating_sub(body.len());
    if body.len() % 4 == 1 || (padding > 0 && !body.len().saturating_add(padding).is_multiple_of(4))
    {
        return None;
    }
    let mut out = Vec::with_capacity(body.len().saturating_mul(3) / 4);
    for quartet in body.chunks(4) {
        let mut word = 0u32;
        // A short final quartet is read as if padded with zero sextets.
        for position in 0..4 {
            let sextet = quartet.get(position).map_or(Some(0), |byte| value_of(*byte))?;
            word = word.saturating_mul(64).saturating_add(sextet);
        }
        let [_, first, second, third] = word.to_be_bytes();
        out.extend([first, second, third].into_iter().take(quartet.len().saturating_mul(6) / 8));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{base64_to_bytes, bytes_to_base64};

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn it_encodes_the_rfc_4648_section_10_vectors_padded() {
        let encode = |text: &str| bytes_to_base64(text.as_bytes());
        assert_eq!(encode(""), "");
        assert_eq!(encode("f"), "Zg==");
        assert_eq!(encode("fo"), "Zm8=");
        assert_eq!(encode("foo"), "Zm9v");
        assert_eq!(encode("foob"), "Zm9vYg==");
        assert_eq!(encode("fooba"), "Zm9vYmE=");
        assert_eq!(encode("foobar"), "Zm9vYmFy");
    }

    #[test]
    fn it_writes_every_alphabet_specific_character() {
        assert_eq!(bytes_to_base64(&[0xfb, 0xff, 0xbe]), "+/++");
        assert_eq!(bytes_to_base64(&[0xfb, 0xff]), "+/8=");
        assert_eq!(bytes_to_base64(&[0x00, 0x10, 0x83]), "ABCD");
        assert_eq!(bytes_to_base64(&[0xd3, 0x5d, 0xb7]), "0123");
    }

    #[test]
    fn it_reads_the_standard_variant_padded_or_unpadded() {
        assert_eq!(base64_to_bytes("Zm8="), Some(vec![0x66, 0x6f]));
        assert_eq!(base64_to_bytes("Zm8"), Some(vec![0x66, 0x6f]));
        assert_eq!(base64_to_bytes("Zg=="), Some(vec![0x66]));
        assert_eq!(base64_to_bytes("Zg"), Some(vec![0x66]));
        assert_eq!(base64_to_bytes("Zm9v"), Some(b"foo".to_vec()));
        assert_eq!(base64_to_bytes("Zm9vYmFy"), Some(b"foobar".to_vec()));
    }

    #[test]
    fn it_reads_every_alphabet_character_to_its_value() {
        assert_eq!(base64_to_bytes("+/++"), Some(vec![0xfb, 0xff, 0xbe]));
        assert_eq!(base64_to_bytes("ABCD"), Some(vec![0x00, 0x10, 0x83]));
        assert_eq!(base64_to_bytes("0123"), Some(vec![0xd3, 0x5d, 0xb7]));
        assert_eq!(base64_to_bytes("wxyz"), Some(vec![0xc3, 0x1c, 0xb3]));
        assert_eq!(base64_to_bytes("WXYZ"), Some(vec![0x59, 0x76, 0x19]));
        assert_eq!(base64_to_bytes("9/+8"), Some(vec![0xf7, 0xff, 0xbc]));
    }

    #[test]
    fn it_reads_the_empty_string_as_no_bytes() {
        assert_eq!(base64_to_bytes(""), Some(Vec::new()));
    }

    #[test]
    fn it_answers_none_for_text_that_is_not_base64() {
        for bad in [
            "Z", "Zm9vY", "Zm=8", "Zm8==", "Zg=", "=", "Zm 8", " Zg==", "Zm8\n", "Zm8!", "====",
            "Zg===", "-_--", "Zm8_", "@@@@", "[[[[", "``", "{",
        ] {
            assert_eq!(base64_to_bytes(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn it_does_not_require_trailing_bits_to_be_zero() {
        assert_eq!(base64_to_bytes("Zh=="), Some(vec![0x66]));
    }

    #[test]
    fn it_round_trips_every_length_and_byte_value() {
        let all: Vec<u8> = (0..=255u8).collect();
        for len in 0..=all.len() {
            let bytes = &all[..len];
            assert_eq!(base64_to_bytes(&bytes_to_base64(bytes)).as_deref(), Some(bytes), "{len}");
        }
    }
}
