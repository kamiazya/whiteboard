//! `url_can_parse` is `URL.canParse` for the stored node resource a link
//! shows: the cases a location is refused or kept on.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_codec::json_canvas::url_can_parse;

#[test]
fn a_location_with_a_scheme_and_a_host_parses() {
    assert!(url_can_parse("https://example.com/a?b#c"));
    assert!(url_can_parse(" mailto:someone@example.com "));
}

#[test]
fn a_location_with_no_scheme_or_no_host_does_not() {
    assert!(!url_can_parse("example.com/a"));
    assert!(!url_can_parse("https://"));
    assert!(!url_can_parse(""));
}
