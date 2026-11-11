//! The canonical number and href formatting against the TypeScript's
//! `formatCoord` and `sanitizeHref`.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::svg::{NonFinite, format_coord, sanitize_href};

#[test]
fn a_coordinate_has_three_places_trailing_zeros_stripped_and_no_negative_zero() {
    let cases: [(f64, &str); 14] = [
        (0.0, "0"),
        (-0.0, "0"),
        (0.0004, "0"),
        (-0.0004, "0"),
        (0.0005, "0.001"),
        (1.0005, "1"),
        (1.2345, "1.234"),
        (100.0, "100"),
        (1e21, "1e+21"),
        (-1e21, "-1e+21"),
        (123_456.789_1, "123456.789"),
        (-2.5, "-2.5"),
        (0.0625, "0.063"),
        (1e-7, "0"),
    ];
    for (value, text) in cases {
        assert_eq!(format_coord(value), Ok(text.to_string()), "{value}");
    }
}

#[test]
fn a_value_that_is_not_a_finite_number_is_refused() {
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(matches!(format_coord(value), Err(NonFinite(_))), "{value}");
    }
}

#[test]
fn an_href_keeps_a_relative_link_or_an_allowed_scheme_and_degrades_the_rest_to_a_hash() {
    let cases: [(&str, &str); 21] = [
        ("http://a", "http://a"),
        ("HTTPS://a", "HTTPS://a"),
        ("mailto:x", "mailto:x"),
        ("tel:1", "tel:1"),
        ("javascript:alert(1)", "#"),
        ("\tjavascript:x", "#"),
        ("java\nscript:x", "#"),
        ("//host/x", "#"),
        ("\\\\host", "#"),
        ("/\\host", "#"),
        ("rel/path", "rel/path"),
        ("#frag", "#frag"),
        ("data:text/html,x", "#"),
        ("a:b", "#"),
        ("1a:b", "1a:b"),
        ("a b:c", "a b:c"),
        (" http://x", " http://x"),
        ("java\u{85}script:x", "#"),
        ("", ""),
        (":x", ":x"),
        ("/x", "/x"),
    ];
    for (href, text) in cases {
        assert_eq!(sanitize_href(href), text, "{href:?}");
    }
}

#[test]
fn an_href_is_returned_without_the_characters_xml_cannot_carry() {
    assert_eq!(sanitize_href("http://a\u{0}b"), "http://ab");
    assert_eq!(sanitize_href("a\u{1}b"), "ab");
    assert_eq!(sanitize_href("/\u{8}/host"), "#");
    assert_eq!(sanitize_href("\u{1F}\u{20}javascript:x"), "#");
}
