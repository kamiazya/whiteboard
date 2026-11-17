//! Ranking, excerpts and the rest of the package against the recorded answers
//! of the TypeScript: `documentTerms`, `fullTextSearch` (scores as IEEE bits),
//! `excerpterFor`, `snippetAround`, `linkLabelsFrom`, `searchableTexts` and
//! `folderNamesOf`, from the `search.jsonl` the TypeScript recorder writes.
//!
//! What folding and tokenizing decide is held to the same Unicode-table
//! ledger as `search_oracle.rs`: a text holding a ledgered code point is
//! replayed but may differ. Grapheme cuts are held to `grapheme_diff.json`,
//! which names each recorded case the pinned segmenter cuts differently from
//! `Intl.Segmenter`; an excerpt whose text is one of those cases may differ.

#[cfg(test)]
mod support {
    use serde_json::Value as Json;
    use std::collections::BTreeSet;

    const RECORDING: &str = include_str!("../../../../packages/search/src/oracle/search.jsonl");
    const UNICODE_LEDGER: &str = include_str!("unicode_table_diff.json");

    pub(crate) fn records(kind: &str) -> Vec<Json> {
        RECORDING
            .lines()
            .map(|line| serde_json::from_str::<Json>(line).expect("a recorded line"))
            .filter(|record| record["kind"] == kind)
            .collect()
    }

    pub(crate) fn ledgered_code_points() -> BTreeSet<u32> {
        let ledger: Json = serde_json::from_str(UNICODE_LEDGER).expect("the ledger");
        let mut set = BTreeSet::new();
        for table in ["fold", "word", "mark"] {
            for range in ledger[table]["ranges"].as_array().expect("ranges") {
                let from = u32::try_from(range[0].as_u64().expect("from")).expect("a code point");
                let to = u32::try_from(range[1].as_u64().expect("to")).expect("a code point");
                set.extend(from..=to);
            }
        }
        set
    }

    /// Every string field of a record, nested ones included.
    pub(crate) fn strings_of(value: &Json, out: &mut Vec<String>) {
        match value {
            Json::String(text) => out.push(text.clone()),
            Json::Array(items) => items.iter().for_each(|item| strings_of(item, out)),
            Json::Object(map) => map.values().for_each(|item| strings_of(item, out)),
            _ => {}
        }
    }

    pub(crate) fn holds_ledgered(ledgered: &BTreeSet<u32>, record: &Json) -> bool {
        let mut texts = Vec::new();
        strings_of(record, &mut texts);
        texts.iter().any(|text| text.chars().any(|c| ledgered.contains(&u32::from(c))))
    }

    /// Whether a recorded string is its code units, because it was not well-formed.
    pub(crate) fn ill_formed(value: &Json) -> bool {
        match value {
            Json::Object(map) => map.contains_key("units") || map.values().any(ill_formed),
            Json::Array(items) => items.iter().any(ill_formed),
            _ => false,
        }
    }

    pub(crate) fn text(value: &Json) -> String {
        value.as_str().expect("a text").to_owned()
    }

    pub(crate) fn texts(value: &Json) -> Vec<String> {
        value.as_array().expect("texts").iter().map(text).collect()
    }

    pub(crate) fn count(value: &Json) -> usize {
        usize::try_from(value.as_u64().expect("a count")).expect("a count")
    }

    /// FNV-1a 64 over the UTF-8 of `text`, as 16 hex digits.
    pub(crate) fn fnv64(text: &str) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in text.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{hash:016x}")
    }

    /// What a replay did, pinned so a change of either side shows as a count.
    #[derive(Default, Debug, PartialEq, Eq)]
    pub(crate) struct Tally {
        pub(crate) replayed: usize,
        pub(crate) ill_formed: usize,
        pub(crate) tolerated: usize,
    }

    /// Replays every `kind` record: `answer` returns this crate's answer as the
    /// record writes it, `tolerable` whether a difference is ledgered.
    pub(crate) fn replay(
        kind: &str,
        answer: impl Fn(&Json) -> Json,
        recorded: impl Fn(&Json) -> Json,
        tolerable: impl Fn(&Json) -> bool,
    ) -> Tally {
        let mut tally = Tally::default();
        for record in records(kind) {
            if ill_formed(&record) {
                tally.ill_formed += 1;
                continue;
            }
            tally.replayed += 1;
            let got = answer(&record);
            let want = recorded(&record);
            if got != want {
                assert!(tolerable(&record), "{kind} {record}\n got {got}\nwant {want}");
                tally.tolerated += 1;
            }
        }
        tally
    }
}

