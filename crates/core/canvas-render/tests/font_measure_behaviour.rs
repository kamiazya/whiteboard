//! How a [`FontTableMeasurer`] chooses a face and degrades, and the numbers of
//! the Roboto face the contract names (`measure-text-conformance.ts`): Hamburgefonstiv
//! at 16 px is 123.5 in Regular, and the hhea table is 1900, -500 and 0 in 2048
//! units. These are the face's design-unit sums, not another measurer's output.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::constant_ratio::{
    ConstantRatioMeasure, estimate_advance, is_full_width_code_point,
};
use whiteboard_canvas_render::font_measure::{FontError, FontTableMeasurer};
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure};

const REGULAR: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Regular.ttf");
const BOLD: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Bold.ttf");
const ITALIC: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Italic.ttf");

/// Bit equality, so `-0` and a NaN are told apart and no tolerance hides a drift.
fn same(got: f64, want: f64) {
    assert_eq!(got.to_bits(), want.to_bits(), "{got} against {want}");
}

const SAMPLE: &str = "Hamburgefonstiv";

fn font(family: &str, weight: f64, style: FontStyle, size_px: f64) -> FontDescriptor {
    FontDescriptor {
        family: family.to_owned(),
        fallback_chain: vec!["Roboto".to_owned()],
        weight,
        style,
        size_px,
    }
}

fn regular(size_px: f64) -> FontDescriptor {
    font("Roboto", 400.0, FontStyle::Normal, size_px)
}

type Built = Result<FontTableMeasurer<'static>, FontError>;

fn full() -> Built {
    FontTableMeasurer::new()
        .with_face("Roboto", false, FontStyle::Normal, REGULAR)?
        .with_face("Roboto", true, FontStyle::Normal, BOLD)?
        .with_face("Roboto", false, FontStyle::Italic, ITALIC)
}

fn two(first: &str, second: &str, data: &'static [u8]) -> Built {
    FontTableMeasurer::new().with_face(first, false, FontStyle::Normal, REGULAR)?.with_face(
        second,
        false,
        FontStyle::Normal,
        data,
    )
}

/// A measurer, or a failed test: the faces are read from the repo, so a parse
/// failure is the test's own setup breaking.
macro_rules! built {
    ($built:expr) => {
        match $built {
            Ok(m) => m,
            Err(e) => panic!("the vendored faces do not parse: {e}"),
        }
    };
}

#[test]
fn the_regular_face_sums_its_design_advances() {
    let m = built!(full());
    same(m.advance_width(SAMPLE, &regular(16.0)), 123.5);
    same(m.advance_width("AVATAR", &regular(16.0)), 60.906_25);
}

#[test]
fn the_weight_and_style_pick_the_face_at_the_css_boundary() {
    let m = built!(full());
    let at = |weight, style| m.advance_width(SAMPLE, &font("Roboto", weight, style, 16.0));
    same(at(700.0, FontStyle::Normal), 125.062_5);
    same(at(600.0, FontStyle::Normal), 125.062_5);
    same(at(599.9, FontStyle::Normal), 123.5);
    same(at(400.0, FontStyle::Italic), 119.796_875);
    same(at(f64::NAN, FontStyle::Normal), 123.5);
}

#[test]
fn a_missing_sibling_face_is_measured_in_regular() {
    let m = built!(full());
    let bold_italic = font("Roboto", 700.0, FontStyle::Italic, 16.0);
    same(m.advance_width(SAMPLE, &bold_italic), 123.5);
}

#[test]
fn a_family_nothing_holds_is_measured_in_the_first_family_added() {
    let m = built!(two("Roboto", "Other", BOLD));
    let unknown = font("Inter", 400.0, FontStyle::Normal, 16.0);
    same(m.advance_width(SAMPLE, &unknown), 123.5);
    let named = font("Other", 400.0, FontStyle::Normal, 16.0);
    same(m.advance_width(SAMPLE, &named), 125.062_5);
}

