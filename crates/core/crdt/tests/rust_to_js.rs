//! Rust to JavaScript: documents built with the Rust `loro` crate, exported as
//! a snapshot, the whole update history and a shallow snapshot, with the deep
//! value, version vector and frontiers the Rust side answered.
//! `packages/loro-adapter/src/oracle/crdt-rust-export.jsonl` is that corpus;
//! `crdt-rust-export.test.ts` imports every export through npm `loro-crdt` and
//! holds it to the same answers. This file regenerates the corpus
//! (`WHITEBOARD_RECORD_RUST_CRDT_CORPUS=1 cargo test -p whiteboard-crdt --test
//! rust_to_js`) and, always, holds the committed one to what the Rust side
//! reads back from it.
//!
//! Snapshot bytes are not canonical, so the corpus is committed rather than
//! compared against a fresh export: a regeneration may change every byte
//! without changing one answer.

#[cfg(test)]
mod support;

use support::{assert_same, base64_decode, model_of, pairs_of, rows_of, without_proto};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{deep_value, frontier_pairs, import_bytes, version_pairs};

const CORPUS: &str =
    include_str!("../../../../packages/loro-adapter/src/oracle/crdt-rust-export.jsonl");

/// Every row this corpus must hold, so a generator that quietly dropped one
/// fails rather than shrinking what the JavaScript side is held to.
const IDS: [&str; 11] = [
    "rust-empty",
    "rust-map-scalars",
    "rust-list-nested",
    "rust-text-utf16",
    "rust-text-marks",
    "rust-movable-list",
    "rust-tree",
    "rust-counter",
    "rust-concurrent",
    "rust-deleted",
    "rust-workspace-shaped",
];

// The generator writes a file, so it is native; the module is `cfg(test)`
// alone because that is the form clippy's `allow-*-in-tests` reads.
#[cfg(test)]
mod record {
    #[cfg(not(target_arch = "wasm32"))]
    use super::*;
    #[cfg(not(target_arch = "wasm32"))]
    use loro::{ExportMode, LoroDoc, LoroList, LoroMap, LoroMovableList, StyleConfig};
    #[cfg(not(target_arch = "wasm32"))]
    use serde_json::{Value as Json, json};

