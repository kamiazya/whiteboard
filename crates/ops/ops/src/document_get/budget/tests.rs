use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn text(length: usize) -> String {
    "x".repeat(length)
}

fn read(id: &str, content: usize, threads: Vec<Value>, proposals: Vec<Value>) -> ReadDocument {
    ReadDocument {
        document_id: id.to_owned(),
        kind: "markdown".to_owned(),
        content: text(content),
        frontmatter: None,
        threads,
        proposals,
        annotations_truncated: false,
    }
}

/// A string whose `JSON.stringify` is `length` units long.
fn item(length: usize) -> Value {
    Value::String(text(length - 2))
}

#[test]
fn a_length_is_counted_in_utf16_units() {
    assert_eq!(units("é🎨"), 3);
    assert_eq!(json_units(&Value::Seq(vec![item(4), item(5)])), 12);
}

#[test]
fn reads_up_to_the_budget_exactly_are_kept_whole() {
    let mut budget = Budget::default();
    budget.offer(read("a", MAX_CONTENT_CHARS - 14, vec![item(4)], vec![item(6)]));
    assert!(!budget.spent());
    budget.offer(read("b", 1, Vec::new(), Vec::new()));
    assert!(budget.spent());
    let output = budget.finish();
    assert_eq!(output.documents.len(), 1);
    assert!(!output.documents[0].annotations_truncated);
    assert_eq!(output.failed[0].document_id, "b");
    assert!(
        output.failed[0]
            .reason
            .starts_with("Not read: this call's answer reached its 1048576-character budget")
    );
}

#[test]
fn an_empty_annotation_list_costs_nothing() {
    let mut budget = Budget::default();
    budget.offer(read("a", MAX_CONTENT_CHARS, Vec::new(), Vec::new()));
    assert!(!budget.spent());
    assert_eq!(budget.finish().documents.len(), 1);
}

#[test]
fn a_first_read_over_the_budget_keeps_the_leading_annotations_that_fit() {
    let mut budget = Budget::default();
    let threads = vec![item(5), item(5), item(1000)];
    let proposals = vec![item(3), item(2)];
    budget.offer(read("a", MAX_CONTENT_CHARS - 13, threads, proposals));
    assert!(budget.spent());
    let output = budget.finish();
    let kept = &output.documents[0];
    assert!(kept.annotations_truncated);
    assert_eq!(kept.threads, vec![item(5), item(5)]);
    assert_eq!(kept.proposals, vec![item(3)]);
}

#[test]
fn content_alone_over_the_budget_keeps_no_annotation() {
    let mut budget = Budget::default();
    budget.offer(read("a", MAX_CONTENT_CHARS + 1, vec![item(2)], vec![item(2)]));
    let kept = &budget.finish().documents[0];
    assert!(kept.threads.is_empty() && kept.proposals.is_empty());
}
