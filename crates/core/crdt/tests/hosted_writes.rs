//! `write_hosted`: a writer over the document a tree node hosts writes into
//! the node's meta map, and a writer that names no hosted document is not
//! answered — the whole record's restore, and the workspace writers whose
//! rules are a crate above this one.

#[cfg(test)]
mod cases {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_crdt::{LoroDoc, NodeAt, create_node, deep_value, project_node, write_hosted};
    use whiteboard_model::Value;
    use whiteboard_model::crdt::WriterName;

    fn object(entries: Vec<(&str, Value)>) -> Value {
        Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    fn hosted(doc: &LoroDoc) -> NodeAt<'_> {
        NodeAt { doc, tree: "tree", node: create_node(doc, "tree", None).expect("a node") }
    }

    #[test]
    fn a_hosted_writer_writes_into_the_node_and_no_root() {
        let doc = LoroDoc::new();
        let at = hosted(&doc);
        let body = object(vec![("body", Value::String("hi".to_owned()))]);
        let step = write_hosted(at, WriterName::WriteMarkdownBody, &body);
        assert_eq!(step, Some(Ok(())));
        let projected = project_node(at).expect("the hosted document");
        let body = Value::Map(vec![("body".to_owned(), Value::String("hi".to_owned()))]);
        assert_eq!(deep_value(&projected), body);
        let Value::Map(roots) = deep_value(&doc) else { panic!("a map") };
        assert_eq!(roots.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["tree"]);
    }

    #[test]
    fn a_writer_naming_no_hosted_document_is_not_answered() {
        let doc = LoroDoc::new();
        let at = hosted(&doc);
        let past = object(vec![("past", Value::String(String::new()))]);
        assert_eq!(write_hosted(at, WriterName::ReconcileDocContent, &past), None);
        let path = object(vec![("path", Value::String("a".to_owned()))]);
        assert_eq!(write_hosted(at, WriterName::DeleteWorkspaceNodeAtPath, &path), None);
    }
}
