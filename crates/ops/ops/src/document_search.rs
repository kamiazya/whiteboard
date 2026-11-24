//! `wb_document_search`: the documents of a workspace that words find, ranked,
//! or that a tag or kind filter admits, in path order.
//!
//! The ranking, the excerpts and the searchable text of a document are
//! `whiteboard-search`'s, the one program both roots rank with; what is here is
//! `createDocumentSearchTool`'s selection around it. The filters decide
//! MEMBERSHIP: BM25 is relative to its corpus, so a filtered search ranks
//! within what the filters admit. A tag filter is met when ONE bearer carries
//! every listed tag (ADR-0040 decision 3): a note by its frontmatter, a board
//! by its own tags, or one node or edge.
//!
//! The lexical half alone: the TypeScript fuses a semantic ranking in when an
//! embedder is configured (`WHITEBOARD_SEMANTIC_SEARCH`), which no port here
//! supplies.

use std::collections::{BTreeMap, BTreeSet};

use whiteboard_api_contracts::Refusal;
use whiteboard_plugin_visual::emoji_search::emoji_search_text;
use whiteboard_ports::PortError;
use whiteboard_reference_graph::{ContentFacts, TagBearer, extract_content_facts};
use whiteboard_search::{
    LinkEntry, LinkLabels, SearchOptions, SearchableDocument, folder_names_of, full_text_search,
};
use whiteboard_workspace_index::display_name::js_trim;
use whiteboard_workspace_index::document_path::compare_document_paths;
use whiteboard_workspace_index::{
    DocumentEntry, WorkspaceRecord, list_documents, list_folder_names,
};

use crate::content::{Unread, read_loaded};
use crate::document_get::engine::Hosted;
use crate::document_list::refusal_for_read;
use crate::record::open_record;
use crate::{Contract, Operation, Ports, Row};

/// How much of a document's first text stands for it when nothing matched in
/// it, in UTF-16 units.
const OPENING_UNITS: usize = 120;

/// The workspace, already resolved to its canonical id, and what to find.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentSearchInput {
    pub workspace_id: String,
    pub query: Option<String>,
    pub kind: Option<String>,
    pub tags: Option<Vec<String>>,
    pub limit: usize,
}

/// One answer row: the document as the listing names it, its score, its
/// excerpts, and where the words ranked it.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub document_id: String,
    pub path: String,
    pub name: Option<String>,
    pub kind: Option<String>,
    /// BM25 over the admitted corpus; zero for a filter answered alone.
    pub score: f64,
    pub contexts: Vec<String>,
    /// 1-based; absent for a filter answered alone.
    pub lexical_rank: Option<usize>,
}

/// The results, or `Pending` for a workspace holding a read this crate does
/// not answer yet, or an opening the TypeScript cuts inside a surrogate pair,
/// which a Rust string cannot hold.
#[derive(Debug, Clone, PartialEq)]
pub enum DocumentSearchAnswer {
    Found(Vec<SearchResult>),
    Pending,
}

/// `createDocumentSearchTool`'s execute, which only `wb_document_search` calls.
#[derive(Debug, Clone, Copy)]
pub struct DocumentSearch;

impl Operation for DocumentSearch {
    type Input = DocumentSearchInput;
    type Output = DocumentSearchAnswer;

    const ROW: Row = Row {
        name: "documentSearch",
        tool: Some("wb_document_search"),
        route: None,
        input: Contract { schema: "documentSearchInputSchema" },
        output: Contract { schema: "documentSearchOutputSchema" },
    };

    async fn execute<P: Ports>(
        ports: &P,
        input: DocumentSearchInput,
    ) -> Result<DocumentSearchAnswer, Refusal> {
        if input.query.is_none() && input.tags.is_none() && input.kind.is_none() {
            return Err(Refusal::SearchNeedsQueryOrFilter);
        }
        let record = match open_record(ports.records(), &input.workspace_id).await {
            Ok(record) => record,
            Err(error) => return Err(refusal_for_read(ports, error).await),
        };
        match search(&record, &input) {
            Ok(results) => {
                Ok(results.map_or(DocumentSearchAnswer::Pending, DocumentSearchAnswer::Found))
            }
            Err(Unread::Refused(refusal)) => Err(refusal),
            Err(Unread::Pending) => Ok(DocumentSearchAnswer::Pending),
        }
    }
}

/// A document the filters admitted: what ranking reads of it, and what a
/// tag filter matched on it.
struct Candidate<'a> {
    entry: &'a DocumentEntry,
    searchable: SearchableDocument,
    /// What the bearers a tag filter matched are known by, the excerpt a
    /// filter alone answers with.
    named: Vec<String>,
}

/// The results, `None` where one cannot be written.
fn search(
    record: &WorkspaceRecord,
    input: &DocumentSearchInput,
) -> Result<Option<Vec<SearchResult>>, Unread> {
    // A stamp no `Date` holds throws from `toISOString` there.
    let entries = list_documents(record)
        .map_err(|_| Unread::Refused(Refusal::from(&PortError::InvalidTime)))?;
    let mut facts = Vec::with_capacity(entries.len());
    for entry in &entries {
        let hosted = Hosted { record, document_id: &entry.document_id };
        facts.push(read_loaded(hosted, entry, extract_content_facts)?);
    }
    let folder_names: BTreeMap<String, String> = list_folder_names(record).into_iter().collect();
    let candidates = admitted(&entries, facts, input, &folder_names);
    Ok(match &input.query {
        None => filtered(candidates, input.limit),
        Some(query) => Some(ranked(&entries, &candidates, query, input.limit)),
    })
}

