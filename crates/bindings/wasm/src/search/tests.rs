use super::{
    Held, MAX_HELD_BYTES, MAX_INDEX_DOCUMENTS, MAX_INDEXES, MAX_LABEL_SETS, MAX_QUERY_BYTES,
    answer, search_op,
};
use crate::input_caps::SEARCH_OP;
use serde_json::{Value as Json, json};

fn ask(held: &mut Held, request: &Json) -> Json {
    serde_json::from_str(&answer(&request.to_string(), held)).unwrap_or(Json::Null)
}

fn fresh() -> Held {
    Held::new(MAX_HELD_BYTES)
}

fn handle_of(answer: &Json) -> Json {
    answer[1].clone()
}

fn refused(code: &str) -> Json {
    json!(["refused", code])
}

#[test]
fn text_ops_answer_what_the_search_crate_answers() {
    let mut held = fresh();
    assert_eq!(ask(&mut held, &json!(["fold", "Ｃａｆé ǅ"])), json!(["ok", "cafe dz"]));
    assert_eq!(ask(&mut held, &json!(["find", "Crème brûlée", "brule"])), json!(["ok", [6, 5]]));
    assert_eq!(ask(&mut held, &json!(["find", "abc", "zzz"])), json!(["ok", null]));
    assert_eq!(
        ask(&mut held, &json!(["tokens", "bm25で検索"])),
        json!(["ok", ["bm25", "で検", "検索"], ["bm25", "で", "検", "索", "で検", "検索"]]),
    );
    assert_eq!(
        ask(&mut held, &json!(["folders", "a/b/c", [["a", "A"], ["a/b", "B"], ["a", "A2"]]])),
        json!(["ok", ["A2", "B"]])
    );
}

#[test]
fn searchable_texts_read_a_note_and_a_canvas_by_the_same_rules() {
    let mut held = fresh();
    assert_eq!(
        ask(&mut held, &json!(["texts", "markdown", "body", "summary"])),
        json!(["ok", ["summary", "body"]])
    );
    assert_eq!(ask(&mut held, &json!(["texts", "markdown", "body", ""])), json!(["ok", ["body"]]));
    let nodes = json!([
        [null, ["text/markdown", "hello", null, null]],
        [null, ["text/uri-list", null, "https://x.test", null]],
        ["Group", null],
        [null, ["text/x-file", null, "doc/path", null]],
    ]);
    let canvas = ask(&mut held, &json!(["texts", "spatial", nodes, ["edge label", null]]));
    assert_eq!(canvas[0], json!("ok"));
    let listed = canvas[1].as_array().cloned().unwrap_or_default();
    assert!(listed.contains(&json!("hello")) && listed.contains(&json!("Group")));
    assert!(listed.contains(&json!("edge label")));
    assert!(!listed.contains(&json!("doc/path")));
}

#[test]
fn a_term_bag_lists_its_terms_in_utf16_order_with_the_length() {
    let mut held = fresh();
    let bag = ask(&mut held, &json!(["terms", "notes/a", "Alpha", ["alpha 😀 beta"]]));
    assert_eq!(bag[0], json!("ok"));
    assert_eq!(bag[1], json!(5));
    assert_eq!(bag[2], json!([["a", 1], ["alpha", 2], ["beta", 1], ["notes", 1]]));
}

#[test]
fn an_index_is_filled_queried_changed_and_released_by_its_handle() {
    let mut held = fresh();
    let handle = handle_of(&ask(&mut held, &json!(["index-new"])));
    let upsert = |held: &mut Held, id: &str, texts: &Json, folders: &Json| {
        ask(held, &json!(["index-upsert", handle, id, "", null, texts, folders]))
    };
    assert_eq!(upsert(&mut held, "a", &json!(["alpha beta"]), &Json::Null), json!(["ok", false]));
    assert_eq!(upsert(&mut held, "b", &json!(["alpha"]), &json!(["ops"])), json!(["ok", false]));
    assert_eq!(upsert(&mut held, "a", &json!(["alpha beta"]), &Json::Null), json!(["ok", true]));
    let size = ask(&mut held, &json!(["index-size", handle]));
    assert_eq!(size[1], json!(2));
    let hits = ask(&mut held, &json!(["index-query", handle, "alpha", null]));
    let ids: Vec<&str> =
        hits[1].as_array().into_iter().flatten().filter_map(|hit| hit[0].as_str()).collect();
    assert_eq!(ids, ["b", "a"]);
    let score = hits[1][0][1].as_str().unwrap_or("");
    assert_eq!(score.len(), 16);
    assert!(score.bytes().all(|b| b.is_ascii_hexdigit()));
    let one = ask(&mut held, &json!(["index-query", handle, "alpha", 1]));
    assert_eq!(one[1].as_array().map(Vec::len), Some(1));
    assert_eq!(ask(&mut held, &json!(["index-remove", handle, "b"])), json!(["ok", true]));
    assert_eq!(ask(&mut held, &json!(["index-remove", handle, "b"])), json!(["ok", false]));
    let after = ask(&mut held, &json!(["index-query", handle, "alpha", null]));
    assert_eq!(after[1].as_array().map(Vec::len), Some(1));
    assert_eq!(ask(&mut held, &json!(["index-release", handle])), json!(["ok", true]));
    assert_eq!(ask(&mut held, &json!(["index-release", handle])), json!(["ok", false]));
    assert_eq!(
        ask(&mut held, &json!(["index-query", handle, "alpha", null])),
        refused("malformed")
    );
}

