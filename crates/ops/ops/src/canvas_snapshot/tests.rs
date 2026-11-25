//! What the recording cannot show of a snapshot: a cut that would split a
//! surrogate pair, a resource nothing claims, and every answer of the engine
//! out of its contract, each left pending rather than guessed at.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::json::parse;

fn value(text: &str) -> Value {
    parse(text).expect("JSON")
}

fn board(text: &str) -> Result<CanvasSnapshotOutput, Halt> {
    project::project("d", &value(text), &["n".to_owned()], &["e".to_owned()])
}

const PENDING: Halt = Halt::Pending(SnapshotPending::UndecidedRead);

fn text_node(text: &str) -> String {
    format!(
        r#"{{"nodes":[{{"id":"n","x":0,"y":0,"width":1,"height":1,"resource":{{"mimeType":"text/markdown","content":{text}}}}}],"edges":[]}}"#
    )
}

#[test]
fn a_cut_between_the_halves_of_a_pair_is_pending() {
    let split = format!("\"{}\\ud83d\\ude00\"", "a".repeat(399));
    assert_eq!(board(&text_node(&split)), Err(Halt::Pending(SnapshotPending::LoneSurrogate)));
    let whole = format!("\"{}\\ud83d\\ude00\"", "a".repeat(398));
    let kept = board(&text_node(&whole)).expect("a board");
    assert!(!kept.truncated, "a pair ending on the budget is kept whole");
    let past = format!("\"{}\\ud83d\\ude00b\"", "a".repeat(398));
    let cut = board(&text_node(&past)).expect("a board");
    assert!(cut.truncated, "one unit past the budget is cut");
    assert_eq!(
        cut.nodes[0].shown,
        Some(Shown::Text { text: format!("{}\u{1F600}", "a".repeat(398)), truncated: true })
    );
}

#[test]
fn a_resource_nothing_claims_projects_as_a_group_with_no_label() {
    let unclaimed = r#"{"nodes":[{"id":"n","x":0,"y":0,"width":1,"height":1,"label":"L","resource":{"mimeType":"application/x-new"}}],"edges":[]}"#;
    let snapshot = board(unclaimed).expect("a board");
    assert_eq!(snapshot.nodes[0].kind, "group");
    assert_eq!(snapshot.nodes[0].shown, None, "only a frame has a label");
    assert!(snapshot.nodes[0].locked);
    assert_eq!((snapshot.line_count, snapshot.truncated), (0, false), "no lines stored is none");
}

#[test]
fn a_canvas_out_of_the_engines_contract_is_pending() {
    for canvas in [
        r#"{"edges":[]}"#,
        r#"{"nodes":[],"edges":{}}"#,
        r#"{"nodes":[],"edges":[],"lines":7}"#,
        r#"{"nodes":[{"id":"n"}],"edges":[]}"#,
        r#"{"nodes":[],"edges":[{"from":{},"to":{}}]}"#,
        r#"{"nodes":[],"edges":[{"id":"e","to":{}}]}"#,
        r#"{"nodes":[],"edges":[{"id":"e","from":{}}]}"#,
        r#"{"nodes":[],"edges":[{"id":"e","from":{},"to":{},"tags":"t"}]}"#,
        r#"{"nodes":[],"edges":[{"id":"e","from":{},"to":{},"facets":[]}]}"#,
        r#"{"nodes":[],"edges":[],"lines":[{"id":1,"from":{},"to":{}}]}"#,
        r#"{"nodes":[],"edges":[],"lines":[{"id":"l","to":{}}]}"#,
        r#"{"nodes":[],"edges":[],"lines":[{"id":"l","from":{}}]}"#,
        r#"{"nodes":[],"edges":[],"lines":[{"id":"l","from":{},"to":{},"facets":1}]}"#,
    ] {
        assert_eq!(board(canvas), Err(PENDING), "{canvas}");
    }
}

#[test]
fn an_empty_bucket_and_a_line_tag_say_nothing() {
    let quiet = r#"{"nodes":[],"edges":[{"id":"e","from":{},"to":{},"facets":{},"tags":[]}],"lines":[{"id":"l","from":{},"to":{},"facets":{},"tags":"never read"}]}"#;
    let snapshot = board(quiet).expect("a board");
    assert_eq!((&snapshot.edges[0].facets, &snapshot.edges[0].tags), (&None, &None));
    assert!(snapshot.edges[0].locked);
    assert_eq!(snapshot.lines[0].facets, None);
}

#[test]
fn the_engines_answers_are_read_only_where_they_keep_their_shape() {
    assert_eq!(project::canvas_in(&value(r#"{"canvas":[]}"#)), None);
    assert_eq!(project::canvas_in(&value(r#"{"skipped":0}"#)), None);
    assert_eq!(ids(value(r#"["a","b"]"#)), Ok(vec!["a".to_owned(), "b".to_owned()]));
    assert_eq!(ids(value(r#"{"a":1}"#)), Err(PENDING));
    assert_eq!(ids(value(r#"["a",1]"#)), Err(PENDING));
}

#[test]
fn a_stopped_read_halts_as_it_stopped() {
    let pending = Fault::Stop(Stop::Pending(crate::Pending::UndecidedRead("d".to_owned())));
    assert_eq!(Halt::from(pending), PENDING);
    let refused = Refusal::RetiredCommentPlane { rows: 1 };
    assert_eq!(Halt::from(Fault::Stop(Stop::Refused(refused.clone()))), Halt::Refused(refused));
    assert_eq!(
        Halt::from(Fault::Retired("x".to_owned())),
        Halt::Refused(Refusal::RetiredStoredShape { found: "x".to_owned() })
    );
}
