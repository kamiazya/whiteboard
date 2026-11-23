//! The facet buckets' writers as properties over buckets written here: a
//! replace and a reconcile from what was stored both leave the bucket the
//! caller stated, and stating it again writes nothing.
//!
//! Every stored bucket holds, by construction, a key the next one keeps as it
//! is, one it changes and one it drops, so every draw reaches all three; the
//! random rest is more keys from a pool the fixed ones are not in. The bucket
//! left is expected from the one drawn, not read back through a writer.

use std::collections::BTreeMap;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroDoc, WriteAnswer, deep_value, write_batch};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert, prop_assert_eq};
use whiteboard_proptest::{Floor, check};

type Bucket = BTreeMap<String, u8>;

#[cfg(test)]
fn object(bucket: &Bucket) -> Value {
    Value::Map(bucket.iter().map(|(k, v)| (k.clone(), Value::Number(f64::from(*v)))).collect())
}

#[cfg(test)]
fn args(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

/// A stored bucket and the next one: the random keys of each, then the fixed
/// `keep`, `move` and `drop`.
#[cfg(test)]
fn buckets() -> impl Strategy<Value = (Bucket, Bucket)> {
    let random =
        || prop::collection::btree_map((0_u8..6).prop_map(|k| format!("k{k}")), 0_u8..4, 0..5);
    (random(), random()).prop_map(|(mut stored, mut next)| {
        stored.extend([("keep".to_owned(), 1), ("move".to_owned(), 2), ("drop".to_owned(), 3)]);
        next.extend([("keep".to_owned(), 1), ("move".to_owned(), 9)]);
        (stored, next)
    })
}

#[cfg(test)]
fn apply(before: &[u8], op: WriterName, args: Value) -> (bool, LoroDoc) {
    let done = write_batch(before, 3, &[Write { op, args }], WriteJudge::None).expect("answered");
    let WriteAnswer::Applied(applied) = done.answer else { panic!("applied") };
    (applied.local_update.is_some(), done.doc)
}

#[cfg(test)]
fn snapshot(doc: &LoroDoc) -> Vec<u8> {
    doc.export(ExportMode::Snapshot).expect("a snapshot")
}

#[cfg(test)]
fn facets_of(doc: &LoroDoc) -> Bucket {
    let Value::Map(roots) = deep_value(doc) else { return Bucket::new() };
    let Some((_, Value::Map(facets))) = roots.into_iter().find(|(k, _)| k == "facets") else {
        return Bucket::new();
    };
    facets
        .into_iter()
        .map(|(k, v)| match v {
            Value::Number(n) => (k, n.to_string().parse().expect("a small number")),
            other => panic!("{k}: {other:?}"),
        })
        .collect()
}

#[test]
#[cfg(test)]
fn a_replace_and_a_reconcile_leave_the_stated_bucket_and_restating_it_writes_nothing() {
    let all_three = Floor::new("a bucket that kept, changed and dropped a key");
    check(buckets(), None, |(stored, next)| {
        let empty = snapshot(&LoroDoc::new());
        let (_, held) =
            apply(&empty, WriterName::WriteFacets, args(vec![("facets", object(&stored))]));
        let held = snapshot(&held);
        let (replaced, by_replace) =
            apply(&held, WriterName::WriteFacets, args(vec![("facets", object(&next))]));
        let reconcile = args(vec![("prev", object(&stored)), ("next", object(&next))]);
        let (reconciled, by_reconcile) = apply(&held, WriterName::ReconcileFacets, reconcile);
        prop_assert!(replaced && reconciled);
        prop_assert_eq!(&facets_of(&by_replace), &next);
        prop_assert_eq!(&facets_of(&by_reconcile), &next);
        let restate = args(vec![("facets", object(&next))]);
        let (again, _) = apply(&snapshot(&by_replace), WriterName::WriteFacets, restate);
        prop_assert!(!again, "a replace with what is stored wrote");
        let same = args(vec![("prev", object(&next)), ("next", object(&next))]);
        let (again, _) = apply(&snapshot(&by_reconcile), WriterName::ReconcileFacets, same);
        prop_assert!(!again, "a reconcile with nothing changed wrote");
        let left = facets_of(&by_replace);
        all_three.draw(
            left.get("keep") == stored.get("keep")
                && left.get("move") != stored.get("move")
                && !left.contains_key("drop"),
        );
        Ok(())
    });
    all_three.assert(150);
}