/// The candidates the kind and tag filters admit, in listing order.
fn admitted<'a>(
    entries: &'a [DocumentEntry],
    facts: Vec<ContentFacts>,
    input: &DocumentSearchInput,
    folder_names: &BTreeMap<String, String>,
) -> Vec<Candidate<'a>> {
    let wanted: Option<BTreeSet<&str>> =
        input.tags.as_ref().map(|tags| tags.iter().map(String::as_str).collect());
    entries
        .iter()
        .zip(facts)
        .filter(|(entry, _)| input.kind.is_none() || entry.kind == input.kind)
        .filter_map(|(entry, facts)| {
            let named = match &wanted {
                None => Vec::new(),
                Some(wanted) => named_carrying(&facts.bearers, wanted)?,
            };
            let folders = folder_names_of(&entry.path, folder_names);
            let searchable = SearchableDocument {
                document_id: entry.document_id.clone(),
                path: entry.path.clone(),
                name: entry.name.clone(),
                texts: facts.texts,
                folders: (!folders.is_empty()).then_some(folders),
            };
            Some(Candidate { entry, searchable, named })
        })
        .collect()
}

/// What the bearers carrying every `wanted` tag are known by, or `None` when
/// no one bearer carries them all.
fn named_carrying(bearers: &[TagBearer], wanted: &BTreeSet<&str>) -> Option<Vec<String>> {
    let carrying: Vec<&TagBearer> = bearers
        .iter()
        .filter(|bearer| {
            let hit: BTreeSet<&str> =
                bearer.tags.iter().map(String::as_str).filter(|tag| wanted.contains(tag)).collect();
            hit.len() == wanted.len()
        })
        .collect();
    if carrying.is_empty() {
        return None;
    }
    Some(
        carrying
            .into_iter()
            .filter(|bearer| !bearer.text.is_empty())
            .map(|bearer| bearer.text.clone())
            .collect(),
    )
}

/// A filter with no words: every admitted document in path order, with
/// nothing ranked and what the filter matched, else the opening of its text,
/// for context. `None` where an opening cannot be written.
fn filtered(mut candidates: Vec<Candidate<'_>>, limit: usize) -> Option<Vec<SearchResult>> {
    candidates.sort_by(|a, b| compare_document_paths(&a.entry.path, &b.entry.path));
    candidates
        .into_iter()
        .take(limit)
        .map(|candidate| {
            let contexts = if candidate.named.is_empty() {
                opening_of(&candidate.searchable.texts)?
            } else {
                candidate.named
            };
            Some(row(candidate.entry, 0.0, contexts, None))
        })
        .collect()
}

/// The ranking over the admitted corpus, best first, with its excerpts and
/// each document's place in it.
fn ranked(
    entries: &[DocumentEntry],
    candidates: &[Candidate<'_>],
    query: &str,
    limit: usize,
) -> Vec<SearchResult> {
    let listed: Vec<LinkEntry> = entries
        .iter()
        .map(|entry| LinkEntry {
            document_id: entry.document_id.clone(),
            path: entry.path.clone(),
            name: entry.name.clone(),
        })
        .collect();
    let labels = LinkLabels::from_entries(&listed);
    let label_of = |target: &str| labels.label(target);
    let documents: Vec<SearchableDocument> =
        candidates.iter().map(|candidate| candidate.searchable.clone()).collect();
    let options = SearchOptions {
        limit: Some(limit),
        also_index: Some(&emoji_search_text),
        link_label: Some(&label_of),
        ..SearchOptions::default()
    };
    full_text_search(&documents, query, &options)
        .into_iter()
        .enumerate()
        .filter_map(|(at, hit)| {
            let entry = candidates
                .iter()
                .find(|candidate| candidate.entry.document_id == hit.document_id)?
                .entry;
            Some(row(entry, hit.score, hit.contexts, Some(at.saturating_add(1))))
        })
        .collect()
}

fn row(
    entry: &DocumentEntry,
    score: f64,
    contexts: Vec<String>,
    lexical_rank: Option<usize>,
) -> SearchResult {
    SearchResult {
        document_id: entry.document_id.clone(),
        path: entry.path.clone(),
        name: entry.name.clone(),
        kind: entry.kind.clone(),
        score,
        contexts,
        lexical_rank,
    }
}

/// The first text that is not blank, cut to its first [`OPENING_UNITS`]
/// UTF-16 units; none for a document with no such text, and `None` when the
/// cut falls inside a surrogate pair.
fn opening_of(texts: &[String]) -> Option<Vec<String>> {
    let Some(text) = texts.iter().find(|text| !js_trim(text).is_empty()) else {
        return Some(Vec::new());
    };
    let mut units = 0_usize;
    for (at, c) in text.char_indices() {
        if units == OPENING_UNITS {
            return Some(vec![text.get(..at)?.to_owned()]);
        }
        units = units.saturating_add(c.len_utf16());
        if units > OPENING_UNITS {
            return None;
        }
    }
    Some(vec![text.clone()])
}

#[cfg(test)]
mod tests;
