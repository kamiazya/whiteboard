//! A corpus's token bags, kept between queries.
//!
//! [`full_text_search`](crate::full_text_search) tokenizes every document on
//! every call. A caller that knows when a document changed holds the corpus
//! here instead and pays tokenizing once per change: `upsert` a document,
//! `remove` one, `search` by string. The ranking is the same function over the
//! same bags, so an index answers what the call over the same documents does.

use crate::rank::{Ranked, distinct_tokens, rank};
use crate::terms::DocumentTerms;
use std::collections::BTreeMap;

/// The most hits a query answers when its caller names no limit.
pub const DEFAULT_LIMIT: usize = 10;

/// What a held term is charged beyond its own bytes: the map's node, the
/// string's header and the count, rounded up. An estimate to bound a corpus
/// by, not a measurement of the allocator.
pub const TERM_OVERHEAD: usize = 64;

struct Held {
    own: DocumentTerms,
    folders: Option<DocumentTerms>,
    /// [`cost_of`] both bags, computed once so a corpus's total is a running sum.
    cost: usize,
}

/// What one bag costs a corpus, so a caller can refuse a document before holding it.
#[must_use]
pub fn cost_of(terms: &DocumentTerms) -> usize {
    terms
        .counts
        .keys()
        .fold(0_usize, |sum, term| sum.saturating_add(term.len()).saturating_add(TERM_OVERHEAD))
}

/// The documents of one corpus, by id, as the two token bags each is scored by.
#[derive(Default)]
pub struct SearchIndex {
    held: BTreeMap<String, Held>,
    bytes: usize,
}

impl SearchIndex {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Holds `id` as `own` and, when it sits in a named folder, `folders`;
    /// replaces what it held. Answers whether it held the id before.
    pub fn upsert(&mut self, id: &str, own: DocumentTerms, folders: Option<DocumentTerms>) -> bool {
        let cost = cost_of(&own).saturating_add(folders.as_ref().map_or(0, cost_of));
        let before = self.held.insert(id.to_owned(), Held { own, folders, cost });
        self.bytes = self.bytes.saturating_sub(before.as_ref().map_or(0, |held| held.cost));
        self.bytes = self.bytes.saturating_add(cost);
        before.is_some()
    }

    /// Whether it holds `id`.
    #[must_use]
    pub fn contains(&self, id: &str) -> bool {
        self.held.contains_key(id)
    }

    /// Forgets `id`; `false` when it held none.
    pub fn remove(&mut self, id: &str) -> bool {
        let Some(gone) = self.held.remove(id) else { return false };
        self.bytes = self.bytes.saturating_sub(gone.cost);
        true
    }

    /// How many documents it holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.held.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// What its bags cost, each distinct term charged its bytes and
    /// [`TERM_OVERHEAD`]: what a caller bounds a corpus by.
    #[must_use]
    pub fn bytes_held(&self) -> usize {
        self.bytes
    }

