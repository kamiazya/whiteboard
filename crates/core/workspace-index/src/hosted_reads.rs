//! A content query asked of the document hosted on a workspace tree node
//! (`args.documentId`), answered over a copy of the containers that node holds.
//!
//! The copy is what keeps the content reads written once, but it reads a key
//! the node holds as anything other than the container a reader opens there
//! (a scalar, or a container of another kind) as no container at all, where
//! the TypeScript's readers refuse the read. So the keys each read opens are
//! listed, and a node holding one of them wrongly is judged here, before the
//! copy is made.

use crate::engine_reads::refused;
use crate::node_meta::{NodeRead, WORKSPACE_TREE_KEY};
use crate::walk::walk;
use whiteboard_crdt::{
    CONTENT_QUERIES, ContainerKind, Entry, LoroDoc, NodeAt, NodeId, Tree, answer_content_query,
    project_node, tree,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName, ReadResponse};

/// `Number.MAX_SAFE_INTEGER`: `z.number().int()` refuses a number past it.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// What a reader refuses a key holding the wrong thing with.
const UNREADABLE_CONTENT: &str = "UnreadableDocumentContentError";

/// Whether `value` is an integer a JavaScript number holds exactly.
pub(crate) fn is_safe_integer(value: f64) -> bool {
    value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
}

/// The kinds a node's entry at `key` may be for a reader to open it: the body
/// is text, the retired elements root a list of either kind, the rest maps.
fn opens_as(key: &str) -> &'static [ContainerKind] {
    match key {
        "body" => &[ContainerKind::Text],
        "elements" => &[ContainerKind::List, ContainerKind::MovableList],
        _ => &[ContainerKind::Map],
    }
}

/// The keys of the node the TypeScript's reader for `name` opens, whichever
/// kind the document reads as: measured against it, one key held wrongly at a
/// time. A read that opens none answers over the copy whatever the node holds.
fn keys_opened(name: QueryName) -> &'static [&'static str] {
    match name {
        QueryName::DocumentKind => &["document"],
        QueryName::NodeLocks => &["nodeLocks"],
        QueryName::EdgeLocks => &["edgeLocks"],
        QueryName::Facets => &["facets"],
        QueryName::BodyDelta | QueryName::ThreadMarks => &["body"],
        QueryName::CommentThreads | QueryName::ThreadMessageCounts => &["threads"],
        QueryName::RetiredCommentRows => &["comments"],
        QueryName::Proposals => &["proposals"],
        QueryName::Annotations => &["comments", "threads"],
        QueryName::CoreFacets => &["core", "document"],
        QueryName::TrustFacets => &["document", "trust"],
        QueryName::MarkdownBody => &["body", "document", "nodes"],
        QueryName::SpatialCanvas => &["canvas", "edges", "elements", "lines", "nodes"],
        QueryName::DocumentContent | QueryName::DocumentContentWithTags => {
            &["body", "canvas", "core", "document", "edges", "elements", "lines", "nodes"]
        }
        QueryName::ImageRefIds => {
            &["body", "canvas", "edges", "elements", "lines", "nodes", "proposals"]
        }
        QueryName::RetiredStoredShape => &["canvas", "document", "edges", "elements", "nodes"],
        _ => &[],
    }
}

fn held_wrongly(held: &Tree, node: NodeId, key: &str) -> bool {
    match held.entry(node, key) {
        None => false,
        Some(Entry::Container { kind, .. }) => !opens_as(key).contains(&kind),
        Some(Entry::Value(_)) => true,
    }
}

/// How the keys a read opens stand on the node.
enum Stand {
    /// None is held wrongly: the read goes ahead over the copy.
    Readable,
    /// One is held wrongly and the read opens it alone, so it is refused.
    Refused,
    /// One is held wrongly among several, and the first refusal follows the
    /// order the reader opens them in (a retired shape it finds first is
    /// refused as that), so the caller answers.
    Undecided,
}