#[test]
fn a_face_added_twice_to_one_slot_is_replaced() {
    let m = built!(two("Roboto", "Roboto", BOLD));
    same(m.advance_width(SAMPLE, &regular(16.0)), 125.062_5);
}

#[test]
fn the_descriptors_fallback_chain_is_not_consulted() {
    let m = built!(two("Roboto", "Other", BOLD));
    let mut chained = font("Inter", 400.0, FontStyle::Normal, 16.0);
    chained.fallback_chain = vec!["Other".to_owned()];
    same(m.advance_width(SAMPLE, &chained), 123.5);
}

#[test]
fn the_vertical_metrics_are_the_hhea_table_scaled() {
    let got = built!(full()).vertical_metrics(&regular(16.0));
    let scale = 16.0 / 2048.0;
    same(got.ascent, 1900.0 * scale);
    same(got.descent, 500.0 * scale);
    same(got.line_gap, 0.0);
}

#[test]
fn a_glyph_the_face_lacks_is_estimated_not_measured() {
    let m = built!(full());
    same(m.advance_width("日", &regular(16.0)), 16.0);
    same(m.advance_width("a日", &regular(10.0)), m.advance_width("a", &regular(10.0)) + 10.0);
    same(m.advance_width("\u{FE0F}", &regular(10.0)), 0.55 * 10.0);
}

#[test]
fn an_unusable_size_or_an_empty_text_measures_nothing() {
    let m = built!(full());
    for size in [0.0, -16.0, f64::NAN, f64::INFINITY] {
        same(m.advance_width(SAMPLE, &regular(size)), 0.0);
        let v = m.vertical_metrics(&regular(size));
        assert_eq!((v.ascent, v.descent, v.line_gap), (0.0, 0.0, 0.0), "size {size}");
    }
    same(m.advance_width("", &regular(16.0)), 0.0);
}

#[test]
fn bytes_that_are_not_a_font_are_refused() {
    let refused = FontTableMeasurer::new().with_face("Roboto", false, FontStyle::Normal, b"nope");
    assert_eq!(refused.err(), Some(FontError));
    assert_eq!(FontError.to_string(), "the bytes are not a font this measurer can read");
}

#[test]
fn with_no_face_it_answers_as_the_estimator_does() {
    let m = FontTableMeasurer::new();
    let f = regular(12.0);
    same(m.advance_width("hi 日", &f), ConstantRatioMeasure.advance_width("hi 日", &f));
    assert_eq!(m.vertical_metrics(&f), ConstantRatioMeasure.vertical_metrics(&f));
    same(m.advance_width("hi", &f), 2.0 * 0.55 * 12.0);
}

#[test]
fn the_estimator_charges_a_wide_code_point_an_em_and_the_rest_a_ratio() {
    same(estimate_advance("日", 10.0), 10.0);
    same(estimate_advance("a", 10.0), 5.5);
    same(estimate_advance("a", -1.0), 0.0);
    let v = ConstantRatioMeasure.vertical_metrics(&regular(8.0));
    assert_eq!((v.ascent, v.descent, v.line_gap), (6.0, 2.0, 0.8));
}

#[test]
fn the_wide_ranges_stop_exactly_at_their_edges() {
    let inside = [
        0x1100, 0x115f, 0x3000, 0x303f, 0x3040, 0x30ff, 0x3400, 0x4dbf, 0x4e00, 0x9fff, 0xac00,
        0xd7a3, 0xf900, 0xfaff, 0xff00, 0xff60, 0x1f300, 0x1faff,
    ];
    let outside = [
        0x61, 0x10ff, 0x1160, 0x2fff, 0x3100, 0x33ff, 0x4dc0, 0x4dff, 0xa000, 0xabff, 0xd7a4,
        0xf8ff, 0xfb00, 0xfeff, 0xff61, 0x1f2ff, 0x1fb00,
    ];
    for code in inside {
        assert!(is_full_width_code_point(code), "{code:x}");
    }
    for code in outside {
        assert!(!is_full_width_code_point(code), "{code:x}");
    }
}
