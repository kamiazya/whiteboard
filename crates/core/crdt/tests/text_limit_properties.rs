//! The text-limit judge of a state as properties over documents written here:
//! a value, a board, a thread or a body at a ceiling is kept, one past it is
//! the breach that bound names, a document under every bound is kept, and a
//! node stored in a retired shape is named whatever else the board holds.
//!
//! The expectations come from the ceilings and from what was written — the
//! length drawn, the count built — so they share nothing with the judge.

use loro::{LoroDoc, LoroMap, LoroValue, loro_value};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{BreachShape, TextBreach, judge_state};
use whiteboard_model::Value;
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};

/// Where a bounded value is written: the map, the value's shape, the ceiling,
/// and the breach's shape and field naming the amount.
#[derive(Debug, Clone, Copy)]
struct Site {
    map: &'static str,
    max: usize,
    shape: BreachShape,
    amount: &'static str,
    value: Build,
}

/// How a site's value is built from a string of the drawn length, or a count.
type Build = fn(String, usize) -> LoroValue;

#[cfg(test)]
const fn site(map: &'static str, max: usize, shape: BreachShape, value: Build) -> Site {
    let amount = if matches!(shape, BreachShape::Tags) { "amount" } else { "chars" };
    Site { map, max, shape, amount, value }
}

#[cfg(test)]
fn node_text(s: String, _: usize) -> LoroValue {
    loro_value!({ "id": "x", "resource": { "content": s } })
}

#[cfg(test)]
fn node_location(s: String, _: usize) -> LoroValue {
    loro_value!({ "id": "x", "resource": { "location": s } })
}

#[cfg(test)]
fn labelled(s: String, _: usize) -> LoroValue {
    loro_value!({ "id": "x", "label": s })
}

#[cfg(test)]
fn tagged(_: String, n: usize) -> LoroValue {
    LoroValue::Map(vec![("tags".to_owned(), tags(n))].into_iter().collect())
}

#[cfg(test)]
fn one_long_tag(s: String, _: usize) -> LoroValue {
    let held = LoroValue::List(vec![LoroValue::from(s)].into());
    LoroValue::Map(vec![("tags".to_owned(), held)].into_iter().collect())
}

#[cfg(test)]
fn board_tags(_: String, n: usize) -> LoroValue {
    tags(n)
}

#[cfg(test)]
const SITES: [Site; 8] = [
    site("nodes", 8192, BreachShape::NodeText, node_text),
    site("nodes", 8192, BreachShape::NodeLocation, node_location),
    site("nodes", 1024, BreachShape::Label, labelled),
    site("edges", 1024, BreachShape::Label, labelled),
    site("lines", 1024, BreachShape::Label, labelled),
    site("edges", 1024, BreachShape::Tags, tagged),
    site("nodes", 1024, BreachShape::Tags, one_long_tag),
    site("canvas", 1024, BreachShape::Tags, board_tags),
];

#[cfg(test)]
fn tags(n: usize) -> LoroValue {
    LoroValue::List((0..n).map(|i| LoroValue::from(format!("t{i}"))).collect::<Vec<_>>().into())
}

/// The field a breach names the amount in.
#[cfg(test)]
fn amount_of(breach: &TextBreach, field: &str) -> Option<Value> {
    breach.fields.iter().find(|(key, _)| *key == field).map(|(_, held)| held.clone())
}

/// A count as the breach writes it.
#[cfg(test)]
fn number(n: usize) -> Value {
    Value::Number(f64::from(u32::try_from(n).expect("a small count")))
}

/// A string of `units` UTF-16 units: ASCII, or emoji with one ASCII when odd.
#[cfg(test)]
fn text_of(units: usize, wide: bool) -> String {
    if wide { "\u{1F600}".repeat(units / 2) + &"a".repeat(units % 2) } else { "a".repeat(units) }
}

/// A count at a ceiling or a few under it, or a few past it, as often one as
/// the other: the two sides of the bound are what the properties are about.
#[cfg(test)]
fn around(max: usize) -> impl Strategy<Value = usize> {
    (prop::bool::ANY, 0_usize..=2)
        .prop_map(move |(over, by)| if over { max + 1 + by } else { max - by })
}

