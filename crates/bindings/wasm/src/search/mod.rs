//! Lexical search over one JSON request (ADR-0054 step 8, B3).
//!
//! One export, `search_op`, answers every call a root makes into
//! `whiteboard-search`: a request is `[op, arg, ...]` and the answer is one
//! JSON text, `["ok", ...]` or `["refused", code]` (`input-too-large` past a
//! cap, `malformed` for a request the op does not read or a handle it does not
//! hold). Offsets are UTF-16 code units, as the TypeScript indexes a string,
//! and a score crosses as the 16 hex digits of its IEEE bits.
//!
//! The ops are stateless for text (`fold`, `find`, `tokens`, `snippet`,
//! `folders`, `texts`, `terms`, `excerpts`) and stateful for a corpus. A
//! corpus is an INDEX the instance holds under a handle (`index-new`,
//! `index-upsert`, `index-remove`, `index-query`, `index-release`), so a query
//! sends its string and not the corpus; link labels are held the same way
//! (`labels`, `labels-release`), so an excerpt names them by handle. Handles
//! are never reused, and a handle an earlier instance minted answers
//! `malformed`. The instance holds at most [`MAX_HELD_BYTES`] of indexes and
//! labels together, charged as [`whiteboard_search::TERM_OVERHEAD`] says.
//!
//! A host passes only well-formed strings: JSON cannot carry a lone surrogate
//! into a Rust `&str`, so the shim replaces one with U+FFFD, which has the
//! same length in UTF-16 units and the same answer to every question asked
//! here.

use crate::input_caps::SEARCH_OP;
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_model::spatial::{CanvasEdge, NodeResource, SpatialCanvas, SpatialNode};
use whiteboard_search::{
    LinkEntry, LinkLabels, SearchIndex, SearchableContent, cost_of, document_terms, excerpter_for,
    find_folded, fold_for_search, folder_names_of, searchable_texts, snippet_around, tokenize,
    tokenize_for_index,
};

const TOO_LARGE: &str = "input-too-large";
const MALFORMED: &str = "malformed";

/// A refusal's code, which is all the answer says.
type Refusal = &'static str;

/// The longest query any op reads. A query's tokens are looked up in every
/// document of a corpus, so an unbounded one multiplies a corpus's size; the
/// longest query the daemon accepts is 1,024 characters, at most 3 bytes a
/// unit.
pub const MAX_QUERY_BYTES: usize = 4096;

/// The indexes an instance holds at once. A root keeps one per workspace it
/// searches.
pub const MAX_INDEXES: usize = 16;

/// The link-label sets an instance holds at once. A root makes one per
/// listing it labels excerpts from and releases it with the listing.
pub const MAX_LABEL_SETS: usize = 64;

/// The documents one index holds: twice a workspace's ceiling
/// (`WORKSPACE_MAX_DOCUMENTS`, 2,000), so the second workspace a root has
/// open does not push the first out. This entry's `maxNodes`.
pub const MAX_INDEX_DOCUMENTS: usize = match SEARCH_OP.max_nodes {
    Some(n) => n,
    None => 0,
};

/// What every index and label set an instance holds may cost together:
/// about 3 million distinct terms, against the 2,849 of the largest document
/// in this repository.
pub const MAX_HELD_BYTES: usize = 128 * 1024 * 1024;

/// What a label set costs beyond its text: two map nodes, rounded up.
const LABEL_OVERHEAD: usize = 128;

struct Labelled {
    handle: u32,
    set: LinkLabels,
    cost: usize,
}

struct Indexed {
    handle: u32,
    index: SearchIndex,
}

/// What an instance holds between calls.
struct Held {
    /// What indexes and labels may cost together; [`MAX_HELD_BYTES`] outside a test.
    limit: usize,
    next: u32,
    indexes: Vec<Indexed>,
    labels: Vec<Labelled>,
}

impl Held {
    const fn new(limit: usize) -> Self {
        Self { limit, next: 0, indexes: Vec::new(), labels: Vec::new() }
    }

    fn bytes(&self) -> usize {
        let indexed = self.indexes.iter().map(|held| held.index.bytes_held());
        let labelled = self.labels.iter().map(|held| held.cost);
        indexed.chain(labelled).fold(0, usize::saturating_add)
    }

    /// A handle no earlier call was given.
    fn mint(&mut self) -> Result<u32, Refusal> {
        let handle = self.next;
        self.next = handle.checked_add(1).ok_or(TOO_LARGE)?;
        Ok(handle)
    }

    fn index_mut(&mut self, handle: u32) -> Result<&mut SearchIndex, Refusal> {
        let held = self.indexes.iter_mut().find(|held| held.handle == handle);
        held.map(|held| &mut held.index).ok_or(MALFORMED)
    }

