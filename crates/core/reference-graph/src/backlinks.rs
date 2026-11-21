//! What links to a document, and which documents NAME it in prose without a
//! link, answered from one listing and the facts of its documents.
//!
//! References are derived facts, never content, and `[[Name]]` resolution
//! depends on the workspace's path table, so it happens here at query time
//! against the current listing, never at extraction: an extracted fact can stay
//! cached while its resolution changes under it. The aggregate is rebuilt per
//! call, which is in-memory work over cached facts.

use crate::mentions::UnlinkedNameSpans;
use crate::references::{NodeVia, RawReference};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use whiteboard_search::{LinkEntry, LinkLabels, snippet_around};

/// How many excerpts one source carries, as a backlink or as a mention:
/// enough to judge it, and a bound on an answer about a source dense with them.
const CONTEXTS_PER_SOURCE: usize = 3;

/// A document as the listing knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentEntry {
    pub document_id: String,
    pub path: String,
    pub name: Option<String>,
    pub kind: Option<String>,
}

/// A document's content facts, borrowed.
#[derive(Debug, Clone, Copy)]
pub struct DocumentFacts<'a> {
    pub refs: &'a [RawReference],
    pub texts: &'a [String],
}

/// One backlink or mention: the source, and short plain-text excerpts in
/// document order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BacklinkEntry {
    pub document_id: String,
    pub path: String,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub contexts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backlinks {
    pub backlinks: Vec<BacklinkEntry>,
    pub unlinked_mentions: Vec<BacklinkEntry>,
}

struct Alive<'a> {
    entry: &'a DocumentEntry,
    facts: Option<DocumentFacts<'a>>,
}

type Listing<'a> = BTreeMap<&'a str, Alive<'a>>;

/// The listing order the index contract fixes: segment-wise, by UTF-16 code
/// unit, a shorter path first when one is the other's prefix.
fn compare_document_paths(left: &str, right: &str) -> Ordering {
    let mut a = left.split('/');
    let mut b = right.split('/');
    loop {
        match (a.next(), b.next()) {
            (Some(x), Some(y)) if x != y => return x.encode_utf16().cmp(y.encode_utf16()),
            (Some(_), Some(_)) => {}
            (x, y) => return x.is_some().cmp(&y.is_some()),
        }
    }
}

/// Path, then id, so the order stays total.
fn listing_order(a: &BacklinkEntry, b: &BacklinkEntry) -> Ordering {
    compare_document_paths(&a.path, &b.path)
        .then_with(|| a.document_id.encode_utf16().cmp(b.document_id.encode_utf16()))
}

fn source_entry(id: &str, alive: &Alive<'_>, contexts: Vec<String>) -> BacklinkEntry {
    BacklinkEntry {
        document_id: id.to_owned(),
        path: alive.entry.path.clone(),
        name: alive.entry.name.clone(),
        kind: alive.entry.kind.clone(),
        contexts,
    }
}

/// The labels links read as, from the documents held, by path and by id.
fn labels_of(listing: &Listing<'_>) -> LinkLabels {
    let entries: Vec<LinkEntry> = listing
        .iter()
        .map(|(id, alive)| LinkEntry {
            document_id: (*id).to_owned(),
            path: alive.entry.path.clone(),
            name: alive.entry.name.clone(),
        })
        .collect();
    LinkLabels::from_entries(&entries)
}

fn excerpt(text: &str, index: usize, length: usize, labels: &LinkLabels) -> String {
    snippet_around(text, index, length, Some(&|target: &str| labels.label(target)))
}

/// Whether `reference` points at the target, by the reader's rule: a `[[…]]`
/// names a path or a document id and nothing else. `by_path` holds while no
/// other document shares the target's path.
fn resolves_to(reference: &RawReference, id: &str, path: &str, by_path: bool) -> bool {
    match reference {
        RawReference::Node { target, via: NodeVia::Embed, .. }
        | RawReference::Wikilink { target, by_id: true, .. } => target == id,
        RawReference::Node { target, via: NodeVia::File, .. } => target == path,
        RawReference::Wikilink { target, by_id: false, .. } => by_path && target == path,
    }
}

