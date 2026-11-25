//! Where passages land, and what a set of them may do to a body, over bodies
//! small enough to count by hand.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::json;

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// An op quoting `exact`, said to sit at `start..end`, replaced by `text`.
fn op(id: &str, exact: &str, (start, end): (f64, f64), text: &str) -> BodyReplace {
    BodyReplace {
        id: id.to_owned(),
        node_id: None,
        prefix: None,
        exact: exact.to_owned(),
        suffix: None,
        start,
        end,
        text: text.to_owned(),
        assumed: exact.to_owned(),
    }
}

fn spans(placed: &[Placed]) -> Vec<(usize, usize)> {
    placed.iter().map(|each| (each.start, each.end)).collect()
}

fn message(refusal: &Refusal) -> String {
    refusal.message()
}

#[test]
fn offsets_that_select_the_quote_are_kept_among_repeats() {
    let body = u("echo one echo two");
    let held = place_all(&body, &[op("a", "echo", (9.0, 13.0), "x")], &[]).expect("placed");
    assert_eq!(spans(&held), [(9, 13)]);
    let missed = place_all(&body, &[op("a", "echo", (10.0, 14.0), "x")], &[]).expect("placed");
    assert_eq!(spans(&missed), [(9, 13)], "the nearest occurrence when the offsets miss");
}

#[test]
fn context_picks_a_repeat_over_the_nearer_one() {
    let body = u("echo one echo two");
    let mut asked = op("a", "echo", (1.0, 5.0), "x");
    asked.prefix = Some("one ".to_owned());
    asked.suffix = Some(" two".to_owned());
    let placed = place_all(&body, &[asked], &[]).expect("placed");
    assert_eq!(spans(&placed), [(9, 13)]);
}

#[test]
fn a_passage_the_body_lacks_refuses_the_call_naming_it() {
    let body = u("one two");
    let ops = [op("a", "one", (0.0, 3.0), "x"), op("b", "six", (0.0, 3.0), "y")];
    let refusal = place_all(&body, &ops, &[]).expect_err("a refusal");
    assert_eq!(message(&refusal), "Passage b does not apply: its passage is no longer in the body");
}

#[test]
fn a_change_id_used_twice_is_refused_in_the_words_of_whichever_repeated_it() {
    let body = u("one two");
    let twice = [op("a", "one", (0.0, 3.0), "x"), op("a", "two", (4.0, 7.0), "y")];
    let within = place_all(&body, &twice, &[]).expect_err("a refusal");
    assert_eq!(
        message(&within),
        "Passage a does not apply: two passages in this call share that change id, and an Adopt naming it could not tell them apart"
    );
    let held = ["a".to_owned()];
    let continued = place_all(&body, &twice[..1], &held).expect_err("a refusal");
    assert_eq!(
        message(&continued),
        "Passage a does not apply: the proposal this call continues already holds a change with that id, and storing it would replace that change rather than add one"
    );
}

#[test]
fn an_anchor_naming_a_node_is_refused_with_the_node_quoted() {
    let mut asked = op("a", "one", (0.0, 3.0), "x");
    asked.node_id = Some("n\"1".to_owned());
    let refusal = place_all(&u("one"), &[asked], &[]).expect_err("a refusal");
    assert_eq!(
        message(&refusal),
        "Passage a does not apply: a markdown document has no node \"n\\\"1\"; omit nodeId to quote its body"
    );
}

#[test]
fn offsets_are_whole_doubles_a_native_index_holds() {
    assert_eq!(offset(0.0), 0);
    assert_eq!(offset(-0.0), 0);
    assert_eq!(offset(262_144.0), 262_144);
    assert_eq!(offset(-1.0), usize::MAX);
    assert_eq!(offset(f64::NAN), usize::MAX);
    assert_eq!(offset(1e30), usize::MAX);
    assert!(double(0).abs() < f64::EPSILON);
    assert!((double(70_000) - 70_000.0).abs() < f64::EPSILON);
    assert!((double(usize::MAX) - f64::from(u32::MAX)).abs() < f64::EPSILON);
}

fn placed(body: &str, ops: &[BodyReplace]) -> Vec<Placed> {
    place_all(&u(body), ops, &[]).expect("placed")
}

