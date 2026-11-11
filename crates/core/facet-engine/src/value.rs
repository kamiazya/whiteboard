//! Total reads of a [`Value`] the interpreter has already judged, so the
//! decoders over a validated manifest or asset hold no branch for a shape the
//! schema made impossible.

use whiteboard_model::Value;

/// The entry named `key` of a mapping.
pub(crate) fn field<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    entries(value).iter().find(|(name, _)| name == key).map(|(_, found)| found)
}

/// A mapping's entries; anything else has none.
pub(crate) fn entries(value: &Value) -> &[(String, Value)] {
    match value {
        Value::Map(entries) => entries,
        _ => &[],
    }
}

/// A sequence's items; anything else has none.
pub(crate) fn items(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Seq(items)) => items,
        _ => &[],
    }
}

/// A string's text; anything else reads as empty.
pub(crate) fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{entries, field, items, text};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_model::Value;

    #[test]
    fn a_mapping_answers_its_entries_and_anything_else_has_none() {
        let map = Value::Map(vec![("a".to_owned(), Value::Bool(true))]);
        assert_eq!(entries(&map).len(), 1);
        assert_eq!(field(&map, "a"), Some(&Value::Bool(true)));
        assert_eq!(field(&map, "b"), None);
        assert!(entries(&Value::Null).is_empty());
        assert_eq!(field(&Value::Seq(Vec::new()), "a"), None);
    }

    #[test]
    fn a_sequence_answers_its_items_and_anything_else_has_none() {
        let seq = Value::Seq(vec![Value::Null, Value::Null]);
        assert_eq!(items(Some(&seq)).len(), 2);
        assert!(items(Some(&Value::Null)).is_empty());
        assert!(items(None).is_empty());
    }

    #[test]
    fn a_string_answers_its_text_and_anything_else_reads_as_empty() {
        assert_eq!(text(&Value::String("x".to_owned())), "x");
        assert_eq!(text(&Value::Null), "");
    }
}
