use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// Every grapheme boundary of `text` in UTF-16 offsets, the end included: what
/// the segmenter answers over the whole text, with no window to get wrong.
fn cuts_with_end(text: &str) -> Vec<usize> {
    let mut cuts = grapheme_cuts(text);
    cuts.push(text.encode_utf16().count());
    cuts
}

/// The two edges of `text` at every offset against the whole-text segmenter.
fn check_every_offset(text: &str) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let cuts = cuts_with_end(text);
    for at in 0..=units.len() {
        let after = cuts.iter().copied().find(|cut| *cut >= at);
        let before = cuts.iter().copied().rev().find(|cut| *cut <= at);
        assert_eq!(
            Some(cluster_start_at_or_after(&units, at)),
            after,
            "start at or after {at} of {text:?}"
        );
        assert_eq!(
            Some(cluster_end_at_or_before(&units, at)),
            before,
            "end at or before {at} of {text:?}"
        );
    }
}

/// One code point for each way a cut can be decided: a plain letter, CR and LF,
/// a combining mark just past the fast path's bound, a Prepend below the high
/// plane and one above it (and the first of the table), an astral emoji, a
/// regional indicator, a joiner and a Hangul pair.
const ALPHABET: [char; 11] = [
    'a',
    '\r',
    '\n',
    '\u{300}',
    '\u{600}',
    '\u{6dd}',
    '\u{110bd}',
    '\u{1f600}',
    '\u{1f1e6}',
    '\u{200d}',
    '\u{1100}',
];

fn strings_up_to(length: usize) -> Vec<String> {
    let mut all = vec![String::new()];
    let mut layer = vec![String::new()];
    for _ in 0..length {
        layer = layer
            .iter()
            .flat_map(|held| {
                ALPHABET.iter().map(move |c| {
                    let mut next = held.clone();
                    next.push(*c);
                    next
                })
            })
            .collect();
        all.extend(layer.iter().cloned());
    }
    all
}

#[test]
fn both_edges_equal_the_whole_text_segmenter_on_every_short_text() {
    let texts = strings_up_to(5);
    assert!(texts.len() > 100_000, "the enumeration reached {} texts", texts.len());
    for text in &texts {
        check_every_offset(text);
    }
}

#[test]
fn a_run_of_flags_is_cut_in_pairs_from_its_start_wherever_the_cut_lands() {
    for flags in 0..=45 {
        check_every_offset(&format!("a{}", "\u{1f1e6}".repeat(flags)));
    }
}

#[test]
fn a_prepend_holds_the_character_after_it_far_from_the_text_start() {
    check_every_offset(&format!("{}\u{600}a\u{300}{}", "b".repeat(70), "c".repeat(70)));
    check_every_offset(&format!("{}\u{110bd}a{}", "b".repeat(70), "c".repeat(70)));
}

#[test]
fn a_cluster_between_two_hundred_units_of_letters_is_found_by_a_window() {
    check_every_offset(&format!("{}e\u{301}\u{302}{}", "b".repeat(200), "c".repeat(200)));
}

#[test]
fn past_the_lookback_a_flag_run_falls_back_to_code_point_snapping() {
    // 'a', then 600 flags' halves: units 1 + 2k hold the high half of the k-th
    // regional indicator and the true cuts fall every four units from 1.
    let units: Vec<u16> = format!("a{}", "\u{1f1e6}".repeat(600)).encode_utf16().collect();
    let on_a_code_point_inside_a_flag = 1083;
    assert_eq!(cluster_start_at_or_after(&units, on_a_code_point_inside_a_flag), 1083);
    assert_eq!(cluster_end_at_or_before(&units, on_a_code_point_inside_a_flag), 1083);
    let between_the_halves = 1082;
    assert_eq!(cluster_start_at_or_after(&units, between_the_halves), 1083);
    assert_eq!(cluster_end_at_or_before(&units, between_the_halves), 1081);
}

#[test]
fn emoji_that_share_a_flag_leading_surrogate_do_not_push_the_window_to_its_lookback() {
    // U+1F300 is D83C DF00: its high half is a flag's, its low half is not. A
    // run of them past the lookback must still be found whole by a window.
    check_every_offset(&format!("a{}", "\u{1f300}\u{301}".repeat(500)));
}

#[test]
fn a_letter_after_a_flag_run_stops_the_window_before_the_run() {
    // 600 flags are 1200 units, past the lookback, then 'a' + U+0301 + 'b'. The
    // 'a' at 1200 is a cut nothing before it decides, so the window starts
    // there; walked back into the flags it would exhaust the lookback and snap
    // to code points, cutting between the 'a' and its combining mark.
    let units: Vec<u16> = format!("{}a\u{301}b", "\u{1f1e6}".repeat(600)).encode_utf16().collect();
    let between_the_letter_and_its_mark = 1201;
    assert_eq!(cluster_start_at_or_after(&units, between_the_letter_and_its_mark), 1202);
    assert_eq!(cluster_end_at_or_before(&units, between_the_letter_and_its_mark), 1200);
}