#[test]
fn passages_that_touch_are_disjoint_and_ones_that_reach_into_each_other_are_not() {
    let body = "abcdef";
    let touching =
        placed(body, &[op("a", "abc", (0.0, 3.0), "X"), op("b", "def", (3.0, 6.0), "Y")]);
    assert_eq!(refuse_overlap(&touching), Ok(()));
    let reaching =
        placed(body, &[op("a", "abc", (0.0, 3.0), "X"), op("b", "cde", (2.0, 5.0), "Y")]);
    assert_eq!(
        message(&refuse_overlap(&reaching).expect_err("a refusal")),
        "Passage b does not apply: its passage [2, 5) overlaps a's [0, 3) — applying both would write text neither one proposed"
    );
}

#[test]
fn the_overlap_is_named_by_start_order_whatever_order_the_call_gave() {
    let body = "abcdef";
    let reversed =
        placed(body, &[op("b", "cde", (2.0, 5.0), "Y"), op("a", "abc", (0.0, 3.0), "X")]);
    assert_eq!(
        message(&refuse_overlap(&reversed).expect_err("a refusal")),
        "Passage b does not apply: its passage [2, 5) overlaps a's [0, 3) — applying both would write text neither one proposed"
    );
    let same_start =
        placed(body, &[op("a", "abc", (0.0, 3.0), "X"), op("b", "abcde", (0.0, 5.0), "Y")]);
    assert_eq!(
        message(&refuse_overlap(&same_start).expect_err("a refusal")),
        "Passage b does not apply: its passage [0, 5) overlaps a's [0, 3) — applying both would write text neither one proposed"
    );
}

#[test]
fn only_neighbours_in_start_order_are_compared() {
    let body = "abcdefghij";
    let three = placed(
        body,
        &[
            op("a", "abc", (0.0, 3.0), "X"),
            op("b", "def", (3.0, 6.0), "Y"),
            op("c", "efg", (4.0, 7.0), "Z"),
        ],
    );
    assert_eq!(
        message(&refuse_overlap(&three).expect_err("a refusal")),
        "Passage c does not apply: its passage [4, 7) overlaps b's [3, 6) — applying both would write text neither one proposed"
    );
    assert_eq!(refuse_overlap(&[]), Ok(()));
}

#[test]
fn a_passage_that_no_longer_reads_what_was_assumed_is_refused_with_both_quoted() {
    let body = u("one \"two\"\n");
    let mut asked = op("a", "two", (5.0, 8.0), "x");
    asked.assumed = "six".to_owned();
    let held = place_all(&body, &[asked], &[]).expect("placed");
    assert_eq!(
        message(&refuse_stale(&held, &body).expect_err("a refusal")),
        "Passage a does not apply: the body now reads \"two\" there, not \"six\""
    );
    let fine = place_all(&body, &[op("a", "two", (5.0, 8.0), "x")], &[]).expect("placed");
    assert_eq!(refuse_stale(&fine, &body), Ok(()));
}

#[test]
fn the_first_stale_passage_in_call_order_is_the_one_named() {
    let body = u("one two three");
    let mut first = op("a", "three", (8.0, 13.0), "x");
    first.assumed = "3".to_owned();
    let mut second = op("b", "one", (0.0, 3.0), "y");
    second.assumed = "1".to_owned();
    let held = place_all(&body, &[first, second], &[]).expect("placed");
    assert!(message(&refuse_stale(&held, &body).expect_err("a refusal")).starts_with("Passage a "));
}

#[test]
fn every_passage_is_replaced_from_the_one_body() {
    let body = u("alpha beta gamma delta");
    let ops = [
        op("c", "delta", (17.0, 22.0), ""),
        op("a", "alpha", (0.0, 5.0), "ALPHA ALPHA"),
        op("b", "gamma", (11.0, 16.0), "G"),
    ];
    let held = place_all(&body, &ops, &[]).expect("placed");
    assert_eq!(String::from_utf16_lossy(&apply_disjoint(&body, &held)), "ALPHA ALPHA beta G ");
    assert_eq!(apply_disjoint(&body, &[]), body);
}

