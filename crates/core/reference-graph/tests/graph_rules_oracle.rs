//! The reference graph's pure judgements against the recorded answers of the
//! TypeScript.
//!
//! `packages/reference-graph/src/oracle/graph-rules.jsonl` is that recording,
//! frozen: the facts a document contributes, where a name is mentioned outside
//! a link, the edit that links mentions, the edit that follows a rename, the
//! backlinks a listing answers and the wording of a refusal. Every row is
//! replayed; the two ledgers below pin how many, by op, so a recorder change
//! that drops or adds rows fails here.

#![cfg(test)]

mod support;

use serde_json::{Value as Json, json};
use std::collections::BTreeMap;
use support::{
    Content, bearers_json, breach_of, content_of, doubles, edit_json, entries_of, facts_json,
    facts_of, ok, refused, text,
};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_reference_graph::{
    BacklinkEntry, DocumentContent, DocumentFacts, LinkifyTarget, LoadedContent,
    ReferenceRewriteTooLarge, backlinks_in, extract_content_facts, plan_document_reference_rewrite,
    plan_linkify_mentions, split_bearer_tags, tag_bearers_of, unlinked_name_spans,
};

const RECORDING: &str =
    include_str!("../../../../packages/reference-graph/src/oracle/graph-rules.jsonl");

/// The ops replayed here, with the rows the recording holds of each.
const REPLAYED: &[(&str, usize)] = &[
    ("extractContentFacts", 155),
    ("tagBearersOf", 28),
    ("splitBearerTags", 7),
    ("unlinkedNameSpans", 77),
    ("planLinkifyMentions", 181),
    ("planDocumentReferenceRewrite", 286),
    ("backlinksIn", 67),
    ("breachMessage", 6),
];

/// The ops with rows the port does not answer, with their rows.
const DEFERRED: &[(&str, usize)] = &[];

fn content_ref(content: &Content) -> DocumentContent<'_> {
    match content {
        Content::Markdown(body) => DocumentContent::Markdown { body },
        Content::Spatial(canvas) => DocumentContent::Spatial(canvas),
    }
}

fn extraction(row: &Json) -> Json {
    let content = content_of(&row["loaded"]["content"]);
    let tags: Option<Vec<String>> = row["loaded"]
        .get("tags")
        .map(|tags| tags.as_array().expect("tags").iter().map(text).collect());
    let loaded = LoadedContent { content: content_ref(&content), tags: tags.as_deref() };
    match row["op"].as_str() {
        Some("extractContentFacts") => ok(facts_json(&extract_content_facts(&loaded))),
        _ => ok(bearers_json(&tag_bearers_of(&loaded))),
    }
}

fn split(row: &Json) -> Json {
    let bearers: Vec<(String, Vec<String>)> = row["bearers"]
        .as_array()
        .expect("bearers")
        .iter()
        .map(|b| (text(&b["what"]), b["tags"].as_array().expect("tags").iter().map(text).collect()))
        .collect();
    let split =
        split_bearer_tags(bearers.iter().map(|(what, tags)| (what.as_str(), tags.as_slice())));
    ok(json!({ "own": split.own, "carried": split.carried }))
}

fn spans(row: &Json) -> Json {
    let found = unlinked_name_spans(&text(&row["text"]), &text(&row["name"]));
    ok(found.iter().map(|s| json!({ "index": s.index, "length": s.length })).collect::<Vec<_>>())
}

fn linkify(row: &Json) -> Json {
    let content = content_of(&row["content"]);
    let target = LinkifyTarget {
        document_id: &text(&row["target"]["documentId"]),
        path: &text(&row["target"]["path"]),
        name: &text(&row["target"]["name"]),
    };
    match plan_linkify_mentions(&content_ref(&content), &target) {
        Ok(plan) => ok(json!({
            "linked": plan.linked,
            "edit": plan.edit.as_ref().map_or(Json::Null, edit_json),
        })),
        Err(error) => refused(&error),
    }
}

fn rewrite(row: &Json) -> Json {
    let content = content_of(&row["content"]);
    let plan: BTreeMap<String, String> = row["plan"]
        .as_array()
        .expect("plan")
        .iter()
        .map(|pair| (text(&pair[0]), text(&pair[1])))
        .collect();
    match plan_document_reference_rewrite(&content_ref(&content), &plan) {
        Ok(edit) => ok(edit.as_ref().map_or(Json::Null, edit_json)),
        Err(error) => refused(&error),
    }
}

fn entry_json(entry: &BacklinkEntry) -> Json {
    let mut out = json!({ "documentId": entry.document_id, "path": entry.path });
    if let Some(fields) = out.as_object_mut() {
        if let Some(name) = &entry.name {
            fields.insert("name".to_owned(), json!(name));
        }
        if let Some(kind) = &entry.kind {
            fields.insert("kind".to_owned(), json!(kind));
        }
        fields.insert("contexts".to_owned(), json!(entry.contexts));
    }
    out
}

fn backlinks(row: &Json) -> Json {
    let entries = entries_of(&row["entries"]);
    let held = facts_of(&row["facts"]);
    let facts: BTreeMap<String, DocumentFacts<'_>> = held
        .iter()
        .map(|(id, (refs, texts))| (id.clone(), DocumentFacts { refs, texts }))
        .collect();
    let answer = backlinks_in(&entries, &facts, &text(&row["documentId"]));
    ok(json!({
        "backlinks": answer.backlinks.iter().map(entry_json).collect::<Vec<_>>(),
        "unlinkedMentions": answer.unlinked_mentions.iter().map(entry_json).collect::<Vec<_>>(),
    }))
}

fn breach(row: &Json) -> Json {
    let error = ReferenceRewriteTooLarge { breach: breach_of(&row["breach"]) };
    ok(json!({ "name": ReferenceRewriteTooLarge::NAME, "message": error.message() }))
}

/// What the Rust port answers for one row, in the recorder's answer shape.
fn answer(row: &Json) -> Option<Json> {
    Some(match row["op"].as_str()? {
        "extractContentFacts" | "tagBearersOf" => extraction(row),
        "splitBearerTags" => split(row),
        "unlinkedNameSpans" => spans(row),
        "planLinkifyMentions" => linkify(row),
        "planDocumentReferenceRewrite" => rewrite(row),
        "backlinksIn" => backlinks(row),
        "breachMessage" => breach(row),
        _ => return None,
    })
}

#[test]
fn every_row_is_answered_as_the_typescript_answered_it() {
    let mut replayed: BTreeMap<String, usize> = BTreeMap::new();
    let mut deferred: BTreeMap<String, usize> = BTreeMap::new();
    for line in RECORDING.lines() {
        let row: Json = serde_json::from_str(line).expect("a recorded line");
        let op = row["op"].as_str().expect("an op").to_owned();
        match answer(&row) {
            Some(got) => {
                assert_eq!(
                    doubles(&got),
                    doubles(&row["result"]),
                    "{} ({})",
                    row["id"],
                    row["tag"]
                );
                *replayed.entry(op).or_default() += 1;
            }
            None => *deferred.entry(op).or_default() += 1,
        }
    }
    let ledger = |rows: &[(&str, usize)]| -> BTreeMap<String, usize> {
        rows.iter().map(|&(op, n)| (op.to_owned(), n)).collect()
    };
    assert_eq!(replayed, ledger(REPLAYED), "the rows replayed, by op");
    assert_eq!(deferred, ledger(DEFERRED), "the rows deferred, by op");
}
