//! Which tree nodes the operations after a version landed under.

#[cfg(test)]
mod cases {
    use loro::{ExportMode, LoroDoc, LoroText, VersionVector};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_crdt::{NodeId, commit, create_node, nodes_written_since, set_meta, tree};
    use whiteboard_model::Value;

    const T: &str = "tree";

    fn node(doc: &LoroDoc, parent: Option<NodeId>) -> NodeId {
        create_node(doc, T, parent).expect("a node")
    }

    fn name(doc: &LoroDoc, node: NodeId, value: &str) {
        set_meta(doc, T, node, "name", &Value::String(value.to_owned())).expect("a name");
    }

    fn written(doc: &LoroDoc, since: &VersionVector) -> Vec<NodeId> {
        nodes_written_since(doc, T, since)
    }

    #[test]
    fn a_node_counts_for_a_write_to_its_map_or_below_it_not_for_the_tree_op_alone() {
        let doc = LoroDoc::new();
        doc.set_peer_id(1).expect("a peer");
        let (a, b, c) = (node(&doc, None), node(&doc, None), node(&doc, None));
        commit(&doc);
        let since = doc.oplog_vv();
        let meta = |n: NodeId| doc.get_tree(T).get_meta(tree_id(&doc, n)).expect("a map");
        let body = meta(c).insert_container("body", LoroText::new()).expect("a text");
        commit(&doc);
        let after_attach = doc.oplog_vv();
        body.insert(0, "x").expect("a write");
        name(&doc, b, "b");
        node(&doc, Some(a));
        doc.get_map("tree").insert("k", 1).expect("a map root named like the tree");
        doc.get_map("other").insert("k", 1).expect("another root");
        let other = doc.get_tree("other").create(None).expect("a node of another tree");
        doc.get_tree("other").get_meta(other).expect("its map").insert("k", 1).expect("a write");
        commit(&doc);
        assert_eq!(written(&doc, &since), vec![c, b], "first written first, each once");
        assert_eq!(written(&doc, &after_attach), vec![c, b], "a write inside a container counts");
        assert_eq!(written(&doc, &doc.oplog_vv()), Vec::<NodeId>::new());
    }

    #[test]
    fn a_node_a_delete_took_with_itself_or_above_it_is_none_written() {
        let doc = LoroDoc::new();
        let (a, b) = (node(&doc, None), node(&doc, None));
        let child = node(&doc, Some(a));
        commit(&doc);
        let since = doc.oplog_vv();
        for n in [a, child, b] {
            name(&doc, n, "x");
        }
        let roots = doc.get_tree(T).roots();
        doc.get_tree(T).delete(roots[0]).expect("a delete");
        commit(&doc);
        assert_eq!(written(&doc, &since), vec![b]);
    }

    /// The node ids are opaque outside the crate; the tree hands them back in order.
    fn tree_id(doc: &LoroDoc, n: NodeId) -> loro::TreeID {
        let held = tree(doc, T).expect("a tree");
        let index = held.roots().iter().position(|r| *r == n).expect("a root");
        doc.get_tree(T).roots()[index]
    }

    #[test]
    fn every_peer_past_the_version_is_read() {
        let doc = LoroDoc::new();
        doc.set_peer_id(1).expect("a peer");
        let a = node(&doc, None);
        commit(&doc);
        let other = LoroDoc::new();
        other.import(&doc.export(ExportMode::Snapshot).expect("bytes")).expect("an import");
        other.set_peer_id(2).expect("a peer");
        let since = other.oplog_vv();
        name(&other, a, "two");
        commit(&other);
        doc.import(&other.export(ExportMode::updates(&since)).expect("bytes")).expect("an import");
        name(&doc, a, "one");
        commit(&doc);
        assert_eq!(written(&doc, &since), vec![a]);
        let mut from_two = since.clone();
        from_two.set_last(loro::ID::new(2, 0));
        assert_eq!(written(&doc, &from_two), vec![a], "peer 1's write alone still counts");
    }

    #[test]
    fn a_compacted_document_reads_from_the_history_it_kept() {
        let doc = LoroDoc::new();
        doc.set_peer_id(1).expect("a peer");
        let (a, b) = (node(&doc, None), node(&doc, None));
        name(&doc, a, "before");
        commit(&doc);
        doc.get_map("other").insert("k", 1).expect("the change the cut keeps");
        commit(&doc);
        let shallow = doc
            .export(ExportMode::shallow_snapshot(&doc.oplog_frontiers()))
            .expect("a shallow snapshot");
        let kept = LoroDoc::new();
        kept.import(&shallow).expect("an import");
        kept.set_peer_id(1).expect("a peer");
        name(&kept, b, "after");
        commit(&kept);
        assert_eq!(written(&kept, &VersionVector::new()), vec![b]);
    }
}
