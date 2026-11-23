//! The annotation layer as properties over documents written here: a thread
//! valid by construction is read back with its messages in the one order two
//! replicas agree on, and a passage's mark names its thread through an escape
//! the reader undoes, whatever the id holds.
//!
//! The expectations are built from what was stored (a sort on UTF-16 vectors, an
//! encoder written beside the test), so they share nothing with the readers
//! they judge.

use std::fmt::Write;

use loro::{ExpandType, LoroDoc, LoroMap, StyleConfig, StyleConfigMap};
use serde_json::{Value as Json, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::answer_content_query;
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName};
use whiteboard_proptest::proptest::prelude::{Just, Strategy, any, prop, prop_assert_eq};
use whiteboard_proptest::{Floor, check};

#[cfg(test)]
fn model_of(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().unwrap_or(0.0)),
        Json::String(s) => Value::String(s.clone()),
        Json::Array(items) => Value::Seq(items.iter().map(model_of).collect()),
        Json::Object(entries) => {
            let mut map: Vec<(String, Value)> =
                entries.iter().map(|(k, v)| (k.clone(), model_of(v))).collect();
            map.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Map(map)
        }
    }
}

#[cfg(test)]
fn answer(doc: &LoroDoc, query: QueryName) -> Value {
    answer_content_query(doc, &Query { query, args: None }).expect("answered").value
}

/// A stored message: its own id, when it was written (or not), and a body.
#[cfg(test)]
fn message() -> impl Strategy<Value = Json> {
    (
        "[a-c\u{ff5e}\u{1F600}]{1,2}",
        prop::option::of(prop::sample::select(&[
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:01Z",
            "2025-12-31T23:59:59+09:00",
        ])),
        "[a-z]{1,4}",
    )
        .prop_map(|(id, at, body)| match at {
            Some(at) => json!({ "id": id, "body": body, "createdAt": at }),
            None => json!({ "id": id, "body": body }),
        })
}

#[cfg(test)]
fn key_of(message: &Json, field: &str) -> Vec<u16> {
    message.get(field).and_then(Json::as_str).unwrap_or_default().encode_utf16().collect()
}

#[cfg(test)]
fn written(threads: &[(String, Vec<Json>)]) -> LoroDoc {
    let doc = LoroDoc::new();
    let map = doc.get_map("threads");
    for (id, messages) in threads {
        let thread = map.insert_container(id, LoroMap::new()).expect("thread");
        thread.insert("anchor", lv(&json!({ "kind": "document" }))).expect("anchor");
        thread.insert("status", "open").expect("status");
        let held = thread.insert_container("messages", LoroMap::new()).expect("messages");
        for (at, message) in messages.iter().enumerate() {
            held.insert(&format!("k{at}"), lv(message)).expect("message");
        }
    }
    doc
}

#[cfg(test)]
fn lv(json: &Json) -> loro::LoroValue {
    match json {
        Json::String(s) => loro::LoroValue::from(s.as_str()),
        Json::Object(entries) => {
            loro::LoroValue::Map(entries.iter().map(|(k, v)| (k.clone(), lv(v))).collect())
        }
        other => panic!("a value this test does not write: {other}"),
    }
}

#[test]
#[cfg(test)]
fn a_thread_reads_back_ordered_and_counted_from_what_was_stored() {
    let tied = Floor::new("a thread whose messages share a time");
    let several = Floor::new("a document holding several threads");
    check(
        prop::collection::btree_map(
            "[a-c\u{ff5e}\u{1F600}]{1,2}",
            prop::collection::vec(message(), 1..6),
            1..7,
        ),
        None,
        |held| {
            let threads: Vec<(String, Vec<Json>)> = held.into_iter().collect();
            tied.draw(threads.iter().any(|(_, m)| {
                m.iter().any(|a| {
                    m.iter().filter(|b| key_of(a, "createdAt") == key_of(b, "createdAt")).count()
                        > 1
                })
            }));
            several.draw(threads.len() > 2);
            let doc = written(&threads);
            let mut want: Vec<Json> = threads
            .iter()
            .map(|(id, messages)| {
                let mut sorted = messages.clone();
                sorted.sort_by_key(|m| (key_of(m, "createdAt"), key_of(m, "id")));
                json!({ "id": id, "anchor": { "kind": "document" }, "status": "open", "messages": sorted })
            })
            .collect();
            want.sort_by_key(|t| {
                t["id"].as_str().expect("an id").encode_utf16().collect::<Vec<u16>>()
            });
            prop_assert_eq!(
                answer(&doc, QueryName::CommentThreads),
                model_of(&json!({ "ok": want }))
            );
            let counts: serde_json::Map<String, Json> =
                threads.iter().map(|(id, m)| (id.clone(), json!(m.len()))).collect();
            prop_assert_eq!(
                answer(&doc, QueryName::ThreadMessageCounts),
                model_of(&json!({ "ok": counts }))
            );
            Ok(())
        },
    );
    tied.assert(40);
    several.assert(40);
}

/// `encodeURIComponent` of one character, except that the characters a style key
/// carries verbatim are only the alphanumerics and `_.~-`.
#[cfg(test)]
fn escaped(id: &str) -> String {
    let mut out = String::from("comment-");
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || "_.~-".contains(c) {
            out.push(c);
        } else {
            let mut buffer = [0_u8; 4];
            for byte in c.encode_utf8(&mut buffer).bytes() {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// Each thread's passage: its id and how many characters of the body it covers.
#[cfg(test)]
fn passages() -> impl Strategy<Value = Vec<(String, usize, usize)>> {
    prop::collection::btree_set(any::<String>(), 1..5).prop_flat_map(|ids| {
        let n = ids.len();
        (
            Just(ids.into_iter().collect::<Vec<_>>()),
            prop::collection::vec((0_usize..3, 1_usize..4), n),
        )
            .prop_map(|(ids, spans)| {
                ids.into_iter().zip(spans).map(|(id, (gap, len))| (id, gap, len)).collect()
            })
    })
}

#[test]
#[cfg(test)]
fn a_passage_is_found_by_the_thread_its_mark_names_whatever_the_id_holds() {
    let several = Floor::new("a body marked for several threads");
    let escaped_ids = Floor::new("an id that needs an escape");
    check(passages(), None, |passages| {
        several.draw(passages.len() > 1);
        escaped_ids
            .draw(passages.iter().any(|(id, ..)| id.chars().any(|c| !c.is_ascii_alphanumeric())));
        let body: String = "a\u{1F600}bc".repeat(20);
        let units: Vec<usize> = body.chars().map(char::len_utf16).collect();
        let doc = LoroDoc::new();
        doc.get_text("body").insert(0, &body).expect("body");
        let mut styles = StyleConfigMap::new();
        for (id, ..) in &passages {
            styles.insert(escaped(id).as_str().into(), StyleConfig { expand: ExpandType::None });
        }
        doc.config_text_style(styles);
        let (mut at, mut want) = (0_usize, Vec::new());
        for (id, gap, len) in &passages {
            let from = at + gap;
            let width: usize = units.iter().skip(from).take(*len).sum();
            let begin: usize = units.iter().take(from).sum();
            doc.get_text("body")
                .mark_utf16(begin..begin + width, &escaped(id), true)
                .expect("mark");
            want.push(json!([id, { "start": begin, "end": begin + width }]));
            at = from + len;
        }
        prop_assert_eq!(
            answer(&doc, QueryName::ThreadMarks),
            model_of(&json!({ "ok": { "$map": want } }))
        );
        Ok(())
    });
    several.assert(40);
    escaped_ids.assert(40);
}
