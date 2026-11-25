//! `wb_facet_set` over `whiteboard-ops`'s `FacetSet`: its input judged whole,
//! with the tag grammar and the facet-key pattern where the schema holds
//! them, every refusal answered, and what the operation leaves pending
//! answered as a pending tool.

use serde_json::{Map, Value};
use whiteboard_model::Value as Plain;
use whiteboard_model::checks::canonical_ulid;
use whiteboard_model::tags::parse_scoped_tag;
use whiteboard_ops::{
    FacetSet, FacetSetAnswer, FacetSetInput, FacetTarget, MAX_DOCUMENTS, TagChange,
};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{
    Checked, Field, Input, Kind, Refined, aborts, at, bounded_issues, characters, expected, joined,
    length_issue, object_issues,
};
use super::json::Json;

/// `TAG_MAX_CHARS` and `TAGS_PER_ELEMENT_MAX`.
const TAG_MAX: usize = 1024;

const TAG_TOO_LONG: &str = "a tag is longer than the 1024-character limit for one tag";
const TOO_MANY_ADDED: &str =
    "more tags than the 1024-tag limit for one document, board, node or edge";
const TOO_MANY_REMOVED: &str =
    "more tags to remove than the 1024-tag limit for one document, board, node or edge";
const TOO_MANY_RENAMED: &str =
    "more tags to rename than the 1024-tag limit for one document, board, node or edge";
const SCOPED_TAG_RULE: &str = "a scoped tag is key:value with both halves lowercase identifiers ([a-z][a-z0-9-]*) and exactly one colon, e.g. health:failing";
const NAMES_NOTHING: &str = "name at least one tag to add, remove or rename";

