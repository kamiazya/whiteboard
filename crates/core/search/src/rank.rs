//! BM25 over the documents' token bags, with the excerpts a result row shows.

use crate::excerpt::excerpter_for;
use crate::markup::LinkLabel;
use crate::terms::{AlsoIndex, DocumentTerms, document_terms};
use crate::tokenize::tokenize;
use crate::units::compare;
use std::collections::BTreeMap;
use whiteboard_det::fdlibm::ln;
use whiteboard_det::sort::js_sort_by;

/// Standard BM25 constants; nothing here has been tuned against a corpus.
const K1: f64 = 1.2;
const B: f64 = 0.75;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchableDocument {
    pub document_id: String,
    pub path: String,
    pub name: Option<String>,
    /// Body / node / label texts, each a separate string so snippets stay
    /// per-source.
    pub texts: Vec<String>,
    /// Display names of the named folders the document sits in. They find the
    /// document, but rank it below every document whose own name, path or text
    /// matched.
    pub folders: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub document_id: String,
    pub score: f64,
    /// Excerpts around the first match per text that contains one.
    pub contexts: Vec<String>,
}

#[derive(Default)]
pub struct SearchOptions<'a> {
    /// Ten when absent.
    pub limit: Option<usize>,
    /// False answers every hit with no contexts. True when absent.
    pub excerpts: Option<bool>,
    pub also_index: Option<AlsoIndex<'a>>,
    /// Where each document's terms come from, for a caller that holds them
    /// between queries. Supplied, it owns indexing outright.
    pub terms_of: Option<&'a dyn Fn(&SearchableDocument) -> DocumentTerms>,
    /// What a `[[link]]` in an excerpt shows.
    pub link_label: Option<LinkLabel<'a>>,
}

struct TokenBag<'a> {
    doc: &'a SearchableDocument,
    terms: DocumentTerms,
}

/// A count as the double JavaScript holds it; a count past `u32` is far beyond
/// any document set or token bag.
fn number(count: usize) -> f64 {
    f64::from(u32::try_from(count).unwrap_or(u32::MAX))
}

/// Each document's BM25 score over `bags`, out of `corpus` documents; zero
/// ones left out.
fn bm25(bags: &[TokenBag<'_>], query_tokens: &[String], corpus: usize) -> BTreeMap<String, f64> {
    let mut scores = BTreeMap::new();
    if bags.is_empty() {
        return scores;
    }
    let total: usize = bags.iter().map(|bag| bag.terms.length).sum();
    let avg_length = number(total) / number(bags.len().max(1));
    // Once per query token, not per (document, token) pair.
    let idf: Vec<f64> = query_tokens
        .iter()
        .map(|token| {
            let containing =
                number(bags.iter().filter(|bag| bag.terms.counts.contains_key(token)).count());
            ln(1.0 + (number(corpus) - containing + 0.5) / (containing + 0.5))
        })
        .collect();
    for bag in bags {
        let mut score = 0.0_f64;
        for (token, idf) in query_tokens.iter().zip(&idf) {
            let tf = number(bag.terms.counts.get(token).copied().unwrap_or(0));
            if tf == 0.0 {
                continue;
            }
            score += (idf * tf * (K1 + 1.0))
                / (tf + K1 * (1.0 - B + (B * number(bag.terms.length)) / avg_length.max(1.0)));
        }
        if score > 0.0 {
            scores.insert(bag.doc.document_id.clone(), score);
        }
    }
    scores
}

fn by_id(a: &SearchableDocument, b: &SearchableDocument) -> f64 {
    match compare(&a.document_id, &b.document_id) {
        core::cmp::Ordering::Less => -1.0,
        core::cmp::Ordering::Equal => 0.0,
        core::cmp::Ordering::Greater => 1.0,
    }
}

/// `a || b` over comparator results: the first one that is neither zero nor NaN.
fn first_nonzero(first: f64, second: impl FnOnce() -> f64) -> f64 {
    if first == 0.0 || first.is_nan() { second() } else { first }
}

/// Documents whose own text matched, by that score, then those only a folder
/// name matched. A folder-only hit's score is its folder score scaled under
/// the lowest own score, so the scores still descend down the answer.
fn rank_with_folders<'a>(
    documents: &'a [SearchableDocument],
    own: &BTreeMap<String, f64>,
    in_folders: &BTreeMap<String, f64>,
) -> Vec<(&'a SearchableDocument, f64)> {
    let mut own_hits: Vec<(&SearchableDocument, f64, f64)> = documents
        .iter()
        .filter_map(|doc| {
            own.get(&doc.document_id).map(|score| {
                (doc, *score, in_folders.get(&doc.document_id).copied().unwrap_or(0.0))
            })
        })
        .collect();
    js_sort_by(&mut own_hits, |a, b| {
        first_nonzero(b.1 - a.1, || first_nonzero(b.2 - a.2, || by_id(a.0, b.0)))
    });
    let mut folder_only: Vec<(&SearchableDocument, f64)> = documents
        .iter()
        .filter(|doc| !own.contains_key(&doc.document_id))
        .filter_map(|doc| in_folders.get(&doc.document_id).map(|folder| (doc, *folder)))
        .collect();
    js_sort_by(&mut folder_only, |a, b| first_nonzero(b.1 - a.1, || by_id(a.0, b.0)));
    let floor = own_hits.last().map(|hit| hit.1);
    let top = folder_only.first().map_or(0.0, |hit| hit.1);
    let mut ranked: Vec<(&SearchableDocument, f64)> =
        own_hits.iter().map(|(doc, score, _)| (*doc, *score)).collect();
    ranked.extend(folder_only.iter().map(|(doc, folder)| {
        (*doc, floor.map_or(*folder, |floor| (floor * folder) / (folder + top)))
    }));
    ranked
}

