use serde_json::{Value as Json, json};
use whiteboard_canvas_render::typeset::{DiagramRenderer, MathRenderer, Rendered};

use super::{Ask, FragmentTable, MAX_FRAGMENTS, MAX_PLACED_BYTES, fits};
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};

use crate::json_canvas_wire::canvas_json;
use crate::spatial_layout::tests::{answer, board, m, request, s, text_node};

fn row(key: &str, svg: &str) -> (String, Rendered) {
    (key.to_owned(), Rendered::Fragment { svg: svg.to_owned(), width: Some(4.0), height: None })
}

fn math(value: &str) -> Ask {
    Ask::Math(value.to_owned())
}

#[test]
fn a_source_is_keyed_as_the_typescript_keys_it() {
    assert_eq!(math("x").key(), "math:x");
    let fence = Ask::Diagram { lang: "math".to_owned(), value: "x".to_owned() };
    assert_eq!(fence.key(), "fence:math:x");
}

#[test]
fn markup_fits_up_to_the_placed_cap_and_no_further() {
    assert!(fits(0, MAX_PLACED_BYTES));
    assert!(!fits(0, MAX_PLACED_BYTES + 1));
    assert!(fits(MAX_PLACED_BYTES, 0));
    assert!(!fits(MAX_PLACED_BYTES, 1));
    assert!(!fits(1, MAX_PLACED_BYTES));
    assert!(fits(MAX_PLACED_BYTES + 1, 0));
}

#[test]
fn a_row_answers_and_a_later_row_answers_first() {
    let table = [row("math:x", "<g a/>"), row("math:x", "<g b/>"), row("fence:m:v", "<g c/>")];
    let table = FragmentTable::new(&table);
    let svg = |r: Option<Rendered>| match r {
        Some(Rendered::Fragment { svg, .. }) => svg,
        other => format!("{other:?}"),
    };
    assert_eq!(svg(table.render_math("x")), "<g b/>");
    assert_eq!(svg(table.render_diagram("m", "v")), "<g c/>");
    assert_eq!(table.asked(), Vec::new());
}

#[test]
fn a_missing_source_is_asked_for_once_in_the_order_met() {
    let table = FragmentTable::new(&[]);
    assert_eq!(table.render_math("y"), None);
    assert_eq!(table.render_diagram("mermaid", "g"), None);
    assert_eq!(table.render_math("y"), None);
    assert_eq!(table.render_diagram("math", "y"), None);
    let fence = |lang: &str, value: &str| Ask::Diagram { lang: lang.into(), value: value.into() };
    assert_eq!(table.asked(), vec![math("y"), fence("mermaid", "g"), fence("math", "y")]);
}

#[test]
fn placing_past_the_cap_answers_nothing_and_asks_for_nothing() {
    let half = "a".repeat(MAX_PLACED_BYTES / 2);
    let rows = [row("math:x", &half), row("math:y", "b")];
    let table = FragmentTable::new(&rows);
    assert!(table.render_math("x").is_some());
    assert!(table.render_math("x").is_some());
    assert_eq!(table.render_math("y"), None);
    assert_eq!(table.asked(), Vec::new());
}

fn fragment(key: &str, svg: &str) -> Json {
    s(vec![json!(key), m(&[("svg", json!(svg)), ("height", json!(["f", "4044000000000000"]))])])
}

const BODY: &str = "$$\nx\n$$\n\n```mermaid\ng\n```";

#[test]
fn a_table_draws_its_rows_and_the_answer_carries_what_it_lacked() {
    let got =
        answer(&request(board(BODY), &[("fragments", s(vec![fragment("math:x", "<g q/>")]))]));
    assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
    assert!(got.get(1).is_some_and(|scene| scene.to_string().contains("<g q/>")), "{got}");
    let asked = json!([{"kind": "diagram", "lang": "mermaid", "value": "g"}]);
    assert_eq!(got.get(4), Some(&asked));
    let without = answer(&request(board(BODY), &[]));
    assert_eq!(without.as_array().map(Vec::len), Some(4), "{without}");
    let empty = answer(&request(board(BODY), &[("fragments", s(Vec::new()))]));
    assert_eq!(empty.pointer("/4/0"), Some(&json!({"kind": "math", "value": "x"})));
}

#[test]
fn a_table_that_is_not_one_or_past_its_caps_is_refused() {
    let refused = |code: &str, class: &str| json!(["refused", code, class]);
    let malformed = [
        s(vec![s(vec![json!("math:x")])]),
        s(vec![s(vec![json!("math:x"), m(&[])])]),
        s(vec![s(vec![json!("math:x"), m(&[("svg", json!("a")), ("colour", json!("red"))])])]),
        m(&[]),
    ];
    for table in malformed {
        let got = answer(&request(board("x"), &[("fragments", table.clone())]));
        assert_eq!(got, refused("malformed", "request"), "{table}");
    }
    let rows = |n: usize| s((0..n).map(|i| fragment(&format!("math:{i}"), "")).collect());
    let at_cap = answer(&request(board("x"), &[("fragments", rows(MAX_FRAGMENTS))]));
    assert_eq!(at_cap.get(0), Some(&json!("ok")));
    let past = answer(&request(board("x"), &[("fragments", rows(MAX_FRAGMENTS + 1))]));
    assert_eq!(past, refused("input-too-large", "fragments"));
}

#[test]
fn a_layout_placing_more_markup_than_its_cap_draws_the_rest_as_their_fallback() {
    let third = "a".repeat(MAX_PLACED_BYTES / 3 + 1);
    let table = s(vec![fragment("math:x", &third)]);
    let thrice = ["$$\nx\n$$"; 3].join("\n\n");
    // A box tall enough to draw every block, so none is cut before it is placed.
    let tall = |body: &str| {
        let node = SpatialNode { height: 2000.0, ..text_node("a", body) };
        canvas_json(&SpatialCanvas { nodes: vec![node], ..SpatialCanvas::default() })
    };
    let got = answer(&request(tall(&thrice), &[("fragments", table.clone())]));
    assert_eq!(got.get(0), Some(&json!("ok")), "an answer, not a decline");
    let scene = got.get(1).map(Json::to_string).unwrap_or_default();
    assert_eq!(scene.matches(&third).count(), 2, "the first two placed");
    assert_eq!(got.get(3), Some(&json!([])));
    assert_eq!(got.get(4), Some(&json!([])), "a row it holds is never asked for");
    let twice = answer(&request(tall(&thrice[..thrice.len() - 9]), &[("fragments", table)]));
    let placed = twice.get(1).map(Json::to_string).unwrap_or_default();
    assert_eq!(placed.matches(&third).count(), 2);
    assert!(scene.len() > placed.len(), "the third block is drawn, as its fallback");
}

#[test]
fn every_ask_is_counted_answered_or_not() {
    let rows = [row("math:x", "<g/>")];
    let table = FragmentTable::new(&rows);
    assert_eq!(table.reads().get(), 0);
    table.render_math("x");
    table.render_math("y");
    table.render_math("y");
    table.render_diagram("m", "v");
    assert_eq!(table.reads().get(), 4);
}