#[test]
fn a_folder_bag_exists_only_for_a_document_in_a_named_folder() {
    let mut held = fresh();
    let handle = handle_of(&ask(&mut held, &json!(["index-new"])));
    for (id, folders) in [("a", json!([])), ("b", json!(["alpha"])), ("c", Json::Null)] {
        ask(&mut held, &json!(["index-upsert", handle, id, "", null, ["zzz"], folders]));
    }
    let hits = ask(&mut held, &json!(["index-query", handle, "alpha", null]));
    let ids: Vec<&str> =
        hits[1].as_array().into_iter().flatten().filter_map(|hit| hit[0].as_str()).collect();
    assert_eq!(ids, ["b"]);
}

#[test]
fn handles_are_never_reused_and_a_stale_one_is_refused() {
    let mut held = fresh();
    let first = handle_of(&ask(&mut held, &json!(["index-new"])));
    ask(&mut held, &json!(["index-release", first]));
    let second = handle_of(&ask(&mut held, &json!(["index-new"])));
    assert_ne!(first, second);
    assert_eq!(ask(&mut held, &json!(["index-size", first])), refused("malformed"));
    let labels = handle_of(&ask(&mut held, &json!(["labels", []])));
    assert_ne!(labels, second);
}

#[test]
fn labels_name_a_link_in_an_excerpt_and_a_stale_handle_is_refused() {
    let mut held = fresh();
    let labels = handle_of(&ask(
        &mut held,
        &json!(["labels", [["01H0", "folder/note", "Shown"], ["01H1", "folder/other", null]]]),
    ));
    let text = "see [[01H0]] and [[01H1]] for needle";
    let named = ask(&mut held, &json!(["snippet", text, 31, 6, labels]));
    assert_eq!(named, json!(["ok", "see Shown and other for needle"]));
    let bare = ask(&mut held, &json!(["snippet", text, 31, 6, null]));
    assert_eq!(bare, json!(["ok", "see 01H0 and 01H1 for needle"]));
    let cut = ask(&mut held, &json!(["excerpts", "needle", labels, [[text], ["none"]]]));
    assert_eq!(cut, json!(["ok", [["see Shown and other for needle"], []]]));
    assert_eq!(ask(&mut held, &json!(["labels-release", labels])), json!(["ok", true]));
    assert_eq!(ask(&mut held, &json!(["labels-release", labels])), json!(["ok", false]));
    assert_eq!(ask(&mut held, &json!(["snippet", text, 31, 6, labels])), refused("malformed"));
}

#[test]
fn a_request_the_op_does_not_read_is_refused_as_malformed() {
    let mut held = fresh();
    for request in [
        json!(["nope"]),
        json!([]),
        json!({"op": "fold"}),
        json!(["fold"]),
        json!(["fold", 1]),
        json!(["fold", "a", "b"]),
        json!(["find", "a"]),
        json!(["tokens", null]),
        json!(["index-new", 1]),
        json!(["index-query", -1, "a", null]),
        json!(["index-query", 4_294_967_296_u64, "a", null]),
        json!(["texts", "markdown", "b"]),
        json!(["texts", "spatial", [[1, null]], []]),
        json!(["texts", "spatial", [[null, ["m", "c", null]]], []]),
        json!(["texts", "bogus", 1, 2]),
        json!(["labels", [["a", "b"]]]),
        json!(["folders", "a", [["a"]]]),
        json!(["snippet", "a", 0, 0, 9]),
        json!(["snippet", "a", "0", 0, null]),
        json!(["excerpts", "q", null, "no"]),
        json!(["terms", "p", null, [1]]),
    ] {
        assert_eq!(ask(&mut held, &request), refused("malformed"), "{request}");
    }
    assert_eq!(answer("not json", &mut held), "[\"refused\",\"malformed\"]");
    assert_eq!(answer("[1]", &mut held), "[\"refused\",\"malformed\"]");
}