#[test]
fn a_value_one_past_its_ceiling_is_named_and_one_at_it_is_kept() {
    let over = Floor::new("a value past its ceiling");
    let at_or_under = Floor::new("a value at or under its ceiling");
    let shortened = Floor::new("a value written past its ceiling, then to at or under it");
    let strategy = (0..SITES.len(), 0_usize..=3, prop::bool::ANY, prop::bool::ANY, prop::bool::ANY);
    check(strategy, Some(96), |(site, off, up, wide, rewritten)| {
        let site = SITES[site];
        let units = if up { site.max + off } else { site.max - off };
        let doc = LoroDoc::new();
        let key = if site.map == "canvas" { "tags" } else { "x" };
        let map = doc.get_map(site.map);
        if rewritten {
            let past = site.max + 1;
            map.insert(key, (site.value)(text_of(past, wide), past)).expect("written");
            doc.commit();
        }
        map.insert(key, (site.value)(text_of(units, wide), units)).expect("written");
        shortened.draw(rewritten && units <= site.max);
        let judged = judge_state(&doc).expect("judged");
        over.draw(units > site.max);
        at_or_under.draw(units <= site.max);
        if units > site.max {
            let breach = judged.expect("a breach");
            prop_assert_eq!(breach.shape, site.shape);
            prop_assert_eq!(amount_of(&breach, site.amount), Some(number(units)));
        } else {
            prop_assert!(judged.is_none(), "{judged:?}");
        }
        Ok(())
    });
    over.assert(16);
    at_or_under.assert(16);
    shortened.assert(8);
}

/// The maps `names` of one document: roots of `doc`, or children of one
/// workspace tree node's meta map.
#[cfg(test)]
fn maps(doc: &LoroDoc, hosted: bool, names: &[&str]) -> Vec<LoroMap> {
    if !hosted {
        return names.iter().map(|name| doc.get_map(*name)).collect();
    }
    let tree = doc.get_tree("tree");
    let meta = tree.get_meta(tree.create(None).expect("a node")).expect("meta");
    names.iter().map(|name| meta.insert_container(name, LoroMap::new()).expect("a map")).collect()
}

#[cfg(test)]
fn entries(doc: &LoroDoc, hosted: bool, name: &str) -> LoroMap {
    maps(doc, hosted, &[name]).remove(0)
}

#[test]
fn a_board_one_past_its_ceiling_is_named_and_one_at_it_is_kept() {
    let over = Floor::new("a board past its ceiling");
    let kept = Floor::new("a board at or under its ceiling");
    let strategy = (prop::bool::ANY, prop::bool::ANY, around(2000), 0_usize..=2002);
    check(strategy, Some(24), |(edges, hosted, count, lines_share)| {
        let doc = LoroDoc::new();
        let names: &[&str] = if edges { &["edges", "lines"] } else { &["nodes"] };
        let split = if edges { lines_share.min(count) } else { 0 };
        let boards = maps(&doc, hosted, names);
        for (i, map) in boards.iter().enumerate() {
            let (from, to) = if i == 0 { (0, count - split) } else { (count - split, count) };
            for at in from..to {
                map.insert(&format!("e{at}"), loro_value!({ "id": "e" })).expect("an entry");
            }
        }
        let judged = judge_state(&doc).expect("judged");
        over.draw(count > 2000);
        kept.draw(count <= 2000);
        if count > 2000 {
            let breach = judged.expect("a breach");
            prop_assert_eq!(breach.shape, BreachShape::CanvasSize);
            prop_assert_eq!(amount_of(&breach, "count"), Some(number(count)));
        } else {
            prop_assert!(judged.is_none(), "{judged:?}");
        }
        Ok(())
    });
    over.assert(4);
    kept.assert(4);
}

/// What a document's annotation layer is drawn as: how many threads are
/// open, how many resolved, and how many messages the first one holds.
#[cfg(test)]
fn annotation_layer() -> impl Strategy<Value = (usize, usize, usize, bool)> {
    prop_oneof![
        (around(500), 0_usize..=2, Just(1_usize), prop::bool::ANY),
        (Just(1_usize), Just(0_usize), around(1000), prop::bool::ANY),
    ]
}

