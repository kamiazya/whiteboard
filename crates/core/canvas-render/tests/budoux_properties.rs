//! The phrase breaker as properties, stated without its own tables.
//!
//! Over any text, whatever its units, the boundaries are strictly increasing
//! and inside the text (never at its start or end), and the phrases are the
//! text cut at them, in order. A boundary reads only the three units each side
//! of it, so it survives cutting the text after its window or before it. The
//! model knows nothing of surrogate pairs: it may cut between their halves.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::budoux::{parse, parse_boundaries};
use whiteboard_proptest::proptest::prelude::{
    Strategy, any, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};

/// Units of every kind a text holds: kana, kanji, punctuation the model
/// scores, Latin, both surrogate halves, and any unit at all.
fn unit() -> impl Strategy<Value = u16> {
    prop_oneof![
        4 => 0x3041_u16..0x30a0,
        3 => 0x4e00_u16..0x4e40,
        2 => (0_usize..6).prop_map(|i| [0x3001_u16, 0x3002, 0x300c, 0x300d, 0x30fc, 0x3092][i]),
        1 => 0x61_u16..0x7b,
        2 => 0xd800_u16..0xdc00,
        2 => 0xdc00_u16..0xe000,
        1 => any::<u16>(),
    ]
}

#[test]
fn boundaries_are_increasing_inside_the_text() {
    let cut = Floor::new("a text with a boundary");
    let none = Floor::new("a text of two or more units with no boundary");
    check(prop::collection::vec(unit(), 0..40), None, |text| {
        let boundaries = parse_boundaries(&text);
        prop_assert!(
            boundaries.windows(2).all(|w| w[0] < w[1]),
            "{boundaries:?} is not increasing"
        );
        prop_assert!(
            boundaries.iter().all(|&b| b >= 1 && b < text.len()),
            "{boundaries:?} leaves {}",
            text.len()
        );
        cut.draw(!boundaries.is_empty());
        none.draw(text.len() >= 2 && boundaries.is_empty());
        Ok(())
    });
    cut.assert(100);
    none.assert(10);
}

#[test]
fn a_boundary_does_not_depend_on_what_follows_its_window() {
    let tested = Floor::new("a boundary whose window leaves units after it");
    check(prop::collection::vec(unit(), 0..40), None, |text| {
        for b in parse_boundaries(&text) {
            let kept = text.get(..(b + 3).min(text.len())).unwrap_or(&[]);
            tested.draw(kept.len() < text.len());
            prop_assert!(
                parse_boundaries(kept).contains(&b),
                "{text:04x?} loses {b} cut after {kept:04x?}"
            );
        }
        for b in 1..text.len() {
            let kept = text.get(..(b + 3).min(text.len())).unwrap_or(&[]);
            if parse_boundaries(kept).contains(&b) {
                prop_assert!(parse_boundaries(&text).contains(&b), "{text:04x?} lacks {b}");
            }
        }
        Ok(())
    });
    tested.assert(100);
}

#[test]
fn a_boundary_does_not_depend_on_what_precedes_its_window() {
    let tested = Floor::new("a boundary with units to drop before its window");
    check(prop::collection::vec(unit(), 0..40), None, |text| {
        for b in parse_boundaries(&text).into_iter().filter(|&b| b >= 4) {
            let dropped = b - 3;
            let rest = text.get(dropped..).unwrap_or(&[]);
            tested.draw(true);
            prop_assert!(
                parse_boundaries(rest).contains(&(b - dropped)),
                "{text:04x?} loses {b} without its first {dropped} units"
            );
        }
        Ok(())
    });
    tested.assert(100);
}

#[test]
fn the_phrases_are_the_text_cut_at_its_boundaries() {
    check(prop::collection::vec(unit(), 0..40), None, |text| {
        let phrases = parse(&text);
        prop_assert_eq!(phrases.concat(), text.clone());
        prop_assert_eq!(
            phrases.len(),
            if text.is_empty() { 0 } else { parse_boundaries(&text).len() + 1 }
        );
        prop_assert!(phrases.iter().all(|p| !p.is_empty()));
        Ok(())
    });
}