    #[cfg(not(target_arch = "wasm32"))]
    fn doc(peer: u64) -> LoroDoc {
        let doc = LoroDoc::new();
        doc.set_peer_id(peer).expect("a peer id");
        doc.config_default_text_style(Some(StyleConfig::new()));
        doc
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn cases() -> Vec<(&'static str, LoroDoc)> {
        let mut out = Vec::new();

        out.push(("rust-empty", doc(1)));

        let d = doc(1);
        let root = d.get_map("root");
        root.insert("text", "plain").expect("insert");
        root.insert("flag", true).expect("insert");
        root.insert("ratio", 0.25_f64).expect("insert");
        root.insert("count", 42_i64).expect("insert");
        root.insert("nothing", loro::LoroValue::Null).expect("insert");
        root.insert("astral", "a\u{1f600}b\u{301}\u{10ffff}").expect("insert");
        let inner = root.insert_container("inner", LoroMap::new()).expect("map");
        inner.insert("deep", "value").expect("insert");
        d.commit();
        out.push(("rust-map-scalars", d));

        let d = doc(2);
        let list = d.get_list("items");
        list.push("first").expect("push");
        let nested = list.push_container(LoroMap::new()).expect("map");
        nested.insert("k", 1_i64).expect("insert");
        let sub = list.push_container(LoroList::new()).expect("list");
        sub.push("x").expect("push");
        sub.push("y").expect("push");
        list.insert(0, "zeroth").expect("insert");
        d.commit();
        out.push(("rust-list-nested", d));

        let d = doc(3);
        let text = d.get_text("body");
        text.insert_utf16(0, "hello \u{1f600} world").expect("insert");
        text.delete_utf16(0, 6).expect("delete");
        text.insert_utf16(2, "\u{10ffff}").expect("insert");
        d.commit();
        out.push(("rust-text-utf16", d));
        out.extend(structural_cases());
        out
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn structural_cases() -> Vec<(&'static str, LoroDoc)> {
        let mut out = Vec::new();

        let d = doc(4);
        let text = d.get_text("body");
        text.insert_utf16(0, "bold \u{1f600} and link").expect("insert");
        text.mark_utf16(0..4, "bold", true).expect("mark");
        text.mark_utf16(9..13, "link", "https://example.test").expect("mark");
        d.commit();
        out.push(("rust-text-marks", d));

        let d = doc(5);
        let list: LoroMovableList = d.get_movable_list("order");
        for word in ["a", "b", "c", "d"] {
            list.push(word).expect("push");
        }
        list.mov(0, 3).expect("move");
        list.set(1, "B").expect("set");
        d.commit();
        out.push(("rust-movable-list", d));

        let d = doc(6);
        let tree = d.get_tree("tree");
        let a = tree.create(None).expect("node");
        let b = tree.create(a).expect("node");
        let c = tree.create(None).expect("node");
        tree.get_meta(a).expect("meta").insert("name", "a").expect("insert");
        tree.get_meta(b).expect("meta").insert("name", "b").expect("insert");
        tree.get_meta(c).expect("meta").insert("name", "c").expect("insert");
        tree.mov(b, c).expect("move");
        d.commit();
        out.push(("rust-tree", d));

        let d = doc(7);
        let counter = d.get_counter("hits");
        counter.increment(3.0).expect("increment");
        counter.decrement(1.0).expect("decrement");
        d.commit();
        out.push(("rust-counter", d));
        out.extend(history_cases());
        out
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn history_cases() -> Vec<(&'static str, LoroDoc)> {
        let mut out = Vec::new();

        let left = doc(8);
        left.get_map("root").insert("k", "left").expect("insert");
        left.get_text("body").insert(0, "base").expect("insert");
        left.commit();
        let right = doc(9);
        right.import(&left.export(ExportMode::all_updates()).expect("export")).expect("import");
        right.get_map("root").insert("k", "right").expect("insert");
        right.get_text("body").insert(4, "-r").expect("insert");
        right.commit();
        left.get_text("body").insert(0, "l-").expect("insert");
        left.commit();
        left.import(&right.export(ExportMode::all_updates()).expect("export")).expect("import");
        out.push(("rust-concurrent", left));

        let d = doc(10);
        let root = d.get_map("root");
        root.insert("gone", "x").expect("insert");
        root.insert("kept", "y").expect("insert");
        let list = root.insert_container("list", LoroList::new()).expect("list");
        list.push(1_i64).expect("push");
        list.push(2_i64).expect("push");
        d.commit();
        root.delete("gone").expect("delete");
        list.delete(0, 1).expect("delete");
        d.get_text("body").insert(0, "abc").expect("insert");
        d.commit();
        d.get_text("body").delete(1, 1).expect("delete");
        d.commit();
        out.push(("rust-deleted", d));

        let d = doc(11);
        let tree = d.get_tree("tree");
        let folder = tree.create(None).expect("node");
        let document = tree.create(folder).expect("node");
        let meta = tree.get_meta(document).expect("meta");
        meta.insert("documentId", "01ARZ3NDEKTSV4RRFFQ69G5FEA").expect("insert");
        meta.insert("kind", "markdown").expect("insert");
        meta.insert_container("body", loro::LoroText::new())
            .expect("text")
            .insert(0, "# note")
            .expect("insert");
        d.get_map("workspaceMeta").insert("pinned", true).expect("insert");
        d.commit();
        out.push(("rust-workspace-shaped", d));

        out
    }

    /// A model value as the JSON a recording holds: an integral double within
    /// +-2^53 as an integer, as `JSON.stringify` writes it.
    #[cfg(not(target_arch = "wasm32"))]
    fn json_of(value: &whiteboard_model::Value) -> Json {
        match value {
            whiteboard_model::Value::Null => Json::Null,
            whiteboard_model::Value::Bool(b) => Json::Bool(*b),
            whiteboard_model::Value::Number(n) => {
                serde_json::Number::from_f64(*n).map_or(Json::Null, Json::Number)
            }
            whiteboard_model::Value::BigInt(digits) => Json::String(digits.clone()),
            whiteboard_model::Value::String(s) => Json::String(s.clone()),
            whiteboard_model::Value::Seq(items) => Json::Array(items.iter().map(json_of).collect()),
            whiteboard_model::Value::Map(entries) => {
                Json::Object(entries.iter().map(|(k, v)| (k.clone(), json_of(v))).collect())
            }
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn b64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0_u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
            let symbols = chunk.len() + 1;
            for i in 0..4 {
                if i < symbols {
                    out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn row(id: &str, doc: &LoroDoc) -> Json {
        let export = |mode: ExportMode| b64(&doc.export(mode).expect("export"));
        let (deep, _) = without_proto(&deep_value(doc));
        json!({
            "id": id,
            "snapshot": export(ExportMode::Snapshot),
            "updates": export(ExportMode::all_updates()),
            "shallow": export(ExportMode::shallow_snapshot(&doc.oplog_frontiers())),
            "deep": json_of(&deep),
            "vv": version_pairs(doc),
            "frontiers": frontier_pairs(doc),
        })
    }

    /// Writes the corpus when a developer asks for it by environment
    /// variable, and says whether it did.
    #[cfg(not(target_arch = "wasm32"))]
    #[expect(
        clippy::disallowed_methods,
        reason = "a developer's command: the one environment read and the one file write, in a test only, since core has no port for either"
    )]
    pub(super) fn write_if_requested() -> bool {
        if std::env::var_os("WHITEBOARD_RECORD_RUST_CRDT_CORPUS").is_none() {
            return false;
        }
        let lines: Vec<String> = cases().iter().map(|(id, doc)| row(id, doc).to_string()).collect();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/loro-adapter/src/oracle/crdt-rust-export.jsonl"
        );
        std::fs::write(path, format!("{}\n", lines.join("\n"))).expect("write the corpus");
        true
    }
}

#[test]
fn the_committed_corpus_is_what_rust_reads_back_from_its_own_exports() {
    #[cfg(not(target_arch = "wasm32"))]
    if record::write_if_requested() {
        return;
    }
    let rows = rows_of(CORPUS);
    let ids: Vec<&str> = rows.iter().map(|row| row["id"].as_str().expect("an id")).collect();
    assert_eq!(ids, IDS, "the corpus's rows");
    for row in &rows {
        let id = row["id"].as_str().expect("an id");
        for export in ["snapshot", "updates", "shallow"] {
            let doc = import_bytes(&base64_decode(row[export].as_str().expect("bytes")))
                .unwrap_or_else(|e| panic!("{id} {export}: {e}"));
            assert_same(
                &format!("{id} {export} deep value"),
                &without_proto(&deep_value(&doc)).0,
                &model_of(&row["deep"]),
            );
            assert_eq!(
                frontier_pairs(&doc),
                pairs_of(&row["frontiers"]),
                "{id} {export} frontiers"
            );
            if export != "shallow" {
                assert_eq!(
                    version_pairs(&doc),
                    pairs_of(&row["vv"]),
                    "{id} {export} version vector"
                );
            }
        }
    }
}
