use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::json::parse;

fn value(text: &str) -> Value {
    parse(text).expect("JSON")
}

const NODES: &str = r#"[{"id":"a","x":0,"y":0,"width":1,"height":1}]"#;

fn declined() -> Pending {
    Pending::JsonCanvasDeclined("d".to_owned())
}

#[test]
fn the_canvas_is_the_engines_answer_under_its_name() {
    let answer = value(r#"{"skipped":2,"canvas":{"nodes":[],"edges":[]}}"#);
    assert_eq!(canvas_in(answer), value(r#"{"nodes":[],"edges":[]}"#));
    assert_eq!(canvas_in(value(r#"{"skipped":0}"#)), Value::Null);
    assert_eq!(canvas_in(value("[]")), Value::Null);
}

#[test]
fn a_canvas_is_written_in_the_mode_asked() {
    let canvas = value(&format!(r#"{{"nodes":{NODES},"edges":[],"tags":["t"]}}"#));
    let extended = written("d", &canvas, false).expect("written").expect("a text");
    assert_eq!(
        extended,
        r#"{"nodes":[{"id":"a","x":0,"y":0,"width":1,"height":1,"type":"group"}],"edges":[],"x-whiteboard":{"tags":["t"]}}"#
    );
    let strict = written("d", &canvas, true).expect("written").expect("a text");
    assert_eq!(
        strict,
        r#"{"nodes":[{"id":"a","x":0,"y":0,"width":1,"height":1,"type":"group"}],"edges":[]}"#
    );
}

#[test]
fn a_canvas_the_strict_mode_refuses_is_the_documents_failure() {
    let canvas = value(&format!(
        r#"{{"nodes":{NODES},"edges":[{{"id":"e","from":{{"node":"a"}},"to":{{"node":"b"}}}}]}}"#
    ));
    assert!(written("d", &canvas, false).expect("written").is_ok());
    let reason = written("d", &canvas, true).expect("written").expect_err("a refusal");
    assert!(reason.starts_with("Document d cannot be read as JSON Canvas: "), "{reason}");
}

#[test]
fn what_the_writer_declines_is_pending() {
    let unwritable = value(&format!(r#"{{"nodes":{NODES},"edges":[],"facets":{{"a.b/v1":1}}}}"#));
    let Value::Map(mut entries) = unwritable else { panic!("a map") };
    entries[2].1 = Value::Map(vec![("a.b/v1".into(), Value::BigInt("9007199254740993".into()))]);
    assert_eq!(written("d", &Value::Map(entries), false), Err(declined()));
    assert_eq!(written("d", &value(r#"{"nodes":[]}"#), false), Err(declined()));
    let label = format!(r#"{{"nodes":[],"edges":[],"tags":["{}"]}}"#, "a".repeat(4 << 20));
    assert_eq!(written("d", &value(&label), false), Err(declined()));
}