    fn index(&self, handle: u32) -> Result<&SearchIndex, Refusal> {
        let held = self.indexes.iter().find(|held| held.handle == handle);
        held.map(|held| &held.index).ok_or(MALFORMED)
    }

    /// The labels a request names: none for `null`, a refusal for a handle
    /// that names none.
    fn labels_named(&self, wire: &Json) -> Result<Option<&LinkLabels>, Refusal> {
        if wire.is_null() {
            return Ok(None);
        }
        let handle = handle_of(wire)?;
        let held = self.labels.iter().find(|held| held.handle == handle);
        held.map(|held| Some(&held.set)).ok_or(MALFORMED)
    }
}

static HELD: Mutex<Held> = Mutex::new(Held::new(MAX_HELD_BYTES));

/// This instance's holdings. A wasm instance aborts on a panic, so a poisoned
/// lock is reached only natively, where what it guards is whole between calls.
fn held() -> MutexGuard<'static, Held> {
    HELD.lock().unwrap_or_else(PoisonError::into_inner)
}

fn text(wire: &Json) -> Result<&str, Refusal> {
    wire.as_str().ok_or(MALFORMED)
}

/// A string, or `null` for none.
fn optional_text(wire: &Json) -> Result<Option<&str>, Refusal> {
    if wire.is_null() { Ok(None) } else { text(wire).map(Some) }
}

fn list(wire: &Json) -> Result<&[Json], Refusal> {
    wire.as_array().map(Vec::as_slice).ok_or(MALFORMED)
}

fn texts(wire: &Json) -> Result<Vec<String>, Refusal> {
    list(wire)?.iter().map(|item| text(item).map(str::to_owned)).collect()
}

/// A non-negative integer, saturating: an offset or a limit past what a
/// `usize` holds asks for everything.
fn count(wire: &Json) -> Result<usize, Refusal> {
    let n = wire.as_u64().ok_or(MALFORMED)?;
    Ok(usize::try_from(n).unwrap_or(usize::MAX))
}

fn handle_of(wire: &Json) -> Result<u32, Refusal> {
    u32::try_from(wire.as_u64().ok_or(MALFORMED)?).map_err(|_| MALFORMED)
}

fn query_of(wire: &Json) -> Result<&str, Refusal> {
    let query = text(wire)?;
    if query.len() > MAX_QUERY_BYTES { Err(TOO_LARGE) } else { Ok(query) }
}

/// The request's `n`th argument.
fn arg(args: &[Json], at: usize) -> Result<&Json, Refusal> {
    args.get(at).ok_or(MALFORMED)
}

/// An op's arguments, exactly `n` of them.
fn exactly(args: &[Json], n: usize) -> Result<&[Json], Refusal> {
    if args.len() == n { Ok(args) } else { Err(MALFORMED) }
}

fn ok(rest: Vec<Json>) -> Json {
    let mut wire = vec![json!("ok")];
    wire.extend(rest);
    Json::Array(wire)
}

fn refused(code: &str) -> Json {
    json!(["refused", code])
}

/// A node as `searchable_texts` reads it: its label and its resource.
fn node_of(wire: &Json) -> Result<SpatialNode, Refusal> {
    let [label, resource] = list(wire)? else { return Err(MALFORMED) };
    let resource = if resource.is_null() {
        None
    } else {
        let [mime, content, location, subpath] = list(resource)? else { return Err(MALFORMED) };
        Some(NodeResource {
            mime_type: text(mime)?.to_owned(),
            content: optional_text(content)?.map(str::to_owned),
            location: optional_text(location)?.map(str::to_owned),
            subpath: optional_text(subpath)?.map(str::to_owned),
        })
    };
    Ok(SpatialNode {
        label: optional_text(label)?.map(str::to_owned),
        resource,
        ..SpatialNode::default()
    })
}

fn texts_of_content(args: &[Json]) -> Result<Json, Refusal> {
    let (kind, rest) = args.split_first().ok_or(MALFORMED)?;
    let listed = match (text(kind)?, rest) {
        ("markdown", [body, description]) => searchable_texts(SearchableContent::Markdown {
            body: text(body)?,
            description: optional_text(description)?,
        }),
        ("spatial", [nodes, edges]) => {
            let nodes = list(nodes)?.iter().map(node_of).collect::<Result<Vec<_>, _>>()?;
            let edges = list(edges)?
                .iter()
                .map(|label| {
                    Ok(CanvasEdge {
                        label: optional_text(label)?.map(str::to_owned),
                        ..CanvasEdge::default()
                    })
                })
                .collect::<Result<Vec<_>, Refusal>>()?;
            searchable_texts(SearchableContent::Spatial(&SpatialCanvas {
                nodes,
                edges,
                ..SpatialCanvas::default()
            }))
        }
        _ => return Err(MALFORMED),
    };
    Ok(ok(vec![json!(listed)]))
}

