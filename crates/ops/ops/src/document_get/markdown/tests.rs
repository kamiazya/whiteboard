use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn map(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

#[test]
fn a_key_spread_again_keeps_its_place_and_takes_the_last_value() {
    let core = map(&[("title", text("stored")), ("type", text("plan"))]);
    let trust = map(&[("type", text("trusted")), ("generated", text("g"))]);
    let built = frontmatter(Some(core), Some("Named"), Some(trust), map(&[]));
    let keys: Vec<&str> = built.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["title", "type", "generated", "facets"]);
    assert_eq!(built[0].1, text("Named"));
    assert_eq!(built[1].1, text("trusted"));
}

#[test]
fn a_document_with_no_core_facets_is_a_note() {
    let built = frontmatter(None, None, None, map(&[]));
    assert_eq!(built, vec![("type".to_owned(), text("note")), ("facets".to_owned(), map(&[]))]);
}

#[test]
fn the_body_is_the_markdown_content_alone() {
    let content =
        |kind: &str| map(&[("content", map(&[("kind", text(kind)), ("body", text("b"))]))]);
    assert_eq!(body_of(content("markdown")), "b");
    assert_eq!(body_of(content("spatial")), "");
    assert_eq!(body_of(map(&[])), "");
    assert_eq!(body_of(Value::Null), "");
}
