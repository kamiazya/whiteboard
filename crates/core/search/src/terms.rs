//! What one document contributes to the index: how often each index token
//! occurs across its path, name and texts, and how many tokens that is.

use crate::tokenize::tokenize_runs;
use std::collections::BTreeMap;

/// The most distinct terms one document contributes to the index.
///
/// Without a ceiling a document's size in the index is its vocabulary: a body
/// of unrelated CJK ideographs has about 283,000 distinct terms. At the ceiling
/// indexing STOPS, rather than skipping new terms and counting on: a document
/// is found by what it says up to that point, and the path and name come first
/// so they are always indexed.
pub const DOCUMENT_TERMS_MAX: usize = 8192;

/// Extra searchable text a caller derives from a document's own content. It
/// answers TEXT and not tokens, so how a word is cut up stays this crate's
/// scheme; and it is for indexing only, never for an excerpt.
pub type AlsoIndex<'a> = &'a dyn Fn(&str) -> String;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentTerms {
    pub counts: BTreeMap<String, usize>,
    pub length: usize,
}

fn add_to(text: &str, also_index: AlsoIndex<'_>) -> String {
    let extra = also_index(text);
    if extra.is_empty() { text.to_owned() } else { format!("{text} {extra}") }
}

/// What one document contributes: a pure function of its text and the
/// expander.
#[must_use]
pub fn document_terms(
    path: &str,
    name: Option<&str>,
    texts: &[String],
    also_index: Option<AlsoIndex<'_>>,
) -> DocumentTerms {
    let mut terms = DocumentTerms::default();
    let mut count = |token: &str| -> bool {
        let held = terms.counts.get(token).copied();
        if held.is_none() && terms.counts.len() >= DOCUMENT_TERMS_MAX {
            return false;
        }
        terms.counts.insert(token.to_owned(), held.unwrap_or(0).saturating_add(1));
        terms.length = terms.length.saturating_add(1);
        true
    };
    let own = [path, name.unwrap_or("")];
    for text in own.iter().copied().chain(texts.iter().map(String::as_str)) {
        let indexed = also_index.map_or_else(|| text.to_owned(), |also| add_to(text, also));
        if !tokenize_runs(&indexed, true, &mut count) {
            break;
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn counts_each_index_token_across_path_name_and_texts() {
        let terms = document_terms("notes/a", Some("Alpha"), &["alpha beta".to_owned()], None);
        assert_eq!(terms.length, 5);
        assert_eq!(terms.counts.get("alpha"), Some(&2));
        assert_eq!(terms.counts.get("notes"), Some(&1));
    }

    #[test]
    fn an_expander_adds_text_and_an_empty_answer_adds_nothing() {
        let upper = |text: &str| text.to_uppercase();
        let with = document_terms("p", None, &["x".to_owned()], Some(&upper));
        assert_eq!(with.counts.get("x"), Some(&2));
        let none = |_: &str| String::new();
        assert_eq!(document_terms("p", None, &[], Some(&none)).length, 1);
    }

    #[test]
    fn indexing_stops_at_the_ceiling() {
        let body: String = (0..9000_u32).filter_map(|i| char::from_u32(0x4e00 + i)).collect();
        let terms = document_terms("", None, &[body], None);
        assert_eq!(terms.counts.len(), DOCUMENT_TERMS_MAX);
        assert!(terms.length >= DOCUMENT_TERMS_MAX);
    }
}
