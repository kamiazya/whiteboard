//! The excerpts a result row quotes: where a query matches a text, as a span of
//! the ORIGINAL text so the excerpt says what the document says, accents
//! included.

use crate::fold::{Folded, Found, fold_for_search, fold_with_offsets, span_of};
use crate::markup::LinkLabel;
use crate::rank::distinct_tokens;
use crate::snippet::snippet_around;
use crate::units::trim_str;

/// The most distinct query tokens an excerpt looks for, in query order.
///
/// Each one is a scan of every answered text, so an unbounded query is a
/// multiplier on up to a document's whole text; ranking always reads every
/// token, so only which excerpt is quoted can differ, and only for a query past
/// this.
pub const EXCERPT_TOKENS_MAX: usize = 64;

/// How many excerpts a hit quotes.
const EXCERPTS_PER_HIT: usize = 3;

struct Match {
    found: Found,
    /// The query's distinct tokens this text holds; a verbatim hit outranks
    /// any count of them.
    score: usize,
}

/// Where the query matches `folded`: the raw needle if it occurs verbatim,
/// otherwise the earliest matching token.
fn first_match(folded: &Folded, needle: &str, tokens: &[String]) -> Option<Match> {
    if let Some(found) = span_of(folded, needle) {
        return Some(Match { found, score: tokens.len().saturating_add(1) });
    }
    let mut best: Option<Found> = None;
    let mut matched = 0_usize;
    for token in tokens {
        let Some(at) = span_of(folded, token) else { continue };
        matched = matched.saturating_add(1);
        if best.is_none_or(|held| at.index < held.index) {
            best = Some(at);
        }
    }
    best.map(|found| Match { found, score: matched })
}

/// Built once per query, so its tokens are cut up once rather than per hit.
pub struct Excerpter<'a> {
    needle: String,
    tokens: Vec<String>,
    link_label: Option<LinkLabel<'a>>,
}

#[must_use]
pub fn excerpter_for<'a>(query: &str, link_label: Option<LinkLabel<'a>>) -> Excerpter<'a> {
    let mut tokens = distinct_tokens(query);
    tokens.truncate(EXCERPT_TOKENS_MAX);
    Excerpter { needle: fold_for_search(&trim_str(query)), tokens, link_label }
}

impl Excerpter<'_> {
    /// The three texts that match best: one holding the query VERBATIM first,
    /// then by how many of its tokens a text holds, ties in document order. A
    /// query that only matches token-wise centres on the first matching token.
    #[must_use]
    pub fn excerpts(&self, texts: &[String]) -> Vec<String> {
        let mut found: Vec<(usize, usize, &String, Found)> = texts
            .iter()
            .enumerate()
            .filter_map(|(order, text)| {
                let folded = fold_with_offsets(text);
                first_match(&folded, &self.needle, &self.tokens)
                    .map(|matched| (matched.score, order, text, matched.found))
            })
            .collect();
        found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        found
            .into_iter()
            .take(EXCERPTS_PER_HIT)
            .map(|(_, _, text, at)| snippet_around(text, at.index, at.length, self.link_label))
            .collect()
    }
}
