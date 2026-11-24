//! `wb_document_search` over `whiteboard-ops`'s `DocumentSearch`.

use serde_json::{Map, Value};
use whiteboard_ops::{DocumentSearch, DocumentSearchAnswer, DocumentSearchInput, SearchResult};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{Field, Input, Kind, Refined};
use super::json::Json;

/// The results a search answers when the caller names no limit.
const DEFAULT_LIMIT: usize = 10;

impl Binding for DocumentSearch {
    const NAME: &str = "wb_document_search";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_document_search.json");
    const INPUT: Input = Input {
        fields: &[
            WORKSPACE_ADDRESS,
            Field {
                name: "query",
                kind: Kind::Bounded {
                    max: 1024,
                    too_big: "a search query is longer than the 1024-character limit",
                },
            },
            Field { name: "kind", kind: Kind::Choice(&["spatial", "markdown"]) },
            Field {
                name: "tags",
                kind: Kind::Listed {
                    min: 1,
                    max: 1024,
                    too_big: "more tag filters than the 1024-tag limit for one document, board, node or edge",
                    item: Refined {
                        test: |tag| !tag.is_empty(),
                        message: "Too small: expected string to have >=1 characters",
                    },
                },
            },
            Field { name: "limit", kind: Kind::Whole { min: 1.0, max: 50.0 } },
        ],
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> DocumentSearchInput {
        let text = |key: &str| arguments.get(key).and_then(Value::as_str).map(str::to_owned);
        let tags = arguments.get("tags").and_then(Value::as_array).map(|tags| {
            tags.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()
        });
        // `INPUT` has held it whole, from 1 to 50; `10.0` is ten.
        let limit = arguments.get("limit").and_then(Value::as_f64);
        let limit = limit
            .and_then(|limit| (1..=50_u32).find(|n| f64::from(*n).to_bits() == limit.to_bits()));
        DocumentSearchInput {
            workspace_id: workspace_id.unwrap_or_default(),
            query: text("query"),
            kind: text("kind"),
            tags,
            limit: limit.and_then(|n| usize::try_from(n).ok()).unwrap_or(DEFAULT_LIMIT),
        }
    }

    fn output(answer: &DocumentSearchAnswer) -> Option<Json> {
        let DocumentSearchAnswer::Found(results) = answer else { return None };
        Some(Json::Object(vec![("results", Json::List(results.iter().map(result).collect()))]))
    }
}

/// A result in the order `describeHit` builds it, an absent field left out.
fn result(found: &SearchResult) -> Json {
    let text = |value: &str| Json::Text(value.to_owned());
    let mut members = vec![("documentId", text(&found.document_id)), ("path", text(&found.path))];
    members.extend(found.name.as_deref().map(|name| ("name", text(name))));
    members.extend(found.kind.as_deref().map(|kind| ("kind", text(kind))));
    members.push(("score", Json::Number(found.score)));
    members.push(("contexts", Json::List(found.contexts.iter().map(|c| text(c)).collect())));
    members.extend(found.lexical_rank.map(|rank| ("lexicalRank", rank_of(rank))));
    Json::Object(members)
}

fn rank_of(rank: usize) -> Json {
    Json::Number(f64::from(u32::try_from(rank).unwrap_or(u32::MAX)))
}
