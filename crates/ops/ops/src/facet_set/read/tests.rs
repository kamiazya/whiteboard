//! The shapes an answer may take, and what a call does with one it does not
//! hold.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::json;

fn value(text: &str) -> Value {
    json::parse(text).expect("a value")
}

fn pending(halt: Halt) -> bool {
    matches!(halt, Halt::Pending(FacetSetPending::UndecidedRead))
}

#[test]
fn an_answer_of_another_shape_is_a_read_left_undecided() {
    assert!(pending(facets_of(value("[]")).expect_err("undecided")));
    assert!(pending(core_of(value("3")).expect_err("undecided")));
    assert!(pending(canvas_of(&value(r#"{"canvas":[]}"#)).expect_err("undecided")));
    assert!(pending(canvas_of(&value("{}")).expect_err("undecided")));
    assert!(pending(locks_of(value("{}")).expect_err("undecided")));
}

#[test]
fn an_answer_of_the_engines_shape_is_read() {
    assert_eq!(
        facets_of(value(r#"{"a/v0":1}"#)).ok(),
        Some(vec![("a/v0".into(), Value::Number(1.0))])
    );
    assert_eq!(core_of(value(r#"{"$undefined":true}"#)).ok(), Some(None));
    assert!(matches!(core_of(value(r#"{"type":"note"}"#)), Ok(Some(_))));
    assert_eq!(canvas_of(&value(r#"{"canvas":{"nodes":[]}}"#)).map(|c| c.len()).ok(), Some(1));
    assert_eq!(locks_of(value(r#"["a",3,"b"]"#)).ok(), Some(vec!["a".to_owned(), "b".to_owned()]));
}

#[test]
fn a_fault_stops_the_call_as_the_reads_refuse() {
    let retired = Halt::from(Fault::Retired("a list".to_owned()));
    assert!(matches!(retired, Halt::Refused(Refusal::RetiredStoredShape { .. })));
    let refused = Halt::from(Fault::Stop(Stop::Refused(Refusal::InternalError)));
    assert!(matches!(refused, Halt::Refused(Refusal::InternalError)));
    let undecided = Halt::from(Fault::Stop(Stop::Pending(
        crate::document_get::Pending::UndecidedRead("d".to_owned()),
    )));
    assert!(pending(undecided));
    assert!(matches!(Halt::from(&PortError::InvalidTime), Halt::Refused(Refusal::InternalError)));
}

#[test]
fn an_elements_id_is_its_string_id_alone() {
    let element = |text: &str| match value(text) {
        Value::Map(entries) => entries,
        _ => Vec::new(),
    };
    assert_eq!(id_of(&element(r#"{"id":"n1"}"#)), Some("n1"));
    assert_eq!(id_of(&element(r#"{"id":3}"#)), None);
    assert_eq!(id_of(&element("{}")), None);
    let canvas = element(r#"{"nodes":[{"id":"a"},3,{"id":"b"}],"edges":"x"}"#);
    assert_eq!(elements(&canvas, "nodes").len(), 2);
    assert!(elements(&canvas, "edges").is_empty());
    assert!(elements(&canvas, "lines").is_empty());
}
