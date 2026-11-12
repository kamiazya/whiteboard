//! What a measurer owes its callers, stated without its arithmetic: the
//! conformance contract of `describeMeasureTextConformance`. The advance of a
//! concatenation is the sum of the parts within a hundredth of a pixel (no
//! kerning at the seam), it never shrinks as text is appended, and it is linear
//! in the size. The alphabet mixes letters the face carries, a kerning-pair
//! pair, and code points it lacks, so the estimator is on the path too; it
//! holds no combining mark, whose `ccmp` substitution is the one place
//! opentype.js, and so the oracle, is not a per-glyph sum.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::font_measure::{FontError, FontTableMeasurer};
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure};
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert, prop_oneof};
use whiteboard_proptest::{Floor, check};

const ADVANCE_TOLERANCE_PX: f64 = 0.01;

const REGULAR: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Regular.ttf");
const BOLD: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Bold.ttf");

const CARRIED: &[char] = &['A', 'V', 'T', 'o', 'f', 'i', ' ', '.', 'é', 'Ж', 'α'];
const LACKED: &[char] = &['日', 'あ', '😀', '한', '\u{FE0F}'];

fn measurer() -> Result<FontTableMeasurer<'static>, FontError> {
    FontTableMeasurer::new().with_face("Roboto", false, FontStyle::Normal, REGULAR)?.with_face(
        "Roboto",
        true,
        FontStyle::Normal,
        BOLD,
    )
}

fn font(weight: f64, size_px: f64) -> FontDescriptor {
    FontDescriptor {
        family: "Roboto".to_owned(),
        fallback_chain: Vec::new(),
        weight,
        style: FontStyle::Normal,
        size_px,
    }
}

fn text() -> impl Strategy<Value = String> {
    let ch = prop_oneof![
        3 => (0..CARRIED.len()).prop_map(|i| CARRIED.get(i).copied().unwrap_or('a')),
        1 => (0..LACKED.len()).prop_map(|i| LACKED.get(i).copied().unwrap_or('日')),
    ];
    prop::collection::vec(ch, 0..24).prop_map(|chars| chars.into_iter().collect())
}

fn mixes(text: &str) -> bool {
    text.chars().any(|c| CARRIED.contains(&c)) && text.chars().any(|c| LACKED.contains(&c))
}

#[test]
fn a_seam_between_two_runs_costs_nothing_and_appending_never_shrinks() {
    let Ok(m) = measurer() else { panic!("the vendored faces do not parse") };
    let mixed = Floor::new("a concatenation holding a carried and a missing glyph");
    check((text(), text(), 100.0_f64..900.0, 1.0_f64..96.0), None, |(a, b, weight, size)| {
        let f = font(weight, size);
        let whole = m.advance_width(&format!("{a}{b}"), &f);
        let parts = m.advance_width(&a, &f) + m.advance_width(&b, &f);
        mixed.draw(mixes(&format!("{a}{b}")));
        prop_assert!(
            (whole - parts).abs() < ADVANCE_TOLERANCE_PX,
            "{a:?} + {b:?}: {whole} against {parts}"
        );
        prop_assert!(whole >= m.advance_width(&a, &f) - ADVANCE_TOLERANCE_PX);
        Ok(())
    });
    mixed.assert(60);
}

#[test]
fn the_advance_is_linear_in_the_size() {
    let Ok(m) = measurer() else { panic!("the vendored faces do not parse") };
    check((text(), 1.0_f64..32.0), None, |(t, size)| {
        let small = m.advance_width(&t, &font(400.0, size));
        let large = m.advance_width(&t, &font(400.0, size * 3.0));
        prop_assert!((large - small * 3.0).abs() <= 1e-9 * large.max(1.0), "{t:?}: {large}");
        Ok(())
    });
}