impl Binding for FacetSet {
    const NAME: &str = "wb_facet_set";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_facet_set.json");
    const INPUT: Input = Input {
        fields: &[
            WORKSPACE_ADDRESS,
            Field {
                name: "documentIds",
                kind: Kind::List {
                    min: 1,
                    max: MAX_DOCUMENTS,
                    item: Refined { test: canonical_ulid, message: "must be a canonical ULID" },
                },
            },
            Field { name: "nodeId", kind: Kind::Checked(NODE_ID) },
            Field { name: "edgeId", kind: Kind::Checked(NODE_ID) },
            Field { name: "tags", kind: Kind::Checked(TAGS) },
            Field { name: "target", kind: Kind::Choice(&["document", "canvas"]) },
            Field { name: "facets", kind: Kind::Checked(FACETS) },
        ],
        refine: None,
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> FacetSetInput {
        let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
        let named = |key: &str| arguments.get(key).and_then(Value::as_str).map(str::to_owned);
        let list = |value: Option<&Value>| -> Vec<String> {
            value
                .and_then(Value::as_array)
                .map(|items| items.iter().map(text).collect())
                .unwrap_or_default()
        };
        let tags = arguments.get("tags").and_then(Value::as_object).map(|change| TagChange {
            add: list(change.get("add")),
            remove: list(change.get("remove")),
            rename: renames(change.get("rename")),
        });
        let target = arguments.get("target").and_then(Value::as_str).map(|target| match target {
            "canvas" => FacetTarget::Canvas,
            _ => FacetTarget::Document,
        });
        FacetSetInput {
            workspace_id: workspace_id.unwrap_or_default(),
            document_ids: list(arguments.get("documentIds")),
            node_id: named("nodeId"),
            edge_id: named("edgeId"),
            tags,
            target,
            facets: arguments.get("facets").and_then(Value::as_object).map(|facets| {
                facets.iter().map(|(key, value)| (key.clone(), plain(value))).collect()
            }),
        }
    }

    fn output(answer: &FacetSetAnswer) -> Option<Json> {
        let FacetSetAnswer::Updated(output) = answer else { return None };
        let updated = output.updated.iter().map(|document| {
            let mut members = vec![
                ("documentId", Json::Text(document.document_id.clone())),
                ("facets", Json::Plain(Plain::Map(document.facets.clone()))),
            ];
            if let Some(tags) = &document.tags {
                members.push(("tags", Json::List(tags.iter().cloned().map(Json::Text).collect())));
            }
            Json::Object(members)
        });
        Some(Json::Object(vec![("updated", Json::List(updated.collect()))]))
    }
}

/// `{ from, to }` pairs, in the order given.
fn renames(value: Option<&Value>) -> Vec<(String, String)> {
    let text = |entry: &Value, key: &str| {
        entry.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
    };
    value
        .and_then(Value::as_array)
        .map(|entries| entries.iter().map(|e| (text(e, "from"), text(e, "to"))).collect())
        .unwrap_or_default()
}

/// A JSON value as the plain tree an operation reads: a number the double
/// `JSON.parse` reads it as.
fn plain(value: &Value) -> Plain {
    match value {
        Value::Null => Plain::Null,
        Value::Bool(flag) => Plain::Bool(*flag),
        Value::Number(number) => Plain::Number(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => Plain::String(text.clone()),
        Value::Array(items) => Plain::Seq(items.iter().map(plain).collect()),
        Value::Object(members) => {
            Plain::Map(members.iter().map(|(key, held)| (key.clone(), plain(held))).collect())
        }
    }
}

/// `nodeIdSchema`: a string of at least one character.
const NODE_ID: Checked = Checked {
    issues: |path, value| match value {
        None => Vec::new(),
        Some(Value::String(id)) if !id.is_empty() => Vec::new(),
        Some(Value::String(_)) => vec![at(path, "node id must not be empty")],
        Some(_) => vec![expected(path, "string", value)],
    },
    aborts: None,
};

/// The `tags` change: a strict object of three optional lists, which must
/// name at least one tag. Zod judges that refinement only when no member
/// aborted the parse.
const TAGS: Checked = Checked { issues: tags_issues, aborts: None };

const TAG_FIELDS: &[Field] = &[
    Field { name: "add", kind: Kind::Checked(TAG_LIST_ADD) },
    Field { name: "remove", kind: Kind::Checked(TAG_LIST_REMOVE) },
    Field { name: "rename", kind: Kind::Checked(RENAMES) },
];

fn tags_issues(path: &str, value: Option<&Value>) -> Vec<String> {
    let Some(given) = value else { return Vec::new() };
    let Value::Object(change) = given else { return vec![expected(path, "object", value)] };
    let mut issues = object_issues(path, TAG_FIELDS, change);
    let aborted = TAG_FIELDS.iter().any(|field| aborts(&field.kind, change.get(field.name)));
    let named: usize = TAG_FIELDS
        .iter()
        .filter_map(|field| change.get(field.name).and_then(Value::as_array).map(Vec::len))
        .sum();
    if !aborted && named == 0 {
        issues.push(at(path, NAMES_NOTHING));
    }
    issues
}

/// An array held to `max`, judged before any item, as Zod judges one.
fn list_issues(
    path: &str,
    value: Option<&Value>,
    too_big: &str,
    item: fn(&str, &Value) -> Vec<String>,
) -> Vec<String> {
    match value {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            length_issue(path, (0, TAG_MAX), items.len(), "array", Some(too_big)).map_or_else(
                || {
                    items
                        .iter()
                        .enumerate()
                        .flat_map(|(at, held)| item(&joined(path, &at.to_string()), held))
                        .collect()
                },
                |issue| vec![issue],
            )
        }
        Some(Value::String(text)) => std::iter::once(expected(path, "array", value))
            .chain(length_issue(path, (0, TAG_MAX), characters(text), "string", Some(too_big)))
            .collect(),
        Some(_) => vec![expected(path, "array", value)],
    }
}

/// Whether a member is given and is no array: the type error that stops Zod
/// judging the refinement. An array's own faults need no say, since a list
/// naming a tag is what the refinement asks for.
fn not_a_list(value: Option<&Value>) -> bool {
    value.is_some_and(|held| !held.is_array())
}

/// A tag as it is written: bounded, and a colon makes it a scoped tag that
/// must hold the grammar, judged whatever the length checks said.
fn written_tag(path: &str, value: &Value) -> Vec<String> {
    let mut issues = bounded_issues(path, TAG_MAX, TAG_TOO_LONG, Some(value));
    if let Value::String(tag) = value
        && tag.contains(':')
        && parse_scoped_tag(tag).is_none()
    {
        issues.push(at(path, &format!("tag \"{tag}\" is not a scoped tag: {SCOPED_TAG_RULE}")));
    }
    issues
}

/// A tag named to find what is stored: held to no grammar.
fn stored_tag(path: &str, value: &Value) -> Vec<String> {
    bounded_issues(path, TAG_MAX, TAG_TOO_LONG, Some(value))
}

const TAG_LIST_ADD: Checked = Checked {
    issues: |path, value| list_issues(path, value, TOO_MANY_ADDED, written_tag),
    aborts: Some(not_a_list),
};

const TAG_LIST_REMOVE: Checked = Checked {
    issues: |path, value| list_issues(path, value, TOO_MANY_REMOVED, stored_tag),
    aborts: Some(not_a_list),
};

const RENAME_FIELDS: &[Field] = &[
    Field { name: "from", kind: Kind::Checked(RENAME_FROM) },
    Field { name: "to", kind: Kind::Checked(RENAME_TO) },
];

/// `from`: a stored name, required.
const RENAME_FROM: Checked = Checked {
    issues: |path, value| match value {
        None => vec![expected(path, "string", None)],
        Some(held) => stored_tag(path, held),
    },
    aborts: None,
};

/// `to`: a tag as written, required.
const RENAME_TO: Checked = Checked {
    issues: |path, value| match value {
        None => vec![expected(path, "string", None)],
        Some(held) => written_tag(path, held),
    },
    aborts: None,
};

fn rename_entry(path: &str, value: &Value) -> Vec<String> {
    match value {
        Value::Object(entry) => object_issues(path, RENAME_FIELDS, entry),
        _ => vec![expected(path, "object", Some(value))],
    }
}

const RENAMES: Checked = Checked {
    issues: |path, value| list_issues(path, value, TOO_MANY_RENAMED, rename_entry),
    aborts: Some(not_a_list),
};

/// `extensionFacetsSchema`: a record whose every key matches
/// `{namespace}.{name}/v{n}`.
const FACETS: Checked = Checked {
    issues: |path, value| {
        match value {
        None => Vec::new(),
        Some(Value::Object(facets)) => facets
            .keys()
            .filter(|key| !facet_key(key))
            .map(|key| {
                at(&joined(path, key), &format!("extension facet key \"{key}\" must match {{namespace}}.{{name}}/v{{n}}, e.g. \"visual.shape/v0\""))
            })
            .collect(),
        Some(_) => vec![expected(path, "record", value)],
    }
    },
    aborts: None,
};

/// `EXTENSION_FACET_KEY_PATTERN`: `/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$/`.
fn facet_key(key: &str) -> bool {
    let name = |part: &str| {
        part.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    let Some((namespace, rest)) = key.split_once('.') else { return false };
    let Some((facet, version)) = rest.split_once("/v") else { return false };
    name(namespace)
        && name(facet)
        && !version.is_empty()
        && version.chars().all(|c| c.is_ascii_digit())
}
