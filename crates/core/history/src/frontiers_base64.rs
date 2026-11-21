//! Frontiers as text.
//!
//! A saved version is a frontier of the workspace record, and both keepers
//! store one as base64. The bytes are the engine's encoded frontiers and stay
//! opaque here: encoding a frontier and decoding it again belong to whoever
//! holds the engine.

use whiteboard_model::encoding::{base64_to_bytes, bytes_to_base64};

/// What `frontiers_from_base64` refuses: text that is not base64.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrontiersNotBase64;

impl std::fmt::Display for FrontiersNotBase64 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("frontiers are not base64")
    }
}

impl std::error::Error for FrontiersNotBase64 {}

pub fn frontiers_to_base64(encoded: &[u8]) -> String {
    bytes_to_base64(encoded)
}

/// The bytes `text` spells; callers name the location the text came from.
pub fn frontiers_from_base64(text: &str) -> Result<Vec<u8>, FrontiersNotBase64> {
    base64_to_bytes(text).ok_or(FrontiersNotBase64)
}

#[cfg(test)]
mod tests {
    use super::{FrontiersNotBase64, frontiers_from_base64, frontiers_to_base64};

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn it_hands_back_exactly_the_bytes_it_was_given_whatever_they_hold() {
        let opaque = [0u8, 255, 1, 254, 7];
        assert_eq!(frontiers_from_base64(&frontiers_to_base64(&opaque)), Ok(opaque.to_vec()));
    }

    #[test]
    fn it_refuses_text_that_is_not_base64_naming_what_it_was_reading() {
        assert_eq!(frontiers_from_base64("not base64!"), Err(FrontiersNotBase64));
        assert_eq!(FrontiersNotBase64.to_string(), "frontiers are not base64");
    }

    #[test]
    fn it_reads_the_text_a_buffer_writing_keeper_stored() {
        assert_eq!(frontiers_to_base64(&[1, 1, 0]), "AQEA");
        assert_eq!(frontiers_from_base64("AQEA"), Ok(vec![1, 1, 0]));
    }
}