    /// The `limit` best documents for `query` (ten when `None`) as their ids
    /// and BM25 scores, best first. Scores are relative to THIS corpus.
    #[must_use]
    pub fn search(&self, query: &str, limit: Option<usize>) -> Vec<(String, f64)> {
        let query_tokens = distinct_tokens(query);
        if query_tokens.is_empty() {
            return Vec::new();
        }
        let entries: Vec<Ranked<'_>> = self
            .held
            .iter()
            .map(|(id, held)| Ranked { id, own: &held.own, folders: held.folders.as_ref() })
            .collect();
        rank(&entries, &query_tokens)
            .into_iter()
            .take(limit.unwrap_or(DEFAULT_LIMIT))
            .filter_map(|(at, score)| Some((entries.get(at)?.id.to_owned(), score)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rank::{SearchOptions, SearchableDocument, full_text_search};
    use crate::terms::document_terms;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn doc(id: &str, path: &str, texts: &[&str], folders: &[&str]) -> SearchableDocument {
        SearchableDocument {
            document_id: id.to_owned(),
            path: path.to_owned(),
            name: None,
            texts: texts.iter().map(|t| (*t).to_owned()).collect(),
            folders: (!folders.is_empty())
                .then(|| folders.iter().map(|f| (*f).to_owned()).collect()),
        }
    }

    fn put(index: &mut SearchIndex, doc: &SearchableDocument) {
        let own = document_terms(&doc.path, doc.name.as_deref(), &doc.texts, None);
        let folders = doc.folders.as_deref().map(|names| document_terms("", None, names, None));
        index.upsert(&doc.document_id, own, folders);
    }

    fn corpus() -> Vec<SearchableDocument> {
        vec![
            doc("a", "notes/alpha", &["alpha beta", "gamma"], &[]),
            doc("b", "notes/beta", &["alpha alpha alpha x y z"], &["ops"]),
            doc("c", "plan", &["unrelated"], &["alpha"]),
            doc("d", "日本/語", &["検索 alpha"], &[]),
        ]
    }

    fn by_call(
        documents: &[SearchableDocument],
        query: &str,
        limit: Option<usize>,
    ) -> Vec<(String, f64)> {
        let options = SearchOptions { limit, excerpts: Some(false), ..SearchOptions::default() };
        full_text_search(documents, query, &options)
            .into_iter()
            .map(|hit| (hit.document_id, hit.score))
            .collect()
    }

    #[test]
    fn an_index_answers_what_the_search_over_the_same_documents_answers() {
        let documents = corpus();
        let mut index = SearchIndex::new();
        for each in &documents {
            put(&mut index, each);
        }
        for query in ["alpha", "alpha beta", "検索", "ops", "nothing here", "  ", ""] {
            for limit in [None, Some(0), Some(1), Some(2), Some(50)] {
                let held = index.search(query, limit);
                let called = by_call(&documents, query, limit);
                let bits = |hits: &[(String, f64)]| -> Vec<(String, u64)> {
                    hits.iter().map(|(id, score)| (id.clone(), score.to_bits())).collect()
                };
                assert_eq!(bits(&held), bits(&called), "{query:?} limit {limit:?}");
            }
        }
    }

    #[test]
    fn what_order_documents_arrive_in_does_not_change_the_answer() {
        let mut forward = SearchIndex::new();
        let mut backward = SearchIndex::new();
        let documents = corpus();
        for each in &documents {
            put(&mut forward, each);
        }
        for each in documents.iter().rev() {
            put(&mut backward, each);
        }
        assert_eq!(forward.search("alpha", None), backward.search("alpha", None));
    }

    #[test]
    fn an_upsert_replaces_a_document_and_says_it_did() {
        let mut index = SearchIndex::new();
        assert!(!index.contains("a"));
        assert!(!index.upsert("a", document_terms("", None, &["alpha".to_owned()], None), None));
        assert!(index.contains("a"));
        assert!(index.upsert("a", document_terms("", None, &["beta".to_owned()], None), None));
        assert_eq!(index.len(), 1);
        assert!(index.search("alpha", None).is_empty());
        assert_eq!(index.search("beta", None).len(), 1);
    }

    #[test]
    fn a_removed_document_is_no_longer_found_and_the_corpus_shrinks() {
        let mut index = SearchIndex::new();
        for each in &corpus() {
            put(&mut index, each);
        }
        let before = index.bytes_held();
        assert!(index.remove("a"));
        assert!(!index.remove("a"));
        assert_eq!(index.len(), 3);
        assert!(index.bytes_held() < before);
        assert!(index.search("alpha", None).iter().all(|(id, _)| id != "a"));
        for id in ["b", "c", "d"] {
            index.remove(id);
        }
        assert!(index.is_empty());
        assert_eq!(index.bytes_held(), 0);
    }

    #[test]
    fn the_bytes_it_holds_charge_each_term_of_both_bags_and_follow_a_replacement() {
        let mut index = SearchIndex::new();
        assert!(index.is_empty());
        let own = document_terms("", None, &["alpha beta".to_owned()], None);
        let folders = document_terms("", None, &["gamma".to_owned()], None);
        index.upsert("a", own, Some(folders));
        assert!(!index.is_empty());
        assert_eq!(index.bytes_held(), (5 + 4 + 5) + 3 * TERM_OVERHEAD);
        index.upsert("a", document_terms("", None, &["x".to_owned()], None), None);
        assert_eq!(index.bytes_held(), 1 + TERM_OVERHEAD);
    }
}