fn entries_of(wire: &Json) -> Result<(Vec<LinkEntry>, usize), Refusal> {
    let mut cost = 0_usize;
    let mut entries = Vec::new();
    for entry in list(wire)? {
        let [id, path, name] = list(entry)? else { return Err(MALFORMED) };
        let entry = LinkEntry {
            document_id: text(id)?.to_owned(),
            path: text(path)?.to_owned(),
            name: optional_text(name)?.map(str::to_owned),
        };
        let bytes =
            entry.document_id.len() + entry.path.len() + entry.name.as_ref().map_or(0, String::len);
        cost = cost.saturating_add(bytes.saturating_mul(2)).saturating_add(LABEL_OVERHEAD);
        entries.push(entry);
    }
    Ok((entries, cost))
}

fn make_labels(args: &[Json], held: &mut Held) -> Result<Json, Refusal> {
    let [wire] = exactly(args, 1)? else { return Err(MALFORMED) };
    let (entries, cost) = entries_of(wire)?;
    if held.labels.len() >= MAX_LABEL_SETS || held.bytes().saturating_add(cost) > held.limit {
        return Err(TOO_LARGE);
    }
    let handle = held.mint()?;
    held.labels.push(Labelled { handle, set: LinkLabels::from_entries(&entries), cost });
    Ok(ok(vec![json!(handle)]))
}

fn release_labels(args: &[Json], held: &mut Held) -> Result<Json, Refusal> {
    let handle = handle_of(arg(exactly(args, 1)?, 0)?)?;
    let before = held.labels.len();
    held.labels.retain(|each| each.handle != handle);
    Ok(ok(vec![json!(held.labels.len() < before)]))
}

fn snippet(args: &[Json], held: &Held) -> Result<Json, Refusal> {
    let [value, index, length, labels] = exactly(args, 4)? else { return Err(MALFORMED) };
    let labels = held.labels_named(labels)?;
    let label_of = |target: &str| labels.and_then(|each| each.label(target));
    let shown = snippet_around(
        text(value)?,
        count(index)?,
        count(length)?,
        labels.map(|_| &label_of as &dyn Fn(&str) -> Option<String>),
    );
    Ok(ok(vec![json!(shown)]))
}

fn excerpts(args: &[Json], held: &Held) -> Result<Json, Refusal> {
    let [query, labels, documents] = exactly(args, 3)? else { return Err(MALFORMED) };
    let labels = held.labels_named(labels)?;
    let label_of = |target: &str| labels.and_then(|each| each.label(target));
    let excerpter = excerpter_for(
        query_of(query)?,
        labels.map(|_| &label_of as &dyn Fn(&str) -> Option<String>),
    );
    let answered = list(documents)?
        .iter()
        .map(|each| Ok(excerpter.excerpts(&texts(each)?)))
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(ok(vec![json!(answered)]))
}

/// A term bag as the wire spells it: its length, then each `[term, count]` in
/// UTF-16 order, the order a JavaScript sort gives.
fn terms(args: &[Json]) -> Result<Json, Refusal> {
    let [path, name, texts_wire] = exactly(args, 3)? else { return Err(MALFORMED) };
    let bag = document_terms(text(path)?, optional_text(name)?, &texts(texts_wire)?, None);
    let mut counts: Vec<(&String, &usize)> = bag.counts.iter().collect();
    counts.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let counts: Vec<Json> = counts.iter().map(|(term, n)| json!([term, n])).collect();
    Ok(ok(vec![json!(bag.length), json!(counts)]))
}

fn folders(args: &[Json]) -> Result<Json, Refusal> {
    let [path, listed] = exactly(args, 2)? else { return Err(MALFORMED) };
    let mut named = BTreeMap::new();
    for pair in list(listed)? {
        let [folder, shown] = list(pair)? else { return Err(MALFORMED) };
        named.insert(text(folder)?.to_owned(), text(shown)?.to_owned());
    }
    Ok(ok(vec![json!(folder_names_of(text(path)?, &named))]))
}

fn index_new(held: &mut Held) -> Result<Json, Refusal> {
    if held.indexes.len() >= MAX_INDEXES {
        return Err(TOO_LARGE);
    }
    let handle = held.mint()?;
    held.indexes.push(Indexed { handle, index: SearchIndex::new() });
    Ok(ok(vec![json!(handle)]))
}

fn index_release(args: &[Json], held: &mut Held) -> Result<Json, Refusal> {
    let handle = handle_of(arg(exactly(args, 1)?, 0)?)?;
    let before = held.indexes.len();
    held.indexes.retain(|each| each.handle != handle);
    Ok(ok(vec![json!(held.indexes.len() < before)]))
}

