//! The whole-document reads: the size a state is charged in and the digest
//! that names its content. The expectations are the TypeScript's answers for
//! documents built the same way, and the properties state the definition
//! again from the entries written, sharing nothing with the reader.

use loro::{LoroDoc, LoroMap, LoroMapValue, LoroValue};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{answer_content_query, content_digest_of_document, state_size};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName};
use whiteboard_proptest::proptest::prelude::{any, prop, prop_assert, prop_assert_eq};
use whiteboard_proptest::{Floor, check};

const EMPTY_DIGEST: &str = "f6bbc27f5a56d1e7";

#[cfg(test)]
fn put(doc: &LoroDoc, root: &str, key: &str, value: LoroValue) {
    doc.get_map(root).insert(key, value).expect("an entry");
}

#[cfg(test)]
fn record<const N: usize>(entries: [(&str, LoroValue); N]) -> LoroValue {
    LoroValue::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect::<LoroMapValue>())
}

#[cfg(test)]
fn node(id: &str, label: &str, x: f64) -> LoroValue {
    record([
        ("id", LoroValue::from(id)),
        ("label", LoroValue::from(label)),
        ("x", LoroValue::Double(x)),
    ])
}

#[cfg(test)]
fn ask(doc: &LoroDoc, name: QueryName) -> Value {
    let query = Query { query: name, args: None };
    let answer = answer_content_query(doc, &query).expect("answered");
    let Value::Map(entries) = answer.value else { panic!("an answer is a map") };
    entries.into_iter().find(|(key, _)| key == "ok").expect("an ok answer").1
}

#[test]
fn a_state_is_charged_per_entry_and_per_utf16_unit() {
    let doc = LoroDoc::new();
    put(&doc, "nodes", "n1", node("n1", "é😀", 1.5));
    doc.get_text("body").insert(0, "hi 😀").expect("text");
    put(&doc, "other", "k", LoroValue::from("ignored"));
    assert_eq!(state_size(&doc), 25);
    assert_eq!(ask(&doc, QueryName::StateSize), Value::Number(25.0));
}

#[test]
fn a_root_that_holds_nothing_is_one_and_no_root_is_none() {
    assert_eq!(state_size(&LoroDoc::new()), 0);
    let doc = LoroDoc::new();
    drop((doc.get_map("nodes"), doc.get_text("body")));
    assert_eq!(state_size(&doc), 2);
    assert_eq!(content_digest_of_document(&doc), EMPTY_DIGEST);
}

#[test]
fn a_list_costs_its_length_and_what_it_holds() {
    let doc = LoroDoc::new();
    let list = doc.get_movable_list("lst");
    list.push("x").expect("push");
    list.push(1).expect("push");
    doc.get_map("m").insert("a", true).expect("entry");
    assert_eq!(state_size(&doc), 6);
    assert_eq!(content_digest_of_document(&doc), EMPTY_DIGEST, "neither root is content");
}

#[test]
fn a_key_a_javascript_object_cannot_hold_is_not_counted_or_named() {
    let doc = LoroDoc::new();
    put(&doc, "nodes", "__proto__", LoroValue::from("x"));
    put(&doc, "nodes", "k", LoroValue::from("v"));
    assert_eq!(state_size(&doc), 3);
    assert_eq!(content_digest_of_document(&doc), "c2bcf59305ed3081");
}

#[test]
fn the_digest_names_the_content_roots_and_what_nests_in_them() {
    let doc = LoroDoc::new();
    put(&doc, "nodes", "n1", node("n1", "é😀", 1.5));
    doc.get_text("body").insert(0, "hi 😀").expect("text");
    put(&doc, "other", "k", LoroValue::from("ignored"));
    assert_eq!(content_digest_of_document(&doc), "e12c87bac141f18e");
    assert_eq!(ask(&doc, QueryName::ContentDigest), Value::String("e12c87bac141f18e".into()));

    let nested = LoroDoc::new();
    let child =
        nested.get_map("facets").insert_container("f", LoroMap::new()).expect("a child container");
    child.insert("v", "abc").expect("entry");
    child.insert("w", LoroValue::Null).expect("entry");
    let list = LoroValue::from(vec![
        LoroValue::I64(1),
        LoroValue::from("zz"),
        record([("q", LoroValue::I64(2))]),
    ]);
    put(&nested, "nodes", "n", record([("p", list)]));
    assert_eq!(state_size(&nested), 16);
    assert_eq!(content_digest_of_document(&nested), "e163c4b72c6be3f8");
}

#[test]
fn a_query_that_names_an_argument_is_left_to_the_caller() {
    let doc = LoroDoc::new();
    let args = Some(Value::Map(vec![("kind".into(), Value::String("spatial".into()))]));
    for name in [QueryName::StateSize, QueryName::ContentDigest] {
        assert!(answer_content_query(&doc, &Query { query: name, args: args.clone() }).is_none());
    }
}

#[cfg(test)]
fn entries() -> impl whiteboard_proptest::proptest::prelude::Strategy<Value = Vec<String>> {
    prop::collection::vec(any::<String>(), 0..8)
}

#[test]
fn the_size_is_what_the_entries_written_add_up_to() {
    let several = Floor::new("a document holding several entries");
    check(entries(), None, |labels| {
        let doc = LoroDoc::new();
        for (index, label) in labels.iter().enumerate() {
            put(&doc, "nodes", &format!("k{index}"), LoroValue::from(label.as_str()));
        }
        several.draw(labels.len() > 2);
        let held: usize = labels.iter().map(|label| 1 + label.encode_utf16().count()).sum();
        // The root exists once something is written to it.
        let root = usize::from(!labels.is_empty());
        prop_assert_eq!(state_size(&doc), root + held);
        Ok(())
    });
    several.assert(40);
}

#[test]
fn the_digest_is_the_content_and_not_the_order_it_arrived_in() {
    let several = Floor::new("a document holding several entries");
    check((entries(), any::<String>()), None, |(labels, other)| {
        let written = |order: Vec<usize>, labels: &[String]| {
            let doc = LoroDoc::new();
            for index in order {
                put(&doc, "nodes", &format!("k{index}"), LoroValue::from(labels[index].as_str()));
            }
            doc
        };
        let forward = written((0..labels.len()).collect(), &labels);
        let backward = written((0..labels.len()).rev().collect(), &labels);
        several.draw(labels.len() > 2);
        prop_assert_eq!(
            content_digest_of_document(&forward),
            content_digest_of_document(&backward)
        );
        if let Some(first) = labels.first().filter(|first| **first != other) {
            let mut changed = labels.clone();
            changed[0] = other;
            let altered = written((0..changed.len()).collect(), &changed);
            prop_assert!(
                content_digest_of_document(&altered) != content_digest_of_document(&forward),
                "{first:?} and {:?} name one content",
                changed[0]
            );
        }
        Ok(())
    });
    several.assert(40);
}
