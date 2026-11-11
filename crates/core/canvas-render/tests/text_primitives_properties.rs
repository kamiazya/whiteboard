//! The text primitives as properties, stated without their own code.
//!
//! `fit_to_width` is judged against a linear scan over the input's graphemes
//! (`unicode-segmentation` cut independently of the cheap path the port takes
//! for text without clusters): the answer must be the longest grapheme prefix
//! that fits, the first grapheme when none does, and the whole text when the
//! width is unusable or the text fits. `longest_fitting_count` is judged
//! against a scan for the first prefix that fails.

use unicode_segmentation::UnicodeSegmentation;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::inline_junction::{
    LineCursor, create_inline_junction, head_character, tail_character,
};
use whiteboard_canvas_render::longest_fit::longest_fitting_count;
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure};
use whiteboard_canvas_render::truncate::fit_to_width;
use whiteboard_canvas_render::uax_segments::{uax_segment_ranges, uax_segments};
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};
use whiteboard_scene::{BoundingBox, TextRunNode};

const PIECES: [&str; 20] = [
    "a",
    "b",
    "x",
    " ",
    "日",
    "本",
    "。",
    "「",
    "😀",
    "👨\u{200d}👩",
    "🇯🇵",
    "👍🏽",
    "e\u{301}",
    "\u{300}",
    "\r\n",
    "\r",
    "\n",
    "한",
    "\u{915}\u{94d}\u{937}",
    "\u{e01}\u{e31}",
];

fn text() -> impl Strategy<Value = String> {
    prop::collection::vec(0..PIECES.len(), 0..14)
        .prop_map(|picks| picks.iter().filter_map(|&i| PIECES.get(i).copied()).collect())
}

fn font() -> FontDescriptor {
    FontDescriptor {
        family: "Inter".to_string(),
        fallback_chain: Vec::new(),
        weight: 400.0,
        style: FontStyle::Normal,
        size_px: 10.0,
    }
}

/// A text and a width drawn against its length, in UTF-16 units of 6px each:
/// on a prefix's edge, a hair under it, or unusable.
fn text_and_width() -> impl Strategy<Value = (String, f64)> {
    text().prop_flat_map(|text| {
        let units = u32::try_from(text.encode_utf16().count()).unwrap_or(0);
        let width = prop_oneof![
            8 => (0..=units).prop_map(|n| f64::from(n) * 6.0),
            2 => (1..=units + 1).prop_map(|n| f64::from(n) * 6.0 - 1.0),
            1 => prop::sample::select(vec![0.0, -5.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY]),
        ];
        (Just(text), width)
    })
}

#[test]
fn a_fit_is_the_longest_grapheme_prefix_that_fits() {
    let measure = FakeMeasure::default();
    let cut = Floor::new("a text cut between graphemes");
    let overflowing = Floor::new("a text whose first grapheme is over the edge");
    let clustered = Floor::new("a cut text holding a multi-unit grapheme");
    check(text_and_width(), None, |(text, max)| {
        let fitted = fit_to_width(&text, &font(), &measure, max);
        let width = |s: &str| measure.advance_width(s, &font());
        prop_assert!(
            text.starts_with(fitted.text),
            "{:?} is not a prefix of {text:?}",
            fitted.text
        );
        prop_assert_eq!(fitted.truncated, fitted.text.len() != text.len());
        let usable = max.is_finite() && max > 0.0;
        if !usable || width(&text) <= max {
            prop_assert_eq!(fitted.text, text.as_str());
            prop_assert!(!fitted.overflows);
            return Ok(());
        }
        // The reference: the longest run of whole graphemes that fits, else the first.
        let mut kept = 0;
        for (at, g) in text.grapheme_indices(true) {
            let end = at + g.len();
            if end < text.len() && width(&text[..end]) <= max {
                kept = end;
            } else {
                break;
            }
        }
        let first = text.graphemes(true).next().map_or(0, str::len);
        let want = if kept == 0 { &text[..first] } else { &text[..kept] };
        prop_assert_eq!(fitted.text, want, "fitting {:?} to {}", text, max);
        prop_assert_eq!(fitted.overflows, kept == 0);
        prop_assert_eq!(fitted.overflows, width(fitted.text) > max);
        prop_assert!(!fitted.text.is_empty() || text.is_empty());
        cut.draw(!fitted.overflows && fitted.truncated);
        overflowing.draw(fitted.overflows);
        clustered
            .draw(fitted.truncated && text.graphemes(true).any(|g| g.encode_utf16().count() > 1));
        Ok(())
    });
    cut.assert(100);
    overflowing.assert(10);
    clustered.assert(60);
}

