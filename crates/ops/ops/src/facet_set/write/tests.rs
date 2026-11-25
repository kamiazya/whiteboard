//! What a stored facet payload may be read back as, and the merge that spells
//! it.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::json;

fn value(text: &str) -> Value {
    json::parse(text).expect("a value")
}

fn entries(text: &str) -> Map {
    match value(text) {
        Value::Map(entries) => entries,
        _ => Vec::new(),
    }
}

#[test]
fn an_object_of_several_keys_is_found_at_any_depth() {
    assert!(!holds_wide_map(&value("1")));
    assert!(!holds_wide_map(&value(r#"{"a":1}"#)));
    assert!(!holds_wide_map(&value(r#"{"a":{"b":[1,{"c":2}]}}"#)));
    assert!(holds_wide_map(&value(r#"{"a":1,"b":2}"#)));
    assert!(holds_wide_map(&value(r#"{"a":{"b":{"c":1,"d":2}}}"#)));
    assert!(holds_wide_map(&value(r#"[1,[{"a":1,"b":2}]]"#)));
    assert!(!holds_wide_map(&value(r#"[1,[{"a":1}],"x",null]"#)));
}

fn input() -> FacetSetInput {
    FacetSetInput {
        workspace_id: "w".into(),
        document_ids: vec!["d".into()],
        node_id: None,
        edge_id: None,
        tags: None,
        target: None,
        facets: None,
    }
}

fn payload<'a>(
    input: &'a FacetSetInput,
    sets: &'a [(String, Value)],
    deletions: &'a [String],
) -> Payload<'a> {
    Payload { input, edit: None, sets, deletions }
}

#[test]
fn what_is_stored_is_spelled_in_an_order_only_when_it_cannot_be_unknown() {
    let input = input();
    let wide = entries(r#"{"a/v0":{"x":1,"y":2}}"#);
    let narrow = entries(r#"{"a/v0":{"x":1}}"#);
    let two = entries(r#"{"a/v0":1,"b/v0":2}"#);
    let none: [(String, Value); 0] = [];
    assert!(order_unknown(&wide, &payload(&input, &none, &[])), "a kept payload of two keys");
    assert!(!order_unknown(&narrow, &payload(&input, &none, &[])));
    assert!(order_unknown(&two, &payload(&input, &none, &[])), "two stored keys survive");
    let gone = ["b/v0".to_owned()];
    assert!(!order_unknown(&two, &payload(&input, &none, &gone)), "one is deleted");
    let replaced = [("a/v0".to_owned(), Value::Number(3.0))];
    assert!(
        !order_unknown(&wide, &payload(&input, &replaced, &[])),
        "the wide payload is replaced"
    );
    assert!(order_unknown(&two, &payload(&input, &replaced, &[])), "the order of two is unknown");
}

#[test]
fn a_set_replaces_where_it_stood_a_new_key_follows_and_a_deletion_goes() {
    let input = input();
    let stored = entries(r#"{"a/v0":1,"b/v0":2}"#);
    let sets = [("b/v0".to_owned(), Value::Number(9.0)), ("c/v0".to_owned(), Value::Number(3.0))];
    let deletions = ["a/v0".to_owned()];
    assert_eq!(
        merged(&stored, &payload(&input, &sets, &deletions)),
        entries(r#"{"b/v0":9,"c/v0":3}"#)
    );
    let ordered = merged(&stored, &payload(&input, &sets, &[]));
    let keys: Vec<&str> = ordered.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["a/v0", "b/v0", "c/v0"]);
}