#[cfg(test)]
mod replays {
    use super::support::{
        Tally, count, fnv64, holds_ledgered, ledgered_code_points, records, replay, text, texts,
    };
    use serde_json::{Value as Json, json};
    use std::collections::BTreeMap;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_model::spatial::{CanvasEdge, NodeResource, SpatialCanvas, SpatialNode};
    use whiteboard_search::{
        LinkEntry, LinkLabels, SearchOptions, SearchableContent, SearchableDocument,
        document_terms, excerpter_for, folder_names_of, full_text_search, grapheme_cuts,
        searchable_texts, snippet_around,
    };

    type Expander = Box<dyn Fn(&str) -> String>;

    fn also(name: &str) -> Option<Expander> {
        match name {
            "upper" => Some(Box::new(str::to_uppercase)),
            "empty" => Some(Box::new(|_| String::new())),
            "suffix" => Some(Box::new(|_| "zzextra".to_owned())),
            _ => None,
        }
    }

    fn entries(value: &Json) -> Option<LinkLabels> {
        let list = value.as_array()?;
        let entries: Vec<LinkEntry> = list
            .iter()
            .map(|entry| LinkEntry {
                document_id: text(&entry["documentId"]),
                path: text(&entry["path"]),
                name: entry.get("name").map(text),
            })
            .collect();
        Some(LinkLabels::from_entries(&entries))
    }

