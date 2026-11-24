//! A tree and the maps beside it, written one loro call for one npm loro-crdt
//! call: what each writer appends, and what it leaves alone.

#[cfg(test)]
mod cases {
    use loro::{
        ContainerTrait, ExportMode, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroValue,
    };
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_crdt::{
        ContainerKind, Entry, NodeAt, NodeId, SubtreeCopy, WriteError, commit, copy_meta,
        copy_subtree, create_node, deep_value, deep_value_with_id, delete_meta, delete_node,
        delete_root_entry, export_subtree, fill_meta, move_node, open_meta_container,
        open_root_list, peek, set_meta, set_peer_id, set_root_entry, tree, version_pairs,
    };
    use whiteboard_model::Value;

    const T: &str = "t";

    fn text(value: &str) -> Value {
        Value::String(value.to_owned())
    }

    fn node(doc: &LoroDoc, parent: Option<NodeId>) -> NodeId {
        create_node(doc, T, parent).expect("a node")
    }

    fn at(doc: &LoroDoc, node: NodeId) -> NodeAt<'_> {
        NodeAt { doc, tree: T, node }
    }

    /// The deep value of the first root's meta map, as loro answers it: integers
    /// and doubles apart, which the model's number does not keep apart.
    fn first_meta(doc: &LoroDoc) -> LoroValue {
        let LoroValue::Map(roots) = doc.get_deep_value() else { panic!("a map of roots") };
        let Some(LoroValue::List(nodes)) = roots.get(T) else { panic!("the tree") };
        let LoroValue::Map(first) = &nodes[0] else { panic!("a node") };
        first.get("meta").expect("the node's meta").clone()
    }

    fn held(doc: &LoroDoc, key: &str) -> Option<LoroValue> {
        let LoroValue::Map(meta) = first_meta(doc) else { panic!("a map") };
        meta.get(key).cloned()
    }

    #[test]
    fn nodes_are_created_moved_and_deleted_in_tree_order() {
        let doc = LoroDoc::new();
        let first = node(&doc, None);
        let second = node(&doc, None);
        let child = node(&doc, Some(first));
        assert_eq!(tree(&doc, T).expect("a tree").roots(), vec![first, second]);
        assert_eq!(tree(&doc, T).expect("a tree").children(first), vec![child]);
        move_node(&doc, T, child, Some(second)).expect("moved under another root");
        assert_eq!(tree(&doc, T).expect("a tree").children(first), Vec::<NodeId>::new());
        assert_eq!(tree(&doc, T).expect("a tree").children(second), vec![child]);
        move_node(&doc, T, child, None).expect("moved to the roots");
        assert_eq!(tree(&doc, T).expect("a tree").roots(), vec![first, second, child]);
        delete_node(&doc, T, second).expect("deleted");
        assert_eq!(tree(&doc, T).expect("a tree").roots(), vec![first, child]);
        assert!(delete_node(&doc, T, second).is_err(), "a node deleted twice is refused");
    }

    #[test]
    fn a_meta_value_is_stored_as_the_kind_npm_loro_stores_it() {
        let doc = LoroDoc::new();
        let id = node(&doc, None);
        for (key, value) in [
            ("whole", Value::Number(1_700_000_000_000.0)),
            ("negative", Value::Number(-3.0)),
            ("fraction", Value::Number(2.5)),
            ("edge", Value::Number(9_007_199_254_740_991.0)),
            ("top", Value::Number(9_007_199_254_740_992.0)),
            ("bottom", Value::Number(-9_007_199_254_740_992.0)),
            ("past", Value::Number(9_007_199_254_740_994.0)),
            ("flag", Value::Bool(true)),
            ("nothing", Value::Null),
            ("word", text("w")),
            ("list", Value::Seq(vec![Value::Number(1.0), text("x")])),
            ("map", Value::Map(vec![("k".to_owned(), Value::Bool(false))])),
        ] {
            set_meta(&doc, T, id, key, &value).expect("set");
        }
        assert_eq!(held(&doc, "whole"), Some(LoroValue::I64(1_700_000_000_000)));
        assert_eq!(held(&doc, "negative"), Some(LoroValue::I64(-3)));
        assert_eq!(held(&doc, "fraction"), Some(LoroValue::Double(2.5)));
        assert_eq!(held(&doc, "edge"), Some(LoroValue::I64(9_007_199_254_740_991)));
        // npm loro-crdt stores the whole numbers from -2^53 to 2^53 as integers
        // (its JSON export refuses both ends as past a JavaScript number) and 2^53 + 2 as a double.
        assert_eq!(held(&doc, "top"), Some(LoroValue::I64(9_007_199_254_740_992)));
        assert_eq!(held(&doc, "bottom"), Some(LoroValue::I64(-9_007_199_254_740_992)));
        assert_eq!(held(&doc, "past"), Some(LoroValue::Double(9_007_199_254_740_994.0)));
        assert_eq!(held(&doc, "flag"), Some(LoroValue::Bool(true)));
        assert_eq!(held(&doc, "nothing"), Some(LoroValue::Null));
        assert_eq!(held(&doc, "word"), Some(LoroValue::from("w")));
        assert_eq!(
            held(&doc, "list"),
            Some(LoroValue::from(vec![LoroValue::I64(1), LoroValue::from("x")]))
        );
        let Some(LoroValue::Map(map)) = held(&doc, "map") else { panic!("a map") };
        assert_eq!(map.get("k"), Some(&LoroValue::Bool(false)));
        assert_eq!(
            set_meta(&doc, T, id, "big", &Value::BigInt("1".to_owned())),
            Err(WriteError("a big integer is not a loro value".to_owned()))
        );
        assert!(
            set_meta(&doc, T, id, "inner", &Value::Seq(vec![Value::BigInt("1".to_owned())]))
                .is_err()
        );
    }

    #[test]
    fn deleting_a_meta_key_is_an_operation_even_for_a_key_never_held() {
        let doc = LoroDoc::new();
        let id = node(&doc, None);
        set_meta(&doc, T, id, "name", &text("n")).expect("set");
        commit(&doc);
        let before = version_pairs(&doc);
        delete_meta(&doc, T, id, "name").expect("deleted");
        commit(&doc);
        assert_eq!(held(&doc, "name"), None);
        delete_meta(&doc, T, id, "never").expect("deleted");
        commit(&doc);
        let moved = |pairs: &[(String, i64)]| pairs.iter().map(|(_, n)| *n).sum::<i64>();
        assert_eq!(moved(&version_pairs(&doc)) - moved(&before), 2);
    }

    #[test]
    fn a_container_is_opened_once_and_only_where_a_tree_or_unknown_kind_is_not_asked() {
        let doc = LoroDoc::new();
        let id = node(&doc, None);
        for (key, kind) in [
            ("map", ContainerKind::Map),
            ("text", ContainerKind::Text),
            ("list", ContainerKind::List),
            ("moves", ContainerKind::MovableList),
        ] {
            open_meta_container(&doc, T, id, key, kind).expect("opened");
        }
        commit(&doc);
        let after_open = version_pairs(&doc);
        for key in ["map", "text", "list", "moves"] {
            let kind = match key {
                "map" => ContainerKind::Map,
                "text" => ContainerKind::Text,
                "list" => ContainerKind::List,
                _ => ContainerKind::MovableList,
            };
            open_meta_container(&doc, T, id, key, kind).expect("left alone");
        }
        commit(&doc);
        assert_eq!(version_pairs(&doc), after_open, "opening a standing container appends nothing");
        assert!(matches!(
            tree(&doc, T).expect("a tree").entry(tree(&doc, T).expect("a tree").roots()[0], "list"),
            Some(Entry::Container { kind: ContainerKind::List, .. })
        ));
        assert!(matches!(
            tree(&doc, T)
                .expect("a tree")
                .entry(tree(&doc, T).expect("a tree").roots()[0], "moves"),
            Some(Entry::Container { kind: ContainerKind::MovableList, .. })
        ));
        for kind in [ContainerKind::Tree, ContainerKind::Other] {
            assert!(open_meta_container(&doc, T, id, "refused", kind).is_err());
        }
    }

    #[test]
    fn a_root_list_is_made_mergeable_when_absent_and_opened_as_it_stands() {
        let doc = LoroDoc::new();
        let list = open_root_list(&doc, "meta", "pins").expect("made");
        list.push("a").expect("push");
        commit(&doc);
        assert_eq!(
            peek(&doc, "meta/pins"),
            Some(Entry::Container {
                kind: ContainerKind::MovableList,
                value: Value::Seq(vec![text("a")])
            })
        );
        let again = open_root_list(&doc, "meta", "pins").expect("opened");
        assert_eq!(again.len(), 1);
        doc.get_map("meta").insert("scalar", 1_i64).expect("set");
        assert_eq!(
            open_root_list(&doc, "meta", "scalar").err(),
            Some(WriteError("meta/scalar does not hold a movable list".to_owned()))
        );
        doc.get_map("meta").insert_container("map", LoroMap::new()).expect("a map");
        assert!(open_root_list(&doc, "meta", "map").is_err());
    }

    #[test]
    fn a_root_entry_is_set_and_deleted() {
        let doc = LoroDoc::new();
        set_root_entry(&doc, "trash", "k", &Value::Map(vec![("n".to_owned(), Value::Number(1.0))]))
            .expect("set");
        assert_eq!(
            peek(&doc, "trash/k"),
            Some(Entry::Value(Value::Map(vec![("n".to_owned(), Value::Number(1.0))])))
        );
        delete_root_entry(&doc, "trash", "k").expect("deleted");
        assert_eq!(peek(&doc, "trash/k"), None);
    }

    #[test]
    fn a_commit_makes_the_version_vector_count_what_was_written_as_the_peer_set() {
        let doc = LoroDoc::new();
        set_peer_id(&doc, 7).expect("peer");
        let id = node(&doc, None);
        set_meta(&doc, T, id, "k", &text("v")).expect("set");
        assert_eq!(doc.len_changes(), 0, "what is written is pending until it is committed");
        commit(&doc);
        assert_eq!(doc.len_changes(), 1);
        assert_eq!(version_pairs(&doc), vec![("7".to_owned(), 2)]);
        assert!(set_peer_id(&doc, u64::MAX).is_err(), "loro refuses its reserved peer id");
    }

    #[test]
    fn a_write_error_says_what_loro_said() {
        let refused = WriteError("no node".to_owned());
        assert_eq!(refused.to_string(), "no node");
        let from_loro: WriteError = loro::LoroError::ArgErr("bad".into()).into();
        assert!(from_loro.to_string().contains("bad"));
    }

    fn copy_all(_: &str, _: Option<ContainerKind>) -> bool {
        true
    }

    const PLAIN: SubtreeCopy<'static> = SubtreeCopy { wanted: &copy_all, finish: &|_, _| Ok(()) };

    /// A node holding one of each kind of entry the copy knows.
    fn rich_node(doc: &LoroDoc) -> NodeId {
        let id = node(doc, None);
        set_meta(doc, T, id, "scalar", &text("s")).expect("set");
        let root = doc.get_tree(T).roots()[0];
        let meta = doc.get_tree(T).get_meta(root).expect("meta");
        let map = meta.insert_container("map", LoroMap::new()).expect("map");
        map.insert("plain", 1_i64).expect("set");
        map.insert("replaced", "text").expect("set");
        let inner = map.ensure_mergeable_map("inner").expect("inner");
        inner.insert("deep", true).expect("set");
        let words = map.insert_container("words", LoroText::new()).expect("words");
        words.insert(0, "hello").expect("insert");
        let items = map.insert_container("items", LoroMovableList::new()).expect("items");
        items.push("a").expect("push");
        items.push(2_i64).expect("push");
        meta.insert_container("body", LoroText::new())
            .expect("body")
            .insert(0, "hi")
            .expect("text");
        let moves = meta.insert_container("moves", LoroMovableList::new()).expect("moves");
        moves.push("x").expect("push");
        meta.insert_container("plainlist", loro::LoroList::new())
            .expect("list")
            .push("y")
            .expect("push");
        id
    }

    #[test]
    fn a_nodes_meta_is_copied_container_by_container() {
        let source = LoroDoc::new();
        let from = rich_node(&source);
        let target = LoroDoc::new();
        let to = node(&target, None);
        copy_meta(at(&source, from), at(&target, to), &copy_all).expect("copied");
        let expected = |doc: &LoroDoc, id: NodeId| -> Vec<(String, Option<Entry>)> {
            tree(doc, T)
                .expect("a tree")
                .keys(id)
                .into_iter()
                .map(|key| {
                    let entry = tree(doc, T).expect("a tree").entry(id, &key);
                    (key, entry)
                })
                .collect()
        };
        let copied = expected(&target, to);
        // A list container is carried as a movable list, as the TypeScript carries it.
        for (key, entry) in expected(&source, from) {
            let got =
                copied.iter().find(|(held, _)| *held == key).expect("the key travels").1.clone();
            match (&entry, &got) {
                (
                    Some(Entry::Container { kind: ContainerKind::List, value }),
                    Some(Entry::Container { kind: ContainerKind::MovableList, value: copied }),
                ) => assert_eq!(value, copied),
                _ => assert_eq!(got, entry, "{key}"),
            }
        }
        assert_eq!(copied.len(), 5);
    }

    #[test]
    fn a_meta_entry_the_filter_refuses_stays_behind_and_it_is_told_the_kind() {
        let source = LoroDoc::new();
        let from = rich_node(&source);
        let target = LoroDoc::new();
        let to = node(&target, None);
        let told = std::cell::RefCell::new(Vec::new());
        let wanted = |key: &str, kind: Option<ContainerKind>| {
            told.borrow_mut().push((key.to_owned(), kind));
            key != "map" && kind != Some(ContainerKind::Text)
        };
        copy_meta(at(&source, from), at(&target, to), &wanted).expect("copied");
        assert_eq!(
            tree(&target, T).expect("a tree").keys(to),
            vec!["moves", "plainlist", "scalar"]
        );
        let told = told.into_inner();
        assert!(told.contains(&("scalar".to_owned(), None)));
        assert!(told.contains(&("map".to_owned(), Some(ContainerKind::Map))));
        assert!(told.contains(&("body".to_owned(), Some(ContainerKind::Text))));
    }

    #[test]
    fn a_subtree_is_copied_in_tree_order_and_exported_as_a_document_of_its_own() {
        let source = LoroDoc::new();
        let root = rich_node(&source);
        let kid = node(&source, Some(root));
        let other = node(&source, Some(root));
        let grandkid = node(&source, Some(kid));
        set_meta(&source, T, kid, "name", &text("kid")).expect("set");
        set_meta(&source, T, other, "name", &text("other")).expect("set");
        set_meta(&source, T, grandkid, "name", &text("grandkid")).expect("set");
        let seen = std::cell::RefCell::new(Vec::new());
        let note = |from: NodeAt<'_>, _: NodeAt<'_>| {
            seen.borrow_mut().push(from.node);
            Ok(())
        };
        let how = SubtreeCopy { wanted: &copy_all, finish: &note };
        let bytes = export_subtree(at(&source, root), &how).expect("exported");
        assert_eq!(seen.borrow().as_slice(), [root, kid, grandkid, other].as_slice());
        let copy = whiteboard_crdt::import_bytes(&bytes).expect("a document");
        let top = tree(&copy, T).expect("a tree").roots();
        assert_eq!(top.len(), 1);
        let names = |parent: NodeId| -> Vec<Option<Entry>> {
            tree(&copy, T)
                .expect("a tree")
                .children(parent)
                .into_iter()
                .map(|child| tree(&copy, T).expect("a tree").entry(child, "name"))
                .collect()
        };
        assert_eq!(
            names(top[0]),
            vec![Some(Entry::Value(text("kid"))), Some(Entry::Value(text("other")))]
        );
        let kid_copy = tree(&copy, T).expect("a tree").children(top[0])[0];
        assert_eq!(names(kid_copy), vec![Some(Entry::Value(text("grandkid")))]);
        assert_eq!(
            whiteboard_crdt::deep_value(&copy),
            whiteboard_crdt::deep_value(&import_snapshot(&bytes))
        );
    }

    fn import_snapshot(bytes: &[u8]) -> LoroDoc {
        let doc = LoroDoc::new();
        doc.import(bytes).expect("a snapshot");
        doc
    }

    #[test]
    fn a_subtree_copied_under_a_parent_hangs_off_it_and_a_failing_hook_stops_the_copy() {
        let source = LoroDoc::new();
        let root = rich_node(&source);
        let target = LoroDoc::new();
        let anchor = node(&target, None);
        let copied =
            copy_subtree(at(&source, root), (&target, T), Some(anchor), &PLAIN).expect("copied");
        assert_eq!(tree(&target, T).expect("a tree").children(anchor), vec![copied]);
        let failing = |_: NodeAt<'_>, _: NodeAt<'_>| Err(WriteError("hook".to_owned()));
        let how = SubtreeCopy { wanted: &copy_all, finish: &failing };
        assert_eq!(
            copy_subtree(at(&source, root), (&target, T), None, &how),
            Err(WriteError("hook".to_owned()))
        );
    }

    #[test]
    fn a_nodes_containers_are_filled_from_another_into_the_ones_it_holds_empty() {
        let source = LoroDoc::new();
        let from = rich_node(&source);
        let target = LoroDoc::new();
        let to = node(&target, None);
        open_meta_container(&target, T, to, "map", ContainerKind::Map).expect("held");
        open_meta_container(&target, T, to, "body", ContainerKind::Text).expect("held");
        open_meta_container(&target, T, to, "moves", ContainerKind::MovableList).expect("held");
        target
            .get_tree(T)
            .get_meta(target.get_tree(T).roots()[0])
            .expect("meta")
            .insert("scalar", "kept")
            .expect("set");
        let changed = fill_meta(at(&source, from), at(&target, to), &|key, kind| {
            key != "skipped" && kind != ContainerKind::Tree
        })
        .expect("filled");
        assert!(changed);
        for key in ["map", "body", "moves", "plainlist"] {
            assert_eq!(
                tree(&target, T).expect("a tree").entry(to, key).map(|entry| match entry {
                    Entry::Container { value, .. } | Entry::Value(value) => value,
                }),
                tree(&source, T).expect("a tree").entry(from, key).map(|entry| match entry {
                    Entry::Container { value, .. } | Entry::Value(value) => value,
                }),
                "{key}"
            );
        }
        assert_eq!(
            tree(&target, T).expect("a tree").entry(to, "scalar"),
            Some(Entry::Value(text("kept")))
        );
        let again = fill_meta(at(&source, from), at(&target, to), &|key, _| key == "nothing")
            .expect("filled");
        assert!(!again, "nothing was admitted");
    }

    /// A node holding numbers npm loro-crdt never stores: a whole double, a
    /// negative zero, an integer past 2^53, in a scalar, a map's value and a list.
    fn foreign_numbers(doc: &LoroDoc) -> NodeId {
        let id = node(doc, None);
        let meta = doc.get_tree(T).get_meta(doc.get_tree(T).roots()[0]).expect("meta");
        meta.insert("stamp", 2.0).expect("a scalar");
        let map = meta.insert_container("map", LoroMap::new()).expect("a map");
        map.insert(
            "v",
            loro::loro_value!({ "x": 1.0, "y": -0.0, "z": 1_152_921_504_606_846_977_i64 }),
        )
        .expect("a value");
        let list = meta.insert_container("moves", LoroMovableList::new()).expect("a list");
        list.push(3.0).expect("an item");
        id
    }

    /// What JavaScript stores back for [`foreign_numbers`]'s map and list.
    fn stored_by_javascript() -> (LoroValue, LoroValue) {
        let map = loro::loro_value!({ "v": { "x": 1_i64, "y": 0_i64, "z": 1_152_921_504_606_846_976.0 } });
        (map, loro::loro_value!([3_i64]))
    }

    #[test]
    fn a_copy_stores_each_number_as_javascript_would() {
        let source = LoroDoc::new();
        let from = foreign_numbers(&source);
        let (map, list) = stored_by_javascript();
        let target = LoroDoc::new();
        let to = node(&target, None);
        copy_meta(at(&source, from), at(&target, to), &copy_all).expect("copied");
        assert_eq!(held(&target, "stamp"), Some(LoroValue::I64(2)));
        assert_eq!(held(&target, "map"), Some(map.clone()));
        assert_eq!(held(&target, "moves"), Some(list.clone()));
        let filled = LoroDoc::new();
        let to = node(&filled, None);
        assert!(fill_meta(at(&source, from), at(&filled, to), &|_, _| true).expect("filled"));
        assert_eq!(held(&filled, "map"), Some(map));
        assert_eq!(held(&filled, "moves"), Some(list));
        assert_eq!(held(&filled, "stamp"), None, "a fill leaves the scalars behind");
    }

    /// Bytes are compared as stored, since JavaScript reads them as a typed
    /// array `jsonEqual` cannot see into: the same bytes write nothing, other
    /// bytes are written.
    #[test]
    fn a_map_entry_of_bytes_is_rewritten_only_when_the_bytes_differ() {
        let fill = |held: &[u8], wanted: &[u8]| {
            let source = LoroDoc::new();
            let from = node(&source, None);
            let meta = source.get_tree(T).get_meta(source.get_tree(T).roots()[0]).expect("meta");
            let map = meta.insert_container("m", LoroMap::new()).expect("a map");
            map.insert("b", LoroValue::Binary(wanted.to_vec().into())).expect("bytes");
            let target = LoroDoc::new();
            let to = node(&target, None);
            let meta = target.get_tree(T).get_meta(target.get_tree(T).roots()[0]).expect("meta");
            let map = meta.insert_container("m", LoroMap::new()).expect("a map");
            map.insert("b", LoroValue::Binary(held.to_vec().into())).expect("bytes");
            fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled")
        };
        assert!(!fill(&[1, 2], &[1, 2]), "the same bytes");
        assert!(fill(&[1, 2], &[3]), "other bytes");
    }

    #[test]
    fn filling_leaves_a_key_held_as_another_kind_alone_and_reports_no_change_for_empty_content() {
        let source = LoroDoc::new();
        let from = node(&source, None);
        open_meta_container(&source, T, from, "map", ContainerKind::Map).expect("empty");
        open_meta_container(&source, T, from, "body", ContainerKind::Text).expect("empty");
        open_meta_container(&source, T, from, "moves", ContainerKind::MovableList).expect("empty");
        let target = LoroDoc::new();
        let to = node(&target, None);
        open_meta_container(&target, T, to, "map", ContainerKind::Text).expect("another kind");
        set_meta(&target, T, to, "body", &text("a scalar")).expect("set");
        let changed = fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled");
        assert!(!changed, "an empty source adds nothing");
        assert!(matches!(
            tree(&target, T).expect("a tree").entry(to, "map"),
            Some(Entry::Container { kind: ContainerKind::Text, .. })
        ));
        assert_eq!(
            tree(&target, T).expect("a tree").entry(to, "body"),
            Some(Entry::Value(text("a scalar")))
        );
        assert!(matches!(
            tree(&target, T).expect("a tree").entry(to, "moves"),
            Some(Entry::Container { kind: ContainerKind::MovableList, .. })
        ));
    }

    #[test]
    fn a_nested_map_is_synced_replacing_what_stands_in_its_way_and_dropping_what_is_gone() {
        let source = LoroDoc::new();
        let from = node(&source, None);
        let source_meta = source.get_tree(T).get_meta(source.get_tree(T).roots()[0]).expect("meta");
        let wanted = source_meta.insert_container("map", LoroMap::new()).expect("map");
        wanted.insert("kept", 1_i64).expect("set");
        wanted.insert("scalar_over_map", "now a value").expect("set");
        wanted.ensure_mergeable_map("map_over_scalar").expect("m").insert("k", 1_i64).expect("set");
        wanted.ensure_mergeable_map("same").expect("m").insert("k", 1_i64).expect("set");
        wanted.insert_container("seq", LoroText::new()).expect("t").insert(0, "t").expect("i");
        let target = LoroDoc::new();
        let to = node(&target, None);
        let target_meta = target.get_tree(T).get_meta(target.get_tree(T).roots()[0]).expect("meta");
        let held = target_meta.insert_container("map", LoroMap::new()).expect("map");
        held.insert("kept", 1_i64).expect("set");
        held.insert("gone", 9_i64).expect("set");
        held.ensure_mergeable_map("scalar_over_map").expect("m");
        held.insert("map_over_scalar", "scalar").expect("set");
        held.ensure_mergeable_map("same").expect("m").insert("k", 1_i64).expect("set");
        held.insert("seq", "was a value").expect("set");
        assert!(fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
        let Some(Entry::Container { value: Value::Map(entries), .. }) =
            tree(&target, T).expect("a tree").entry(to, "map")
        else {
            panic!("a map")
        };
        let keys: Vec<&str> = entries.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, vec!["kept", "map_over_scalar", "same", "scalar_over_map", "seq"]);
        let get = |key: &str| entries.iter().find(|(held, _)| held == key).map(|(_, v)| v.clone());
        assert_eq!(get("scalar_over_map"), Some(text("now a value")));
        assert_eq!(
            get("map_over_scalar"),
            Some(Value::Map(vec![("k".to_owned(), Value::Number(1.0))]))
        );
        assert_eq!(get("seq"), Some(text("t")));
        assert!(fill_meta(at(&source, from), at(&target, to), &|_, _| true).is_ok());
    }

    #[test]
    fn a_container_name_past_the_bound_is_made_with_an_op_created_id() {
        let source = LoroDoc::new();
        let from = node(&source, None);
        let long_key = "k".repeat(1100);
        let source_meta = source.get_tree(T).get_meta(source.get_tree(T).roots()[0]).expect("meta");
        let map = source_meta.insert_container("map", LoroMap::new()).expect("map");
        map.insert_container(&long_key, LoroMap::new())
            .expect("child")
            .insert("v", 1_i64)
            .expect("s");
        map.ensure_mergeable_map("short").expect("m").insert("v", 2_i64).expect("s");
        let target = LoroDoc::new();
        let to = node(&target, None);
        assert!(fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
        let Value::Map(roots) = deep_value(&target) else { panic!("roots") };
        assert!(!roots.is_empty());
        let exported = target.export(ExportMode::Snapshot).expect("export");
        let reopened = import_snapshot(&exported);
        assert_eq!(deep_value(&reopened), deep_value(&target));
        let mergeable_ids = target.get_deep_value_with_id();
        let text = format!("{mergeable_ids:?}");
        assert!(text.contains("cid:"), "the copy holds containers with ids");
    }

    fn ops(doc: &LoroDoc) -> i64 {
        commit(doc);
        version_pairs(doc).iter().map(|(_, n)| *n).sum()
    }

    /// A node holding a map with `entries`, a text and a movable list, the way a document node does.
    fn held_node(doc: &LoroDoc, entries: &[(&str, &str)], body: &str, items: &[&str]) -> NodeId {
        let id = node(doc, None);
        let root = *doc.get_tree(T).roots().last().expect("a root");
        let meta = doc.get_tree(T).get_meta(root).expect("meta");
        let map = meta.insert_container("map", LoroMap::new()).expect("map");
        for (key, value) in entries {
            map.insert(key, *value).expect("set");
        }
        meta.insert_container("body", LoroText::new())
            .expect("body")
            .insert(0, body)
            .expect("text");
        let list = meta.insert_container("moves", LoroMovableList::new()).expect("moves");
        for item in items {
            list.push(*item).expect("push");
        }
        id
    }

    #[test]
    fn filling_content_that_is_already_equal_changes_nothing_and_unequal_content_is_rewritten() {
        let source = LoroDoc::new();
        let from = held_node(&source, &[("a", "1"), ("b", "2")], "hello", &["x", "y"]);
        let target = LoroDoc::new();
        let to = held_node(&target, &[("a", "1"), ("b", "2")], "hello", &["x", "y"]);
        let before = ops(&target);
        assert!(!fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
        assert_eq!(ops(&target), before, "equal content appends nothing");
        let other = LoroDoc::new();
        let stale = held_node(&other, &[("a", "1"), ("b", "2"), ("c", "3")], "old text", &["y"]);
        assert!(fill_meta(at(&source, from), at(&other, stale), &|_, _| true).expect("filled"));
        for key in ["map", "body", "moves"] {
            assert_eq!(
                tree(&other, T).expect("a tree").entry(stale, key),
                tree(&source, T).expect("a tree").entry(from, key),
                "{key} reads as the source does"
            );
        }
    }

    #[test]
    fn a_key_only_the_target_holds_is_a_change_on_its_own() {
        let source = LoroDoc::new();
        let from = held_node(&source, &[("a", "1")], "", &[]);
        let target = LoroDoc::new();
        let to = held_node(&target, &[("a", "1"), ("extra", "e")], "", &[]);
        assert!(fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
        assert!(!fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
    }

    #[test]
    fn a_plain_value_that_replaces_a_container_deletes_it_first() {
        let source = LoroDoc::new();
        let from = held_node(&source, &[("k", "now a value")], "", &[]);
        let target = LoroDoc::new();
        let to = held_node(&target, &[], "", &[]);
        let root = target.get_tree(T).roots()[0];
        let Some(loro::ValueOrContainer::Container(loro::Container::Map(map))) =
            target.get_tree(T).get_meta(root).expect("meta").get("map")
        else {
            panic!("a map")
        };
        map.ensure_mergeable_map("k").expect("a container where the value goes");
        let before = ops(&target);
        assert!(fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
        assert_eq!(ops(&target) - before, 2, "a delete, then the value");
        assert_eq!(
            tree(&target, T).expect("a tree").entry(to, "map"),
            tree(&source, T).expect("a tree").entry(from, "map")
        );
    }

    #[test]
    fn a_text_the_target_lacks_is_opened_for_the_copy() {
        let source = LoroDoc::new();
        let from = held_node(&source, &[], "hi", &["only"]);
        let target = LoroDoc::new();
        let to = node(&target, None);
        assert!(fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
        assert_eq!(
            tree(&target, T).expect("a tree").entry(to, "body"),
            tree(&source, T).expect("a tree").entry(from, "body")
        );
        assert_eq!(
            tree(&target, T).expect("a tree").entry(to, "moves"),
            tree(&source, T).expect("a tree").entry(from, "moves")
        );
        assert_eq!(
            tree(&target, T).expect("a tree").entry(to, "map"),
            tree(&source, T).expect("a tree").entry(from, "map")
        );
    }

    #[test]
    fn a_nested_map_child_is_mergeable_unless_its_name_would_pass_the_bound() {
        let id_chars = |doc: &LoroDoc| -> usize {
            let root = doc.get_tree(T).roots()[0];
            match doc.get_tree(T).get_meta(root).expect("meta").get("map") {
                Some(loro::ValueOrContainer::Container(map)) => map.id().to_string().len(),
                _ => panic!("a map"),
            }
        };
        for (extra, mergeable) in [(0_usize, true), (1, false)] {
            let target = LoroDoc::new();
            let to = held_node(&target, &[], "", &[]);
            let key = "k".repeat(1024 - id_chars(&target) + extra);
            let source = LoroDoc::new();
            let from = held_node(&source, &[], "", &[]);
            let root = source.get_tree(T).roots()[0];
            let Some(loro::ValueOrContainer::Container(loro::Container::Map(map))) =
                source.get_tree(T).get_meta(root).expect("meta").get("map")
            else {
                panic!("a map")
            };
            map.insert_container(&key, LoroMap::new())
                .expect("child")
                .insert("v", 1_i64)
                .expect("set");
            assert!(fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
            let root = target.get_tree(T).roots()[0];
            let Some(loro::ValueOrContainer::Container(loro::Container::Map(held))) =
                target.get_tree(T).get_meta(root).expect("meta").get("map")
            else {
                panic!("a map")
            };
            let Some(loro::ValueOrContainer::Container(child)) = held.get(&key) else {
                panic!("the child")
            };
            assert_eq!(
                matches!(child.id(), loro::ContainerID::Root { .. }),
                mergeable,
                "{extra}: a name at the bound is mergeable and one past it is not"
            );
        }
    }

    #[test]
    fn the_deep_value_with_ids_names_every_container_beside_what_it_holds() {
        let doc = LoroDoc::new();
        set_root_entry(&doc, "trash", "k", &Value::Number(1.0)).expect("set");
        let id = node(&doc, None);
        set_meta(&doc, T, id, "k", &text("v")).expect("set");
        commit(&doc);
        let Value::Map(roots) = deep_value_with_id(&doc) else { panic!("roots") };
        let held = |roots: &[(String, Value)], key: &str| {
            roots.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
        };
        let Some(Value::Map(trash)) = held(&roots, "trash") else { panic!("a container") };
        assert_eq!(held(&trash, "cid"), Some(text("cid:root-trash:Map")));
        assert_eq!(
            held(&trash, "value"),
            Some(Value::Map(vec![("k".to_owned(), Value::Number(1.0))]))
        );
        let Some(Value::Map(tree)) = held(&roots, "t") else { panic!("the tree") };
        assert_eq!(held(&tree, "cid"), Some(text("cid:root-t:Tree")));
        assert_ne!(deep_value_with_id(&doc), deep_value(&doc));
    }

    #[test]
    fn a_plain_value_that_differs_is_replaced_and_one_that_is_equal_is_left() {
        let source = LoroDoc::new();
        let from = held_node(&source, &[("same", "s"), ("differs", "new")], "", &[]);
        let target = LoroDoc::new();
        let to = held_node(&target, &[("same", "s"), ("differs", "old")], "", &[]);
        let before = ops(&target);
        assert!(fill_meta(at(&source, from), at(&target, to), &|_, _| true).expect("filled"));
        assert_eq!(ops(&target) - before, 1, "only the value that differs is written");
        assert_eq!(
            tree(&target, T).expect("a tree").entry(to, "map"),
            tree(&source, T).expect("a tree").entry(from, "map")
        );
    }

    #[test]
    fn a_write_to_a_deleted_node_is_refused_by_every_writer() {
        let doc = LoroDoc::new();
        let gone = node(&doc, None);
        let kept = held_node(&doc, &[("k", "v")], "t", &["i"]);
        delete_node(&doc, T, gone).expect("deleted");
        assert!(set_meta(&doc, T, gone, "k", &text("v")).is_err());
        assert!(delete_meta(&doc, T, gone, "k").is_err());
        assert!(open_meta_container(&doc, T, gone, "k", ContainerKind::Map).is_err());
        assert!(copy_meta(at(&doc, kept), at(&doc, gone), &copy_all).is_err());
        assert!(fill_meta(at(&doc, kept), at(&doc, gone), &|_, _| true).is_err());
    }

    #[test]
    fn a_node_answers_the_entry_it_holds_at_a_key_and_none_for_another() {
        let doc = LoroDoc::new();
        let id = rich_node(&doc);
        assert_eq!(at(&doc, id).entry("scalar"), Some(Entry::Value(text("s"))));
        assert!(matches!(
            at(&doc, id).entry("body"),
            Some(Entry::Container { kind: ContainerKind::Text, .. })
        ));
        assert_eq!(at(&doc, id).entry("absent"), None);
    }

    #[test]
    fn a_subtree_copied_under_its_own_root_copies_what_was_there_and_ends() {
        let doc = LoroDoc::new();
        let root = rich_node(&doc);
        let kid = node(&doc, Some(root));
        set_meta(&doc, T, kid, "name", &text("kid")).expect("set");
        let copied = copy_subtree(at(&doc, root), (&doc, T), Some(root), &PLAIN).expect("copied");
        let held = tree(&doc, T).expect("a tree");
        assert_eq!(held.children(root), vec![kid, copied]);
        let grown = held.children(copied);
        assert_eq!(grown.len(), 1, "the copy holds the one kid the source held");
        assert_eq!(held.entry(grown[0], "name"), Some(Entry::Value(text("kid"))));
        assert_eq!(held.children(kid), Vec::<NodeId>::new());
    }
}
