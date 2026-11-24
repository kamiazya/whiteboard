//! The vocabulary a workspace's tag bearers use (`packages/model`'s
//! `tagsInUse`): one row per tag, counted by what carries it, a bearer
//! counted once however often it repeats a tag, in code-unit order so every
//! machine answers the same list.

use std::collections::BTreeMap;

use whiteboard_model::tags::parse_scoped_tag;

use crate::facts::{BearerKind, TagBearer};

/// One tag in use, a scoped tag's halves beside it, and how many of each kind
/// of thing carry it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagInUse {
    pub tag: String,
    /// A scoped tag's key and value; none for a plain tag.
    pub scoped: Option<(String, String)>,
    pub documents: u32,
    pub boards: u32,
    pub nodes: u32,
    pub edges: u32,
}

impl TagInUse {
    fn new(tag: &str) -> Self {
        let scoped = parse_scoped_tag(tag).map(|(key, value)| (key.to_owned(), value.to_owned()));
        Self { tag: tag.to_owned(), scoped, documents: 0, boards: 0, nodes: 0, edges: 0 }
    }

    fn count(&mut self, what: BearerKind) {
        let held = match what {
            BearerKind::Document => &mut self.documents,
            BearerKind::Board => &mut self.boards,
            BearerKind::Node => &mut self.nodes,
            BearerKind::Edge => &mut self.edges,
        };
        *held = held.saturating_add(1);
    }
}

/// The rows over `bearers`, sorted by tag in UTF-16 code-unit order
/// (`compareCodeUnit`).
#[must_use]
pub fn tags_in_use<'a>(bearers: impl IntoIterator<Item = &'a TagBearer>) -> Vec<TagInUse> {
    let mut rows: BTreeMap<&str, TagInUse> = BTreeMap::new();
    for bearer in bearers {
        let mut seen: Vec<&str> = Vec::new();
        for tag in &bearer.tags {
            if seen.contains(&tag.as_str()) {
                continue;
            }
            seen.push(tag);
            rows.entry(tag).or_insert_with(|| TagInUse::new(tag)).count(bearer.what);
        }
    }
    let mut rows: Vec<TagInUse> = rows.into_values().collect();
    rows.sort_by(|a, b| a.tag.encode_utf16().cmp(b.tag.encode_utf16()));
    rows
}

#[cfg(test)]
mod tests {
    use super::{TagInUse, tags_in_use};
    use crate::facts::{BearerKind, TagBearer};

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn bearer(what: BearerKind, tags: &[&str]) -> TagBearer {
        let tags = tags.iter().map(|tag| (*tag).to_owned()).collect();
        TagBearer { what, id: None, text: String::new(), tags }
    }

    #[test]
    fn each_kind_of_bearer_counts_once_per_tag_it_carries() {
        let rows = tags_in_use(&[
            bearer(BearerKind::Document, &["health:failing", "ml", "ml"]),
            bearer(BearerKind::Board, &["ml"]),
            bearer(BearerKind::Node, &["ml", "health:failing"]),
            bearer(BearerKind::Edge, &["ml"]),
            bearer(BearerKind::Edge, &["ml"]),
        ]);
        let failing = TagInUse {
            tag: "health:failing".to_owned(),
            scoped: Some(("health".to_owned(), "failing".to_owned())),
            documents: 1,
            boards: 0,
            nodes: 1,
            edges: 0,
        };
        let ml = TagInUse {
            tag: "ml".to_owned(),
            scoped: None,
            documents: 1,
            boards: 1,
            nodes: 1,
            edges: 2,
        };
        assert_eq!(rows, [failing, ml]);
    }

    /// U+1F600 is the surrogate pair 0xD83D 0xDE00, so it sorts before
    /// U+FF5E by code unit, where byte (code point) order says the opposite.
    #[test]
    fn tags_sort_by_utf16_code_unit() {
        let rows = tags_in_use(&[bearer(BearerKind::Node, &["\u{FF5E}", "\u{1F600}", "a"])]);
        let order: Vec<&str> = rows.iter().map(|row| row.tag.as_str()).collect();
        assert_eq!(order, ["a", "\u{1F600}", "\u{FF5E}"]);
    }
}