    fn label_fn(labels: Option<&LinkLabels>) -> impl Fn(&str) -> Option<String> + '_ {
        move |target| labels.and_then(|each| each.label(target))
    }

    fn tolerate_unicode(record: &Json) -> bool {
        holds_ledgered(&ledgered_code_points(), record)
    }

    fn never(_: &Json) -> bool {
        false
    }

    fn document_of(record: &Json) -> SearchableDocument {
        SearchableDocument {
            document_id: text(&record["documentId"]),
            path: text(&record["path"]),
            name: record.get("name").map(text),
            texts: texts(&record["texts"]),
            folders: record.get("folders").map(texts),
        }
    }

    #[test]
    fn every_recorded_term_bag_is_counted_as_the_typescript_counted_it() {
        let tally = replay(
            "terms",
            |record| {
                let expand = also(record["also"].as_str().expect("a name"));
                let terms = document_terms(
                    &text(&record["path"]),
                    record.get("name").map(text).as_deref(),
                    &texts(&record["texts"]),
                    expand.as_deref(),
                );
                let mut sorted: Vec<(&String, &usize)> = terms.counts.iter().collect();
                sorted.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
                let counts = if record["counts"].is_array() {
                    json!(sorted.iter().map(|(token, n)| json!([token, n])).collect::<Vec<_>>())
                } else {
                    let lines = sorted.iter().fold(String::new(), |mut all, (token, n)| {
                        all.extend([token.as_str(), "\t", &n.to_string(), "\n"]);
                        all
                    });
                    json!({"n": sorted.len(), "fnv": fnv64(&lines)})
                };
                json!({"counts": counts, "length": terms.length})
            },
            |record| json!({"counts": record["counts"], "length": record["length"]}),
            tolerate_unicode,
        );
        assert_eq!(tally, Tally { replayed: 211, ill_formed: 49, tolerated: 1 });
    }

    #[test]
    fn every_recorded_excerpt_is_cut_as_the_typescript_cut_it() {
        for (kind, expected) in [
            ("snippet", Tally { replayed: 500, ill_formed: 0, tolerated: 0 }),
            ("snippet-run", Tally { replayed: 666, ill_formed: 0, tolerated: 0 }),
        ] {
            let tally = replay(
                kind,
                |record| {
                    let labels = record.get("entries").and_then(entries);
                    let of = label_fn(labels.as_ref());
                    let index = count(&record["index"]);
                    let length = count(&record["length"]);
                    json!(snippet_around(&text(&record["text"]), index, length, Some(&of)))
                },
                |record| record["out"].clone(),
                never,
            );
            assert_eq!(tally, expected, "{kind}");
        }
    }

    #[test]
    fn every_recorded_link_label_is_the_one_the_typescript_gave() {
        let mut replayed = 0;
        for record in records("labels") {
            let labels = entries(&record["entries"]).expect("entries");
            for each in record["targets"].as_array().expect("targets") {
                let got = labels.label(each["target"].as_str().expect("a target"));
                assert_eq!(json!(got), each["label"]);
                replayed += 1;
            }
        }
        assert_eq!(replayed, 10);
    }

    #[test]
    fn every_recorded_excerpt_set_is_chosen_as_the_typescript_chose_it() {
        let tally = replay(
            "excerpt",
            |record| {
                let labels = entries(&record["entries"]);
                let of = label_fn(labels.as_ref());
                let excerpter = excerpter_for(&text(&record["query"]), Some(&of));
                json!(excerpter.excerpts(&texts(&record["texts"])))
            },
            |record| record["out"].clone(),
            tolerate_unicode,
        );
        assert_eq!(tally, Tally { replayed: 301, ill_formed: 0, tolerated: 0 });
    }

    #[test]
    fn every_recorded_search_ranks_as_the_typescript_ranked_it() {
        let tally = replay(
            "search",
            |record| {
                let documents: Vec<SearchableDocument> = record["documents"]
                    .as_array()
                    .expect("documents")
                    .iter()
                    .map(document_of)
                    .collect();
                let options = &record["options"];
                let expand = options.get("alsoIndex").and_then(Json::as_str).and_then(also);
                let labels = options.get("linkLabels").map(|_| {
                    let listed: Vec<LinkEntry> = documents
                        .iter()
                        .map(|doc| LinkEntry {
                            document_id: doc.document_id.clone(),
                            path: doc.path.clone(),
                            name: doc.name.clone(),
                        })
                        .collect();
                    LinkLabels::from_entries(&listed)
                });
                let of = label_fn(labels.as_ref());
                let hits = full_text_search(
                    &documents,
                    &text(&record["query"]),
                    &SearchOptions {
                        limit: options.get("limit").map(count),
                        excerpts: options.get("excerpts").and_then(Json::as_bool),
                        also_index: expand.as_deref(),
                        terms_of: None,
                        link_label: labels.as_ref().map(|_| &of as &dyn Fn(&str) -> Option<String>),
                    },
                );
                json!(
                    hits.iter()
                        .map(|hit| json!({
                            "documentId": hit.document_id,
                            "score": format!("{:016x}", hit.score.to_bits()),
                            "contexts": hit.contexts,
                        }))
                        .collect::<Vec<_>>()
                )
            },
            |record| record["hits"].clone(),
            tolerate_unicode,
        );
        assert_eq!(tally, Tally { replayed: 160, ill_formed: 0, tolerated: 0 });
    }

    fn canvas_of(value: &Json) -> SpatialCanvas {
        let nodes = value["nodes"].as_array().expect("nodes").iter().map(|node| SpatialNode {
            id: text(&node["id"]),
            label: node.get("label").map(text),
            resource: node.get("resource").map(|resource| NodeResource {
                mime_type: text(&resource["mimeType"]),
                content: resource.get("content").map(text),
                location: resource.get("location").map(text),
                subpath: resource.get("subpath").map(text),
            }),
            ..SpatialNode::default()
        });
        let edges = value["edges"].as_array().expect("edges").iter().map(|edge| CanvasEdge {
            id: text(&edge["id"]),
            label: edge.get("label").map(text),
            ..CanvasEdge::default()
        });
        SpatialCanvas { nodes: nodes.collect(), edges: edges.collect(), ..SpatialCanvas::default() }
    }

    #[test]
    fn every_recorded_content_contributes_the_texts_the_typescript_listed() {
        let tally = replay(
            "searchable-texts",
            |record| {
                let content = &record["content"];
                let description = content.get("description").map(text);
                if content["kind"] == "markdown" {
                    json!(searchable_texts(SearchableContent::Markdown {
                        body: content["body"].as_str().expect("a body"),
                        description: description.as_deref(),
                    }))
                } else {
                    json!(searchable_texts(SearchableContent::Spatial(&canvas_of(
                        &content["canvas"]
                    ))))
                }
            },
            |record| record["out"].clone(),
            never,
        );
        assert_eq!(tally, Tally { replayed: 11, ill_formed: 0, tolerated: 0 });
    }

    #[test]
    fn every_recorded_path_names_the_folders_the_typescript_named() {
        let tally = replay(
            "folders",
            |record| {
                let mut names = BTreeMap::new();
                for pair in record["names"].as_array().expect("names") {
                    names.insert(text(&pair[0]), text(&pair[1]));
                }
                json!(folder_names_of(&text(&record["path"]), &names))
            },
            |record| record["out"].clone(),
            never,
        );
        assert_eq!(tally, Tally { replayed: 80, ill_formed: 0, tolerated: 0 });
    }

    #[test]
    fn grapheme_cuts_differ_from_intl_segmenter_at_exactly_the_ledgered_cases() {
        let ledger: Json =
            serde_json::from_str(include_str!("grapheme_diff.json")).expect("the ledger");
        let mut differing = Vec::new();
        let recorded = records("graphemes");
        for (ordinal, record) in recorded.iter().enumerate() {
            let cuts: Vec<Json> =
                grapheme_cuts(&text(&record["in"])).into_iter().map(|cut| json!(cut)).collect();
            if json!(cuts) != record["cuts"] {
                differing.push(ordinal);
            }
        }
        let listed: Vec<usize> =
            ledger["cases"].as_array().expect("cases").iter().map(count).collect();
        assert_eq!(
            differing, listed,
            "the recorded grapheme cases cut differently, against the ledger"
        );
        assert_eq!(listed.len(), count(&ledger["count"]));
        assert_eq!(recorded.len(), 1500);
    }
}