fn index_upsert(args: &[Json], held: &mut Held) -> Result<Json, Refusal> {
    let [handle, id, path, name, texts_wire, folders_wire] = exactly(args, 6)? else {
        return Err(MALFORMED);
    };
    let own = document_terms(text(path)?, optional_text(name)?, &texts(texts_wire)?, None);
    // A folder bag exists exactly when the document sits in a named folder,
    // even one whose names hold no term: it still counts in the average.
    let named = if folders_wire.is_null() { Vec::new() } else { texts(folders_wire)? };
    let folder_bag = (!named.is_empty()).then(|| document_terms("", None, &named, None));
    let id = text(id)?;
    let cost = cost_of(&own).saturating_add(folder_bag.as_ref().map_or(0, cost_of));
    // The replaced document's cost is still in the total: refusing on the sum
    // is conservative by that much and never lets the corpus grow past the cap.
    let total = held.bytes().saturating_add(cost);
    let held_limit = held.limit;
    let index = held.index_mut(handle_of(handle)?)?;
    if (!index.contains(id) && index.len() >= MAX_INDEX_DOCUMENTS) || total > held_limit {
        return Err(TOO_LARGE);
    }
    Ok(ok(vec![json!(index.upsert(id, own, folder_bag))]))
}

fn index_remove(args: &[Json], held: &mut Held) -> Result<Json, Refusal> {
    let [handle, id] = exactly(args, 2)? else { return Err(MALFORMED) };
    let id = text(id)?;
    Ok(ok(vec![json!(held.index_mut(handle_of(handle)?)?.remove(id))]))
}

fn index_query(args: &[Json], held: &Held) -> Result<Json, Refusal> {
    let [handle, query, limit] = exactly(args, 3)? else { return Err(MALFORMED) };
    let limit = if limit.is_null() { None } else { Some(count(limit)?) };
    let hits = held.index(handle_of(handle)?)?.search(query_of(query)?, limit);
    let hits: Vec<Json> =
        hits.iter().map(|(id, score)| json!([id, format!("{:016x}", score.to_bits())])).collect();
    Ok(ok(vec![json!(hits)]))
}

fn index_size(args: &[Json], held: &Held) -> Result<Json, Refusal> {
    let index = held.index(handle_of(arg(exactly(args, 1)?, 0)?)?)?;
    Ok(ok(vec![json!(index.len()), json!(index.bytes_held())]))
}

fn dispatch(op: &str, args: &[Json], held: &mut Held) -> Result<Json, Refusal> {
    match op {
        "fold" => {
            let [value] = exactly(args, 1)? else { return Err(MALFORMED) };
            Ok(ok(vec![json!(fold_for_search(text(value)?))]))
        }
        "find" => {
            let [value, needle] = exactly(args, 2)? else { return Err(MALFORMED) };
            let found = find_folded(text(value)?, text(needle)?);
            Ok(ok(vec![found.map_or(Json::Null, |at| json!([at.index, at.length]))]))
        }
        "tokens" => {
            let [value] = exactly(args, 1)? else { return Err(MALFORMED) };
            let value = text(value)?;
            Ok(ok(vec![json!(tokenize(value)), json!(tokenize_for_index(value))]))
        }
        "folders" => folders(args),
        "texts" => texts_of_content(args),
        "terms" => terms(args),
        "snippet" => snippet(args, held),
        "excerpts" => excerpts(args, held),
        "labels" => make_labels(args, held),
        "labels-release" => release_labels(args, held),
        "index-new" => {
            exactly(args, 0)?;
            index_new(held)
        }
        "index-release" => index_release(args, held),
        "index-upsert" => index_upsert(args, held),
        "index-remove" => index_remove(args, held),
        "index-query" => index_query(args, held),
        "index-size" => index_size(args, held),
        _ => Err(MALFORMED),
    }
}

/// The one search export; see the module's documentation.
#[wasm_bindgen]
#[must_use]
pub fn search_op(request: &str) -> String {
    answer(request, &mut held())
}

fn answer(request: &str, held: &mut Held) -> String {
    if request.len() > SEARCH_OP.max_bytes {
        return refused(TOO_LARGE).to_string();
    }
    let answer = match serde_json::from_str::<Json>(request) {
        Ok(Json::Array(parts)) => match parts.split_first() {
            Some((Json::String(op), args)) => dispatch(op, args, held),
            _ => Err(MALFORMED),
        },
        _ => Err(MALFORMED),
    };
    answer.unwrap_or_else(refused).to_string()
}

#[cfg(test)]
mod tests;