#[test]
fn offsets_count_utf16_units() {
    let body = u("\u{1f600} smile");
    let held = place_all(&body, &[op("a", "smile", (3.0, 8.0), "grin")], &[]).expect("placed");
    assert_eq!(spans(&held), [(3, 8)]);
    assert_eq!(String::from_utf16_lossy(&apply_disjoint(&body, &held)), "\u{1f600} grin");
    assert_eq!(growth(&held[0]), -1);
    let wide = place_all(&body, &[op("a", "smile", (3.0, 8.0), "\u{1f600}")], &[]).expect("placed");
    assert_eq!(growth(&wide[0]), -3, "a character outside the plane is two units");
}

fn grower(id: &str, text_len: usize) -> Placed {
    let held = place_all(&u("ab"), &[op(id, "ab", (0.0, 2.0), &"g".repeat(text_len))], &[]);
    held.expect("placed").remove(0)
}

#[test]
fn only_growth_that_ends_past_the_limit_is_refused() {
    let limit = MARKDOWN_MAX_CHARS;
    let one = [grower("a", 3)];
    assert_eq!(refuse_growth(limit - 1, &one, limit), Ok(()), "on the limit");
    let refused = refuse_growth(limit - 1, &one, limit + 1).expect_err("a refusal");
    assert_eq!(
        message(&refused),
        format!(
            "Passage a does not apply: the edit would leave the body {} characters, over the 262144-character limit for one document; split the content across documents",
            limit + 1
        )
    );
    assert_eq!(refuse_growth(limit + 5, &one, limit + 5), Ok(()), "a body kept the same length");
    assert_eq!(refuse_growth(limit + 5, &one, limit + 2), Ok(()), "a body shortened toward it");
    assert!(refuse_growth(limit + 1, &one, limit + 2).is_err(), "a body past it that grows");
}

#[test]
fn the_refusal_names_the_passage_that_grows_the_body_most_and_the_first_of_equals() {
    let limit = MARKDOWN_MAX_CHARS;
    let several = [grower("small", 3), grower("large", 9), grower("equal", 9)];
    let refused = refuse_growth(0, &several, limit + 1).expect_err("a refusal");
    assert!(message(&refused).starts_with("Passage large "));
    let reversed = [grower("equal", 9), grower("large", 9)];
    let refused = refuse_growth(0, &reversed, limit + 1).expect_err("a refusal");
    assert!(message(&refused).starts_with("Passage equal "));
    assert_eq!(refuse_growth(0, &[], limit + 1), Ok(()), "nothing placed names nothing");
}

fn change(text: &str) -> Value {
    json::parse(text).expect("a change")
}

fn proposal(changes: &[&str]) -> Value {
    let all: Vec<Value> = changes.iter().map(|text| change(text)).collect();
    Value::Map(vec![
        ("id".to_owned(), Value::String("p1".to_owned())),
        ("changes".to_owned(), Value::Seq(all)),
    ])
}

const OPEN: &str = r#"{"id":"o","status":"open","op":"body.replace","anchor":{"kind":"text","quote":{"exact":"two","prefix":"one ","suffix":" three"},"start":4,"end":7},"text":"2","assumed":"two"}"#;

#[test]
fn a_stored_open_passage_is_placed_where_the_body_now_holds_it() {
    let body = u("zero one two three");
    let held = place_existing(&body, &proposal(&[OPEN]));
    assert_eq!(spans(&held), [(9, 12)], "the passage followed an edit before it");
    let first = held.first().expect("a passage");
    assert_eq!((first.id.as_str(), first.text.as_str(), first.assumed.as_str()), ("o", "2", "two"));
    assert_eq!(first.anchor.quote.prefix.as_deref(), Some("one "));
    assert_eq!(first.anchor.quote.suffix.as_deref(), Some(" three"));
}

#[test]
fn a_stored_change_that_reserves_nothing_is_left_out() {
    let body = u("zero one two three");
    let decided = OPEN.replace("\"open\"", "\"adopted\"");
    let canvas = OPEN.replace("body.replace", "node.add");
    let gone = OPEN.replace("\"two\",\"prefix\"", "\"six\",\"prefix\"");
    let nameless = OPEN.replace("\"id\":\"o\",", "");
    let unplaced = OPEN.replace("\"start\":4,\"end\":7", "\"start\":4");
    let all = proposal(&[&decided, &canvas, &gone, &nameless, &unplaced, "7"]);
    assert_eq!(place_existing(&body, &all), []);
    assert_eq!(place_existing(&body, &Value::Null), []);
}