/// The distinct tokens of a query, in query order.
pub(crate) fn distinct_tokens(query: &str) -> Vec<String> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut distinct = Vec::new();
    for token in tokenize(query) {
        if !seen.contains(&token) {
            seen.insert(token.clone());
            distinct.push(token);
        }
    }
    distinct
}

/// BM25 over the documents' token bags, name and path included as text. Scores
/// are relative to THIS corpus: never compare across calls.
#[must_use]
pub fn full_text_search(
    documents: &[SearchableDocument],
    query: &str,
    options: &SearchOptions<'_>,
) -> Vec<SearchHit> {
    let query_tokens = distinct_tokens(query);
    if query_tokens.is_empty() {
        return Vec::new();
    }
    let terms_for = |doc: &SearchableDocument| match options.terms_of {
        Some(of) => of(doc),
        None => document_terms(&doc.path, doc.name.as_deref(), &doc.texts, options.also_index),
    };
    let bags: Vec<TokenBag<'_>> =
        documents.iter().map(|doc| TokenBag { doc, terms: terms_for(doc) }).collect();
    let own = bm25(&bags, &query_tokens, documents.len());
    // Only the documents that sit in a named folder have a folder bag; the rest
    // hold none of its terms, which is what the corpus size says for them.
    let folder_bags: Vec<TokenBag<'_>> = documents
        .iter()
        .filter_map(|doc| {
            let folders = doc.folders.as_deref().filter(|folders| !folders.is_empty())?;
            Some(TokenBag { doc, terms: document_terms("", None, folders, None) })
        })
        .collect();
    let in_folders = bm25(&folder_bags, &query_tokens, documents.len());
    let ranked = rank_with_folders(documents, &own, &in_folders);
    let excerpter =
        options.excerpts.unwrap_or(true).then(|| excerpter_for(query, options.link_label));
    ranked
        .into_iter()
        .take(options.limit.unwrap_or(10))
        .map(|(doc, score)| SearchHit {
            document_id: doc.document_id.clone(),
            score,
            contexts: excerpter.as_ref().map_or_else(Vec::new, |each| each.excerpts(&doc.texts)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_query_keeps_each_token_once_in_the_order_it_first_appears() {
        assert_eq!(distinct_tokens("b a b c a"), ["b", "a", "c"]);
        assert!(distinct_tokens("  ").is_empty());
    }

    fn doc(id: &str, texts: &[&str], folders: &[&str]) -> SearchableDocument {
        SearchableDocument {
            document_id: id.to_owned(),
            texts: texts.iter().map(|t| (*t).to_owned()).collect(),
            folders: (!folders.is_empty())
                .then(|| folders.iter().map(|f| (*f).to_owned()).collect()),
            ..SearchableDocument::default()
        }
    }

    fn ranked(documents: &[SearchableDocument]) -> Vec<String> {
        let options = SearchOptions { excerpts: Some(false), ..SearchOptions::default() };
        full_text_search(documents, "alpha", &options).into_iter().map(|h| h.document_id).collect()
    }

    #[test]
    fn a_higher_score_ranks_first_whatever_order_the_documents_arrive_in() {
        let short = doc("short", &["alpha"], &[]);
        let long = doc("long", &["alpha x y z"], &[]);
        assert_eq!(ranked(&[short.clone(), long.clone()]), ["short", "long"]);
        assert_eq!(ranked(&[long, short]), ["short", "long"]);
    }

    #[test]
    fn equal_scores_rank_by_document_id() {
        let same = |id: &str| doc(id, &["alpha"], &[]);
        assert_eq!(ranked(&[same("c"), same("a"), same("b")]), ["a", "b", "c"]);
        assert_eq!(ranked(&[same("b"), same("c"), same("a")]), ["a", "b", "c"]);
    }

    #[test]
    fn equal_own_scores_rank_by_folder_score_before_document_id() {
        let plain = doc("a", &["alpha"], &[]);
        let foldered = doc("b", &["alpha"], &["alpha"]);
        assert_eq!(ranked(&[plain.clone(), foldered.clone()]), ["b", "a"]);
        assert_eq!(ranked(&[foldered, plain]), ["b", "a"]);
    }

    #[test]
    fn documents_only_a_folder_name_matched_rank_by_folder_score_then_document_id() {
        let folder_only = |id: &str, folders: &[&str]| doc(id, &["unrelated"], folders);
        let strong = folder_only("z", &["alpha"]);
        let weak = folder_only("y", &["alpha x y z"]);
        assert_eq!(ranked(&[weak.clone(), strong.clone()]), ["z", "y"]);
        assert_eq!(ranked(&[strong, weak]), ["z", "y"]);
        let tied = |id: &str| folder_only(id, &["alpha"]);
        assert_eq!(ranked(&[tied("c"), tied("a"), tied("b")]), ["a", "b", "c"]);
    }

    #[test]
    fn a_folder_only_hit_ranks_below_every_document_whose_own_text_matched() {
        let own = doc("own", &["alpha x y z"], &[]);
        let folder = doc("folder", &["unrelated"], &["alpha"]);
        assert_eq!(ranked(&[folder, own]), ["own", "folder"]);
    }
}
