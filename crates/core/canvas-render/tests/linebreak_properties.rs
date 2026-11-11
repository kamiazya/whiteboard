//! The line breaker as properties, stated without its own rules.
//!
//! Over any text, whatever its units, the answer is a strictly increasing list
//! of offsets inside the text that never splits a surrogate pair and ends at
//! the text's end. Over a small alphabet whose break behaviour fits one line
//! (letters, spaces, line feeds and an ideograph), the breaks are exactly the
//! ones that line says, which no code of the port is used to state.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::linebreak::segment_ends;
use whiteboard_proptest::proptest::prelude::{
    Strategy, any, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};

/// Units drawn so that surrogates of both halves, pairs, marks, joiners and
/// ordinary letters all turn up in one text.
fn unit() -> impl Strategy<Value = u16> {
    prop_oneof![
        3 => 0x61_u16..0x7b,
        2 => one_of_units(&[0x20, 0x0a, 0x0d, 0x200b, 0x200d, 0x0301, 0x3001, 0x300c, 0x300d, 0x4e00]),
        2 => 0xd800_u16..0xdc00,
        2 => 0xdc00_u16..0xe000,
        1 => any::<u16>(),
    ]
}

/// A draw from a fixed list of units.
fn one_of_units(units: &'static [u16]) -> impl Strategy<Value = u16> {
    (0..units.len()).prop_map(move |i| units.get(i).copied().unwrap_or(0))
}

#[test]
fn the_ends_are_increasing_inside_the_text_and_never_split_a_pair() {
    let paired = Floor::new("a text holding a surrogate pair");
    let broken = Floor::new("a text with an interior break");
    check(prop::collection::vec(unit(), 0..40), None, |text| {
        let ends = segment_ends(&text);
        prop_assert_eq!(
            ends.last().copied(),
            if text.is_empty() { None } else { Some(text.len()) }
        );
        prop_assert!(ends.windows(2).all(|w| w[0] < w[1]), "{ends:?} is not increasing");
        let has_pair = text
            .windows(2)
            .any(|w| (0xd800..0xdc00).contains(&w[0]) && (0xdc00..0xe000).contains(&w[1]));
        paired.draw(has_pair);
        broken.draw(ends.len() > 1);
        for &end in &ends {
            let split = end > 0
                && end < text.len()
                && text.get(end - 1).is_some_and(|u| (0xd800..0xdc00).contains(u))
                && text.get(end).is_some_and(|u| (0xdc00..0xe000).contains(u));
            prop_assert!(!split, "{text:04x?} breaks inside a pair at {end}");
        }
        Ok(())
    });
    paired.assert(20);
    broken.assert(100);
}

#[test]
fn over_letters_spaces_line_feeds_and_ideographs_a_break_is_where_a_line_says() {
    const LETTER: u16 = 0x61;
    const SPACE: u16 = 0x20;
    const LINE_FEED: u16 = 0x0a;
    const IDEOGRAPH: u16 = 0x4e00;
    let alphabet = prop::collection::vec(
        prop_oneof![3 => one_of_units(&[LETTER]), 2 => one_of_units(&[SPACE]), 1 => one_of_units(&[LINE_FEED]), 2 => one_of_units(&[IDEOGRAPH])],
        0..30,
    );
    let hard = Floor::new("a text with a line feed before a space");
    let space = Floor::new("a text with a space before a letter");
    let ideograph = Floor::new("a text with an ideograph beside a letter");
    check(alphabet, None, |text| {
        // A break before position `i` when the line feed or the space before it
        // says so, or when an ideograph sits on either side; never before a
        // space or a line feed that is not itself after a line feed.
        let expected: Vec<usize> = (1..text.len())
            .filter(|&i| {
                let (prev, cur) = (text[i - 1], text[i]);
                prev == LINE_FEED
                    || (cur != SPACE
                        && cur != LINE_FEED
                        && (prev == SPACE || prev == IDEOGRAPH || cur == IDEOGRAPH))
            })
            .collect();
        hard.draw(text.windows(2).any(|w| w[0] == LINE_FEED && w[1] == SPACE));
        space.draw(text.windows(2).any(|w| w[0] == SPACE && w[1] == LETTER));
        ideograph.draw(text.windows(2).any(|w| {
            (w[0] == IDEOGRAPH) != (w[1] == IDEOGRAPH) && (w[0] == LETTER || w[1] == LETTER)
        }));
        let mut ends = segment_ends(&text);
        ends.pop();
        prop_assert_eq!(ends, expected, "{:?}", text);
        Ok(())
    });
    hard.assert(20);
    space.assert(50);
    ideograph.assert(50);
}