#[test]
fn a_document_one_past_an_annotation_ceiling_is_named_and_one_at_it_is_kept() {
    let over = Floor::new("an annotation count past its ceiling");
    let kept = Floor::new("annotation counts at or under their ceilings");
    check(annotation_layer(), Some(24), |(open, resolved, messages, hosted)| {
        let doc = LoroDoc::new();
        let threads = entries(&doc, hosted, "threads");
        for i in 0..open + resolved {
            let thread =
                threads.insert_container(&format!("t{i}"), LoroMap::new()).expect("a thread");
            thread.insert("status", if i < open { "open" } else { "resolved" }).expect("status");
            if i == 0 {
                let held = thread.insert_container("messages", LoroMap::new()).expect("messages");
                for m in 0..messages {
                    held.insert(&format!("m{m}"), loro_value!({ "id": "m", "body": "x" }))
                        .expect("a message");
                }
            }
        }
        let judged = judge_state(&doc).expect("judged");
        let expected = if open > 500 {
            Some((BreachShape::OpenThreads, Some(number(open))))
        } else if messages > 1000 {
            Some((BreachShape::ThreadMessages, Some(number(messages))))
        } else {
            None
        };
        over.draw(expected.is_some());
        kept.draw(expected.is_none());
        let got = judged.map(|breach| (breach.shape, amount_of(&breach, "count")));
        prop_assert_eq!(got, expected);
        Ok(())
    });
    over.assert(4);
    kept.assert(4);
}

#[test]
fn a_body_one_past_its_ceiling_is_named_and_one_at_it_is_kept() {
    let over = Floor::new("a body past its ceiling");
    let kept = Floor::new("a body at or under its ceiling");
    let strategy = (around(262_144), prop::bool::ANY, 0_usize..=3);
    check(strategy, Some(24), |(units, wide, trimmed)| {
        let doc = LoroDoc::new();
        let body = doc.get_text("body");
        body.insert(0, &text_of(units + trimmed * 2, wide)).expect("inserted");
        doc.commit();
        if trimmed > 0 {
            body.delete_utf16(0, trimmed * 2).expect("trimmed");
        }
        let judged = judge_state(&doc).expect("judged");
        over.draw(units > 262_144);
        kept.draw(units <= 262_144);
        if units > 262_144 {
            let breach = judged.expect("a breach");
            prop_assert_eq!(breach.shape, BreachShape::Body);
            prop_assert_eq!(amount_of(&breach, "chars"), Some(number(units)));
        } else {
            prop_assert!(judged.is_none(), "{judged:?}");
        }
        Ok(())
    });
    over.assert(4);
    kept.assert(4);
}

/// A node written to a board: its text length, and whether it carries the
/// retired extension key.
#[cfg(test)]
fn board() -> impl Strategy<Value = Vec<(usize, bool)>> {
    prop::collection::vec((0_usize..=64, prop::bool::weighted(0.15)), 0..12)
}

#[test]
fn a_board_under_every_ceiling_is_kept_unless_a_node_is_retired() {
    let retired = Floor::new("a board holding a retired node");
    let kept = Floor::new("a board holding none");
    check((board(), prop::bool::ANY), None, |(nodes, hosted)| {
        let doc = LoroDoc::new();
        let map = entries(&doc, hosted, "nodes");
        for (i, (len, old)) in nodes.iter().enumerate() {
            let mut value = vec![
                ("id".to_owned(), LoroValue::from(format!("n{i}"))),
                ("label".to_owned(), LoroValue::from("l".repeat(*len))),
            ];
            if *old {
                value.push(("x-whiteboard".to_owned(), loro_value!({})));
            }
            map.insert(&format!("n{i}"), LoroValue::Map(value.into_iter().collect()))
                .expect("a node");
        }
        let first_old = nodes.iter().position(|(_, old)| *old);
        retired.draw(first_old.is_some());
        kept.draw(first_old.is_none());
        let judged = judge_state(&doc).expect("judged");
        match first_old {
            Some(at) => {
                let breach = judged.expect("a breach");
                prop_assert_eq!(breach.shape, BreachShape::RetiredShape);
                let found =
                    format!("node \"n{at}\" stored under the pre-ADR-0037 `x-whiteboard` key");
                prop_assert!(
                    breach
                        .fields
                        .iter()
                        .any(|(k, v)| *k == "found" && *v == Value::String(found.clone())),
                    "{breach:?}"
                );
            }
            None => prop_assert!(judged.is_none(), "{judged:?}"),
        }
        Ok(())
    });
    retired.assert(30);
    kept.assert(30);
}