#[test]
fn a_request_or_query_past_its_cap_is_refused_before_it_is_read() {
    let mut held = fresh();
    let past = "x".repeat(SEARCH_OP.max_bytes + 1);
    assert_eq!(answer(&past, &mut held), "[\"refused\",\"input-too-large\"]");
    let at_cap = format!("[\"fold\",\"{}\"]", "x".repeat(SEARCH_OP.max_bytes - 11));
    assert_eq!(at_cap.len(), SEARCH_OP.max_bytes);
    assert_eq!(held_answer_head(&at_cap, &mut held), "[\"ok\"");
    let handle = handle_of(&ask(&mut held, &json!(["index-new"])));
    let long = "q".repeat(MAX_QUERY_BYTES + 1);
    let exact = "q".repeat(MAX_QUERY_BYTES);
    assert_eq!(
        ask(&mut held, &json!(["index-query", handle, long, null])),
        refused("input-too-large")
    );
    assert_eq!(ask(&mut held, &json!(["index-query", handle, exact, null])), json!(["ok", []]));
    assert_eq!(ask(&mut held, &json!(["excerpts", long, null, []])), refused("input-too-large"));
    assert_eq!(ask(&mut held, &json!(["excerpts", exact, null, []])), json!(["ok", []]));
}

fn held_answer_head(request: &str, held: &mut Held) -> String {
    answer(request, held).chars().take(5).collect()
}

#[test]
fn an_instance_holds_a_bounded_number_of_indexes_and_label_sets() {
    let mut held = fresh();
    let handles: Vec<Json> =
        (0..MAX_INDEXES).map(|_| handle_of(&ask(&mut held, &json!(["index-new"])))).collect();
    assert_eq!(ask(&mut held, &json!(["index-new"])), refused("input-too-large"));
    ask(&mut held, &json!(["index-release", handles[0]]));
    assert_eq!(ask(&mut held, &json!(["index-new"]))[0], json!("ok"));
    for _ in 0..MAX_LABEL_SETS {
        assert_eq!(ask(&mut held, &json!(["labels", []]))[0], json!("ok"));
    }
    assert_eq!(ask(&mut held, &json!(["labels", []])), refused("input-too-large"));
}

#[test]
fn an_index_holds_a_bounded_number_of_documents_and_replacing_one_is_always_allowed() {
    let mut held = fresh();
    let handle = handle_of(&ask(&mut held, &json!(["index-new"])));
    let put = |held: &mut Held, id: &str| {
        ask(held, &json!(["index-upsert", handle, id, "", null, ["t"], null]))
    };
    for at in 0..MAX_INDEX_DOCUMENTS {
        assert_eq!(put(&mut held, &format!("d{at}"))[0], json!("ok"), "{at}");
    }
    assert_eq!(put(&mut held, "one-more"), refused("input-too-large"));
    assert_eq!(put(&mut held, "d0"), json!(["ok", true]));
    assert_eq!(ask(&mut held, &json!(["index-remove", handle, "d1"])), json!(["ok", true]));
    assert_eq!(put(&mut held, "one-more"), json!(["ok", false]));
}

#[test]
fn indexes_and_labels_share_one_byte_budget() {
    let term = "t".repeat(1000);
    // One term of 1000 bytes under a one-byte id.
    let cost =
        whiteboard_search::TERM_OVERHEAD + term.len() + 1 + whiteboard_search::DOCUMENT_OVERHEAD;
    let mut held = Held::new(cost * 2);
    let handle = handle_of(&ask(&mut held, &json!(["index-new"])));
    let put = |held: &mut Held, id: &str, text: &str| {
        ask(held, &json!(["index-upsert", handle, id, "", null, [text], null]))
    };
    assert_eq!(put(&mut held, "a", &term)[0], json!("ok"));
    assert_eq!(put(&mut held, "b", &"u".repeat(1000))[0], json!("ok"));
    assert_eq!(put(&mut held, "c", &"v".repeat(1000)), refused("input-too-large"));
    let size = ask(&mut held, &json!(["index-size", handle]));
    assert_eq!(size[2], json!(cost * 2));
    ask(&mut held, &json!(["index-remove", handle, "b"]));
    assert_eq!(put(&mut held, "c", &"v".repeat(1000))[0], json!("ok"));
    let labelled = ask(&mut held, &json!(["labels", [["a".repeat(500), "p", null]]]));
    assert_eq!(labelled, refused("input-too-large"));
}

