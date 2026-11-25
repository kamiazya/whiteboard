//! What the recording cannot show of a thread edit: the vocabulary of the
//! TypeScript the batch's words are written from, character by character.

use super::anchor::json_quote;
use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn add() -> ThreadOp {
    ThreadOp::Add {
        thread_id: None,
        anchor: ThreadAnchor::Document,
        body: "x".to_owned(),
        author: None,
    }
}

fn reply() -> ThreadOp {
    ThreadOp::Reply { thread_id: "t1".to_owned(), body: "x".to_owned(), author: None }
}

fn resolve(resolved: Option<bool>) -> ThreadOp {
    ThreadOp::Resolve { thread_id: "t1".to_owned(), resolved }
}

#[test]
fn a_summary_counts_each_word_in_the_order_the_words_are_listed() {
    let ops = [
        resolve(Some(false)),
        resolve(None),
        reply(),
        add(),
        resolve(Some(true)),
        reply(),
        add(),
        add(),
    ];
    assert_eq!(summary::of(&ops), "commented 3, replied 2, resolved 2, reopened 1");
}

#[test]
fn a_summary_names_only_the_words_a_batch_earned() {
    assert_eq!(summary::of(&[resolve(Some(false))]), "reopened 1");
    assert_eq!(summary::of(&[reply(), reply()]), "replied 2");
    assert_eq!(summary::of(&[resolve(None)]), "resolved 1");
    assert_eq!(summary::of(&[add()]), "commented 1");
    assert_eq!(summary::of(&[]), "");
}

#[test]
fn javascripts_trim_takes_white_space_and_line_terminators_and_the_byte_order_mark() {
    let taken = [
        '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{2005}',
        '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
    ];
    let left = [
        '\u{8}', '\u{e}', '\u{1f}', '!', 'a', '\u{85}', '\u{180e}', '\u{200b}', '\u{2060}',
        '\u{2027}', '\u{202a}', '\u{205e}', '\u{3001}', '\u{fffe}', '\u{fefe}', '\u{ff00}',
        '\u{167f}', '\u{1681}', '\u{1fff}', '\u{200b}', '\u{202e}', '\u{2030}',
    ];
    for c in taken {
        assert!(is_js_space(c), "{c:?} is trimmed");
    }
    for c in left {
        assert!(!is_js_space(c), "{c:?} is not trimmed");
    }
}

#[test]
fn a_quoted_string_is_written_as_json_stringify_writes_it() {
    assert_eq!(json_quote("plain"), "\"plain\"");
    assert_eq!(json_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
    assert_eq!(json_quote("\u{8}\u{c}\n\r\t"), "\"\\b\\f\\n\\r\\t\"");
    assert_eq!(json_quote("\u{0}\u{1}\u{b}\u{1f}"), "\"\\u0000\\u0001\\u000b\\u001f\"");
    assert_eq!(json_quote("\u{20}\u{7f}\u{2028}\u{1f600}"), "\" \u{7f}\u{2028}\u{1f600}\"");
}