fn keys_stand(held: &Tree, node: NodeId, name: QueryName) -> Stand {
    let opened = keys_opened(name);
    if !opened.iter().any(|key| held_wrongly(held, node, key)) {
        Stand::Readable
    } else if opened.len() == 1 {
        Stand::Refused
    } else {
        Stand::Undecided
    }
}

fn is_text(value: &Value) -> bool {
    matches!(value, Value::String(_))
}

/// Whether `value` is a version as `[peer, counter]` pairs, as the reader's
/// schema holds `since`.
fn is_version(value: &Value) -> bool {
    let Value::Seq(pairs) = value else { return false };
    pairs.iter().all(|pair| {
        matches!(pair, Value::Seq(held) if matches!(held.as_slice(),
            [Value::String(_), Value::Number(counter)] if is_safe_integer(*counter)))
    })
}

/// Arguments the TypeScript's `readArgsSchema` refuses: a refusal of its own,
/// which this crate leaves to the caller.
struct ArgumentsRefused;

/// The `kind` a hosted read is asked with, holding the arguments besides
/// `documentId` to the TypeScript's `readArgsSchema`: `path`, `container` and
/// `since` are accepted and read by none of these queries.
fn kind_asked(rest: &[(String, Value)]) -> Result<Option<Value>, ArgumentsRefused> {
    let mut kind = None;
    for (key, value) in rest {
        let accepted = match key.as_str() {
            "path" | "container" => is_text(value),
            "since" => is_version(value),
            "kind" => matches!(value, Value::String(k) if k == "spatial" || k == "markdown"),
            _ => false,
        };
        if !accepted {
            return Err(ArgumentsRefused);
        }
        if key == "kind" {
            kind = Some(value.clone());
        }
    }
    Ok(kind)
}

/// The document a query names, and its arguments but that one; `None` for a
/// query that names none.
pub(crate) fn hosted(query: &Query) -> Option<(String, Vec<(String, Value)>)> {
    let Some(Value::Map(args)) = &query.args else { return None };
    let (id, rest): (Vec<_>, Vec<_>) =
        args.iter().cloned().partition(|(key, _)| key == "documentId");
    let Some((_, Value::String(id))) = id.into_iter().next() else { return None };
    Some((id, rest))
}

/// A content query asked of the document `document_id` names, `rest` being
/// its other arguments: `None` for a query the record leaves to the caller
/// (not a content query, refused arguments, or a node whose keys leave the
/// first refusal undecided). A document the record does not hold is refused
/// as the TypeScript refuses it: the whole-document reads say it is out of
/// range, the rest that there is no such document.
pub(crate) fn answer_hosted(
    doc: &LoroDoc,
    query: &Query,
    document_id: &str,
    rest: &[(String, Value)],
) -> Option<ReadResponse> {
    if !CONTENT_QUERIES.contains(&query.query) {
        return None;
    }
    let kind = kind_asked(rest).ok()?;
    let missing = match query.query {
        QueryName::StateSize
        | QueryName::ContentDigest
        | QueryName::TextLimitBreach
        | QueryName::DocumentJudgement => "RangeError",
        _ => "Error",
    };
    let found = walk(doc).0.into_iter().find(|walked| {
        matches!(&walked.read, NodeRead::Document(meta) if meta.document_id == document_id)
    });
    let Some(found) = found else { return Some(refused(missing)) };
    let held = tree(doc, WORKSPACE_TREE_KEY)?;
    match keys_stand(&held, found.id, query.query) {
        Stand::Undecided => return None,
        Stand::Refused => return Some(refused(UNREADABLE_CONTENT)),
        Stand::Readable => {}
    }
    let at = NodeAt { doc, tree: WORKSPACE_TREE_KEY, node: found.id };
    let Ok(projected) = project_node(at) else { return Some(refused(missing)) };
    let args = match (query.query, kind) {
        (QueryName::DocumentContent | QueryName::DocumentContentWithTags, Some(kind)) => {
            vec![("kind".to_owned(), kind)]
        }
        _ => Vec::new(),
    };
    let asked = Query { query: query.query, args: Some(Value::Map(args)) };
    answer_content_query(&projected, &asked)
}
