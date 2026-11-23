//! What a whole document's state says about itself, read off the value its
//! `toJSON` answers: the size a judged promote is charged in and the digest
//! that names its content. Both are functions of the merged state alone, so
//! every keeper that lists a document names the same size and the same key.

use crate::content::ok;
use crate::content_digest::content_digest_of;
use crate::read::deep_value;
use loro::LoroDoc;
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName, ReadResponse};

/// The containers a document's content lives in, which its digest names.
pub const CONTENT_KEYS: [&str; 13] = [
    "nodes",
    "edges",
    "lines",
    "canvas",
    "threads",
    "proposals",
    "facets",
    "nodeLocks",
    "edgeLocks",
    "core",
    "trust",
    "document",
    "body",
];

/// A key a JavaScript object cannot hold as data: assigning it sets the
/// prototype, so the TypeScript's `toJSON` never shows it while the document
/// does hold it.
const PROTO_KEY: &str = "__proto__";

/// `value` as the TypeScript's `toJSON` holds it: without its `__proto__` keys.
fn as_json_holds_it(value: &Value) -> Value {
    match value {
        Value::Map(entries) => Value::Map(
            entries
                .iter()
                .filter(|(key, _)| key != PROTO_KEY)
                .map(|(key, held)| (key.clone(), as_json_holds_it(held)))
                .collect(),
        ),
        Value::Seq(items) => Value::Seq(items.iter().map(as_json_holds_it).collect()),
        other => other.clone(),
    }
}

/// One per map entry and list element and one per UTF-16 unit of every string.
fn size_of(value: &Value) -> usize {
    match value {
        Value::String(text) => text.encode_utf16().count(),
        Value::Seq(items) => {
            items.iter().fold(items.len(), |total, item| total.saturating_add(size_of(item)))
        }
        Value::Map(entries) => entries.iter().fold(0_usize, |total, (_, held)| {
            total.saturating_add(1).saturating_add(size_of(held))
        }),
        _ => 0,
    }
}

/// The size of the document's state, in the unit a promote's version judging
/// is charged in. Read off the state, not the oplog: a node is one map entry
/// holding its whole object, so counting ops undercounts a board by what the
/// judge reads.
#[must_use]
pub fn state_size(doc: &LoroDoc) -> usize {
    size_of(&as_json_holds_it(&deep_value(doc)))
}

/// The digest of a document whose containers are roots of its own `LoroDoc`:
/// the content roots it holds, a container that holds nothing counting as
/// none.
#[must_use]
pub fn content_digest_of_document(doc: &LoroDoc) -> String {
    let Value::Map(roots) = as_json_holds_it(&deep_value(doc)) else {
        return content_digest_of(&[]);
    };
    let content: Vec<(String, Value)> = CONTENT_KEYS
        .iter()
        .filter_map(|key| {
            let (_, held) = roots.iter().find(|(root, _)| root == key)?;
            Some(((*key).to_owned(), held.clone()))
        })
        .collect();
    content_digest_of(&content)
}

/// The whole-document reads over a document that is the root of its own
/// `LoroDoc`, `None` for another query.
pub(crate) fn answer(doc: &LoroDoc, query: &Query) -> Option<ReadResponse> {
    Some(match query.query {
        #[expect(
            clippy::cast_precision_loss,
            reason = "a state size past 2^53 units is past what a document can hold, and the TypeScript counts in doubles"
        )]
        QueryName::StateSize => ok(Value::Number(state_size(doc) as f64)),
        QueryName::ContentDigest => ok(Value::String(content_digest_of_document(doc))),
        _ => return None,
    })
}
