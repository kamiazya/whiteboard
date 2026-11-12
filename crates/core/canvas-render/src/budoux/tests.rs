//! The walk's windows and threshold, over tiny models whose every number is
//! visible, and the entry points over the real one.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

use super::{Entry, Feature, boundaries, feature, parse, parse_boundaries};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

static LETTER_A: [Entry; 1] = [(&[0x61], 4)];
static LETTER_B: [Entry; 1] = [(&[0x62], 4)];
static HIGH_HALF: [Entry; 1] = [(&[0xd83d], 4)];
static LOW_HALF: [Entry; 1] = [(&[0xde00], 4)];

fn at(table: &'static [Entry], from: isize, len: isize) -> [Feature; 1] {
    [feature(table, from, len)]
}

#[test]
fn a_boundary_needs_twice_the_sum_to_be_strictly_above_the_total() {
    let text = units("ab");
    let one = at(&LETTER_A, -1, 1);
    assert_eq!(boundaries(&text, &one, 7), vec![1]);
    assert_eq!(boundaries(&text, &one, 8), Vec::<usize>::new(), "equal is not above");
    assert_eq!(boundaries(&text, &one, 9), Vec::<usize>::new());
}

#[test]
fn an_absent_key_weighs_nothing_and_a_negative_total_lets_it_cut() {
    let text = units("ab");
    assert_eq!(boundaries(&text, &at(&LETTER_B, -1, 1), -1), vec![1]);
    assert_eq!(boundaries(&text, &at(&LETTER_B, -1, 1), 0), Vec::<usize>::new());
}

#[test]
fn a_window_before_the_start_is_cut_at_the_start_and_looked_up_as_what_is_left() {
    // Index 1, window [-1, 1): the one unit before the index, looked up as the
    // one-unit key it is though the feature is two units wide.
    assert_eq!(boundaries(&units("ab"), &at(&LETTER_A, -2, 2), 7), vec![1]);
    // Index 1, window [-2, 1) of a three-unit feature: the same unit.
    assert_eq!(boundaries(&units("ab"), &at(&LETTER_A, -3, 3), 7), vec![1]);
}

#[test]
fn a_window_past_the_end_is_cut_at_the_end_and_looked_up_as_what_is_left() {
    // Index 1, window [1, 4): the last unit alone.
    assert_eq!(boundaries(&units("ab"), &at(&LETTER_B, 0, 3), 7), vec![1]);
    // Index 1, window [3, 4): beyond the text, the empty key, which is absent.
    assert_eq!(boundaries(&units("ab"), &at(&LETTER_B, 2, 1), 7), Vec::<usize>::new());
}

#[test]
fn a_window_may_hold_one_half_of_a_surrogate_pair() {
    let grin = units("\u{1f600}");
    assert_eq!(grin, [0xd83d, 0xde00]);
    assert_eq!(boundaries(&grin, &at(&LOW_HALF, 0, 1), 7), vec![1]);
    assert_eq!(boundaries(&grin, &at(&HIGH_HALF, -1, 1), 7), vec![1]);
}

#[test]
fn every_feature_adds_its_weight() {
    let text = units("ab");
    let two = [feature(&LETTER_A, -1, 1), feature(&LETTER_A, -1, 1)];
    assert_eq!(boundaries(&text, &two, 15), vec![1]);
    assert_eq!(boundaries(&text, &two, 16), Vec::<usize>::new());
}

#[test]
fn the_japanese_model_cuts_a_sentence_at_its_phrases() {
    let text = units("今日は天気がいいので、散歩に行きます。");
    assert_eq!(parse_boundaries(&text), vec![3, 6, 11, 14]);
    let phrases: Vec<String> = parse(&text).iter().map(|p| String::from_utf16_lossy(p)).collect();
    assert_eq!(phrases, ["今日は", "天気が", "いいので、", "散歩に", "行きます。"]);
}

#[test]
fn nothing_is_cut_from_a_text_of_one_unit_or_none() {
    assert!(parse(&[]).is_empty());
    assert!(parse_boundaries(&[]).is_empty());
    assert_eq!(parse(&[0x3042]), vec![&[0x3042][..]]);
}

#[test]
fn the_parts_are_the_text_in_order() {
    let text = units("これはペンです。");
    let parts = parse(&text);
    assert_eq!(parts.len(), 2);
    assert_eq!(parts.concat(), text);
}

#[test]
fn a_boundary_may_fall_between_the_halves_of_a_surrogate_pair() {
    // The model scores units, not characters; the TypeScript cuts here too.
    assert_eq!(parse_boundaries(&[0xd800, 0xdc00, 0x3079, 0x3041]), vec![1]);
}