#[test]
fn a_replacement_is_judged_by_the_corpus_it_leaves_and_a_refused_one_keeps_the_old() {
    let term = "t".repeat(1000);
    let cost =
        whiteboard_search::TERM_OVERHEAD + term.len() + 1 + whiteboard_search::DOCUMENT_OVERHEAD;
    let mut held = Held::new(cost * 2);
    let handle = handle_of(&ask(&mut held, &json!(["index-new"])));
    let put = |held: &mut Held, id: &str, text: &str| {
        ask(held, &json!(["index-upsert", handle, id, "", null, [text], null]))
    };
    put(&mut held, "a", &term);
    put(&mut held, "b", &"u".repeat(1000));
    // Full: the same document again leaves the corpus as it stands.
    assert_eq!(put(&mut held, "a", &term), json!(["ok", true]));
    // One byte more than it gives back does not fit, and "a" stays as it was.
    assert_eq!(put(&mut held, "a", &"t".repeat(1001)), refused("input-too-large"));
    let hits = ask(&mut held, &json!(["index-query", handle, term, null]));
    assert_eq!(hits[1].as_array().map(Vec::len), Some(1));
    assert_eq!(ask(&mut held, &json!(["index-size", handle]))[2], json!(cost * 2));
}

#[test]
fn a_document_is_charged_its_id_even_with_no_terms() {
    let id = "i".repeat(1000);
    let mut tight = Held::new(1000 + whiteboard_search::DOCUMENT_OVERHEAD - 1);
    let handle = handle_of(&ask(&mut tight, &json!(["index-new"])));
    let upsert = json!(["index-upsert", handle, id, "", null, [], null]);
    assert_eq!(ask(&mut tight, &upsert), refused("input-too-large"));
    let mut exact = Held::new(1000 + whiteboard_search::DOCUMENT_OVERHEAD);
    let handle = handle_of(&ask(&mut exact, &json!(["index-new"])));
    let upsert = json!(["index-upsert", handle, id, "", null, [], null]);
    assert_eq!(ask(&mut exact, &upsert), json!(["ok", false]));
    assert_eq!(exact.bytes(), 1000 + whiteboard_search::DOCUMENT_OVERHEAD);
}

#[test]
fn the_exported_op_answers_through_the_instance_it_holds() {
    let answered: Json =
        serde_json::from_str(&search_op("[\"fold\",\"ÀB\"]")).unwrap_or(Json::Null);
    assert_eq!(answered, json!(["ok", "ab"]));
}

#[test]
fn a_handle_names_its_own_index_and_a_snippet_reads_its_offsets() {
    let mut held = fresh();
    let first = handle_of(&ask(&mut held, &json!(["index-new"])));
    let second = handle_of(&ask(&mut held, &json!(["index-new"])));
    assert_ne!(first, second);
    ask(&mut held, &json!(["index-upsert", second, "only", "", null, ["alpha"], null]));
    let hits = |held: &mut Held, handle: &Json| {
        ask(held, &json!(["index-query", handle, "alpha", null]))[1].as_array().map(Vec::len)
    };
    assert_eq!(hits(&mut held, &first), Some(0));
    assert_eq!(hits(&mut held, &second), Some(1));
    assert_eq!(ask(&mut held, &json!(["index-size", first]))[1], json!(0));
    assert_eq!(ask(&mut held, &json!(["index-size", second]))[1], json!(1));
    assert_eq!(ask(&mut held, &json!(["index-remove", first, "only"])), json!(["ok", false]));
    assert_eq!(ask(&mut held, &json!(["index-remove", second, "only"])), json!(["ok", true]));

    let long = format!("{}needle{}", "a".repeat(200), "b".repeat(200));
    let shown = ask(&mut held, &json!(["snippet", long, 200, 6, null]));
    assert_eq!(shown[1].as_str().map(|text| text.contains("needle")), Some(true));
    let elsewhere = ask(&mut held, &json!(["snippet", long, 0, 0, null]));
    assert_ne!(shown, elsewhere);
}

#[test]
fn a_label_set_is_charged_twice_the_bytes_of_its_entries_and_a_fixed_overhead() {
    let entry = json!(["labels", [["abc", "de", "f"]]]);
    // 6 bytes of text, doubled, and 128 of overhead.
    let mut tight = Held::new(139);
    assert_eq!(ask(&mut tight, &entry), refused("input-too-large"));
    let mut exact = Held::new(140);
    assert_eq!(ask(&mut exact, &entry)[0], json!("ok"));
    assert_eq!(exact.bytes(), 140);
}
