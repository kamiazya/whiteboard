//! The canonical number and href formatting against the TypeScript's
//! `formatCoord` and `sanitizeHref`.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::svg::{NonFinite, format_coord, sanitize_href};
use whiteboard_det::format::js_to_fixed;
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert_eq, prop_oneof};
use whiteboard_proptest::{Floor, check};

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

/// The canonical form restated over `js_to_fixed`, the exact `toFixed`: what
/// every coordinate is written as, whichever path writes it.
fn canonical(value: f64) -> String {
    let fixed = js_to_fixed(value, 3);
    let stripped = if fixed.contains('.') {
        fixed.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        fixed
    };
    if stripped == "-0" { "0".to_string() } else { stripped }
}

/// 2^53: past it a double holds only every other integer.
const TWO_53: f64 = 9_007_199_254_740_992.0;

/// `2^p`, exactly.
fn power_of_two(p: u32) -> f64 {
    (0..p).fold(1.0, |value, _| value * 2.0)
}

/// Doubles dense in whole numbers of every magnitude up to past 1e21 (where
/// `toFixed` turns exponential), their negations and neighbours, and
/// arbitrary finite values.
fn coordinate() -> impl Strategy<Value = f64> {
    prop_oneof![
        (-100_000_i32..100_000).prop_map(f64::from),
        (0_u32..80, prop::bool::ANY).prop_map(|(p, neg)| {
            let v = power_of_two(p);
            if neg { -v } else { v }
        }),
        (0_u32..80, -2_i32..=2).prop_map(|(p, d)| power_of_two(p) + f64::from(d)),
        (-1e6_f64..1e6).prop_map(|v| (v * 8.0).round() / 8.0),
        prop::num::f64::NORMAL | prop::num::f64::SUBNORMAL | prop::num::f64::ZERO,
    ]
}

#[test]
fn a_coordinate_is_written_as_its_exact_to_fixed_whatever_path_writes_it() {
    let whole = Floor::new("a whole number below 2^53");
    let beyond = Floor::new("a whole number at or past 2^53");
    let fraction = Floor::new("a number with a fraction");
    check(coordinate(), Some(1000), |value| {
        let integral = value.trunc().to_bits() == value.to_bits();
        whole.draw(integral && value.abs() < TWO_53);
        beyond.draw(integral && value.abs() >= TWO_53);
        fraction.draw(!integral);
        prop_assert_eq!(format_coord(value), Ok(canonical(value)), "{}", value);
        Ok(())
    });
    whole.assert(300);
    beyond.assert(50);
    fraction.assert(100);
}