#[test]
fn a_gallop_finds_the_first_prefix_that_does_not_fit() {
    let fell = Floor::new("a search whose answer is below the limit");
    let searches = (0_usize..300).prop_flat_map(|limit| (Just(limit), 0..limit + 3, 0..limit + 3));
    check(searches, None, |(limit, guess, threshold)| {
        let mut asked = Vec::new();
        let got = longest_fitting_count(
            |n| {
                asked.push(n);
                n <= threshold
            },
            limit,
            guess,
        );
        let want = threshold.min(limit);
        prop_assert_eq!(got, want);
        if want < limit {
            prop_assert!(asked.contains(&(want + 1)), "{} was never probed: {asked:?}", want + 1);
        }
        prop_assert!(asked.iter().all(|&n| (1..=limit + 1).contains(&n)));
        fell.draw(want < limit);
        Ok(())
    });
    fell.assert(100);
}

#[test]
fn segments_concatenate_to_the_text_and_agree_with_the_ranges() {
    let split = Floor::new("a text with more than one segment");
    check(text(), None, |text| {
        let segments = uax_segments(&text);
        prop_assert_eq!(segments.concat(), text.clone());
        prop_assert!(segments.iter().all(|s| !s.is_empty()));
        let units: Vec<u16> = text.encode_utf16().collect();
        let widths: Vec<usize> =
            uax_segment_ranges(&units).iter().map(ExactSizeIterator::len).collect();
        let want: Vec<usize> = segments.iter().map(|s| s.encode_utf16().count()).collect();
        prop_assert_eq!(widths, want);
        split.draw(segments.len() > 1);
        Ok(())
    });
    split.assert(100);
}

const RUN_TEXTS: [&str; 10] = ["abc", "t", "。", "「", " ", "a ", "日本", "code", ")", "ー"];

fn run(x: f64, y: f64, text: &str) -> TextRunNode {
    TextRunNode {
        bbox: BoundingBox { x, y, w: 10.0, h: 20.0 },
        text: text.to_string(),
        emphasis: false,
        strong: false,
        code: false,
        deleted: false,
        link: None,
        truncated: false,
        overflows: false,
        appearance: None,
        paints: None,
        backdrop: None,
        backdrop_pad_x_px: None,
        annotates: None,
        baseline: None,
    }
}

#[test]
fn relocating_a_cluster_shifts_only_its_runs_and_the_cursor() {
    let moved = Floor::new("a relocation that moved at least one run");
    check(prop::collection::vec(0..RUN_TEXTS.len(), 1..10), None, |picks| {
        let mut runs: Vec<TextRunNode> = Vec::new();
        let mut line = LineCursor { x: 0.0, index: 0 };
        let mut junction = create_inline_junction(20.0);
        for &pick in &picks {
            let text = RUN_TEXTS[pick];
            let head = head_character(text, None);
            if !junction.breakable_before(head) {
                break;
            }
            runs.push(run(line.x, 0.0, text));
            line.x += 10.0;
            junction.placed(text, None, &runs, &line);
        }
        let before = (runs.clone(), line);
        let relocated = junction.relocate_cluster(&mut runs, &mut line);
        if !relocated {
            prop_assert_eq!((runs, line), before);
            return Ok(());
        }
        prop_assert_eq!(line.index, before.1.index + 1);
        let shifted = runs.iter().zip(&before.0).filter(|(a, b)| a.bbox != b.bbox).count();
        let shift = before.1.x - line.x;
        let exact = runs.iter().zip(&before.0).all(|(a, b)| {
            a.bbox == b.bbox
                || (a.bbox.x.to_bits() == (b.bbox.x - shift).to_bits()
                    && a.bbox.y.to_bits() == (b.bbox.y + 20.0).to_bits())
        });
        prop_assert!(exact, "a run moved by something other than the cluster's offset");
        moved.draw(shifted > 0);
        Ok(())
    });
    moved.assert(1);
}

#[test]
fn whitespace_at_either_edge_is_no_character_and_a_break_is_already_allowed() {
    let spaces = ['\t', '\n', ' ', '\u{a0}', '\u{2003}', '\u{3000}', '\u{feff}'];
    check((prop::sample::select(spaces.to_vec()), text()), None, |(space, body)| {
        let around = format!("{space}{body}{space}");
        prop_assert_eq!(head_character(&around, None), None);
        prop_assert_eq!(tail_character(&around, None), None);
        let junction = create_inline_junction(20.0);
        prop_assert!(junction.breakable_before(head_character(&around, None)));
        Ok(())
    });
}