fn reference_context(reference: &RawReference, labels: &LinkLabels) -> String {
    match reference {
        RawReference::Wikilink { text, index, length, .. } => {
            excerpt(text, *index, *length, labels)
        }
        RawReference::Node { context, .. } => context.clone(),
    }
}

fn backlinks_of(id: &str, listing: &Listing<'_>, labels: &LinkLabels) -> Vec<BacklinkEntry> {
    let Some(target) = listing.get(id) else { return Vec::new() };
    let path = target.entry.path.as_str();
    // Paths only: a bracketed name is literal text here exactly as it is in
    // the preview. The one path that can resolve to the target is its own, and
    // only while no other document shares it.
    let by_path = listing.values().filter(|alive| alive.entry.path == path).count() == 1;
    let mut found = Vec::new();
    for (source, alive) in listing {
        let Some(facts) = alive.facts.filter(|_| *source != id) else { continue };
        let contexts: Vec<String> = facts
            .refs
            .iter()
            .filter(|reference| resolves_to(reference, id, path, by_path))
            .take(CONTEXTS_PER_SOURCE)
            .map(|reference| reference_context(reference, labels))
            .collect();
        if !contexts.is_empty() {
            found.push(source_entry(source, alive, contexts));
        }
    }
    found.sort_by(listing_order);
    found
}

/// Sources whose TEXT names `id`'s display name without a resolving
/// reference: the seeding half of the linking loop, where the system finds the
/// candidate and a human confirms. Occurrences inside any `[[…]]` span are
/// excluded whole, target and alias halves alike.
fn mentions_of(
    id: &str,
    name: &str,
    listing: &Listing<'_>,
    labels: &LinkLabels,
) -> Vec<BacklinkEntry> {
    let mut found = Vec::new();
    for (source, alive) in listing {
        let Some(facts) = alive.facts.filter(|_| *source != id) else { continue };
        let contexts: Vec<String> = facts
            .texts
            .iter()
            .flat_map(|text| {
                UnlinkedNameSpans::new(text, name)
                    .map(move |span| excerpt(text, span.index, span.length, labels))
            })
            .take(CONTEXTS_PER_SOURCE)
            .collect();
        if !contexts.is_empty() {
            found.push(source_entry(source, alive, contexts));
        }
    }
    found.sort_by(listing_order);
    found
}

/// Everything linking to `document_id`, and the documents that name it in
/// prose without a link, from one listing and its facts. The one definition of
/// "what links here" for both keepers, which list and read facts their own way.
/// A document the listing holds no facts for contributes nothing.
#[must_use]
pub fn backlinks_in(
    entries: &[DocumentEntry],
    content: &BTreeMap<String, DocumentFacts<'_>>,
    document_id: &str,
) -> Backlinks {
    let listing: Listing<'_> = entries
        .iter()
        .map(|entry| {
            (
                entry.document_id.as_str(),
                Alive { entry, facts: content.get(&entry.document_id).copied() },
            )
        })
        .collect();
    let labels = labels_of(&listing);
    let name = listing.get(document_id).and_then(|alive| alive.entry.name.as_deref());
    Backlinks {
        backlinks: backlinks_of(document_id, &listing, &labels),
        unlinked_mentions: name
            .map(|name| mentions_of(document_id, name, &listing, &labels))
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::compare_document_paths;
    use std::cmp::Ordering;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn paths_order_by_segment_then_by_depth() {
        assert_eq!(compare_document_paths("a/b", "a-b"), Ordering::Less);
        assert_eq!(compare_document_paths("a", "a/b"), Ordering::Less);
        assert_eq!(compare_document_paths("a/b", "a"), Ordering::Greater);
        assert_eq!(compare_document_paths("a/b", "a/b"), Ordering::Equal);
        assert_eq!(compare_document_paths("\u{ff5e}", "\u{1f600}"), Ordering::Greater);
    }
}
