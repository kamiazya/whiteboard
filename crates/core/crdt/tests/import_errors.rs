//! What a refused import says: loro's own words, passed through unchanged.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ImportError, import_bytes};

#[test]
fn bytes_loro_does_not_recognise_are_refused_in_its_words() {
    let Err(error) = import_bytes(b"not a loro document") else {
        panic!("garbage imported");
    };
    assert!(!error.0.is_empty());
    assert_eq!(error.to_string(), error.0);
}

#[test]
fn an_import_error_displays_exactly_its_message() {
    assert_eq!(ImportError("checksum mismatch".to_owned()).to_string(), "checksum mismatch");
}
