//! What two display names are compared as, and what an entry shows in its folder.

use crate::document_path::{
    is_document_path, is_generated_document_path, leaf_of_path, parent_of_path,
};
use unicode_normalization::UnicodeNormalization;
use whiteboard_det::utf16::is_js_whitespace;

/// The two kinds of entry a workspace names; compared apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedKind {
    Document,
    Folder,
}

/// An entry as the sibling rules read it: where it is and the name it was given.
#[derive(Debug, Clone, Copy)]
pub struct Named<'a> {
    pub path: &'a str,
    pub name: Option<&'a str>,
}

/// `String.prototype.trim`: ECMAScript whitespace and line terminators, which
/// is not Unicode `White_Space` (U+FEFF is trimmed, U+0085 is not).
#[must_use]
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c| u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace))
}

/// `String.prototype.trimEnd`.
#[must_use]
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(|c| u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace))
}

/// What two display names are compared as: trimmed, NFC-normalised, lower-cased.
#[must_use]
pub fn display_name_key(name: &str) -> String {
    js_trim(name).nfc().collect::<String>().to_lowercase()
}

/// What an entry shows where a person reads it in its folder: the trimmed
/// name, or its own last segment, except that an unnamed document at a
/// generated address shows `Untitled`, numbered as the address is.
#[must_use]
pub fn shown_name(kind: NamedKind, entry: Named<'_>) -> String {
    if let Some(name) = entry.name.map(js_trim).filter(|name| !name.is_empty()) {
        return name.to_owned();
    }
    let leaf = leaf_of_path(entry.path);
    if kind == NamedKind::Folder || !is_generated_document_path(leaf) {
        return leaf.to_owned();
    }
    let numbered = leaf.get("untitled".len()..).unwrap_or("").replacen('-', " ", 1);
    format!("Untitled{numbered}")
}

/// The name a sibling already shows that `target_name` duplicates, as that
/// sibling shows it; the siblings are `others`, directly under `target_path`'s
/// parent. The SIBLING's name is what a refusal quotes.
#[must_use]
pub fn sibling_display_name_taken(
    kind: NamedKind,
    others: &[Named<'_>],
    target_path: &str,
    target_name: &str,
) -> Option<String> {
    let parent = parent_of_path(target_path);
    let key = display_name_key(target_name);
    others
        .iter()
        .filter(|other| parent_of_path(other.path) == parent)
        .map(|other| shown_name(kind, *other))
        .find(|shown| display_name_key(shown) == key)
}

/// The name a sibling already shows that moving the entry at `from` to `to`
/// would make it show too. An entry that keeps the label it showed under the
/// same parent is no new duplicate.
#[must_use]
pub fn moved_display_name_taken(
    kind: NamedKind,
    staying: &[Named<'_>],
    from: &str,
    to: &str,
    name: Option<&str>,
) -> Option<String> {
    let shown = shown_name(kind, Named { path: to, name });
    let was_shown = shown_name(kind, Named { path: from, name });
    if parent_of_path(from) == parent_of_path(to)
        && display_name_key(&shown) == display_name_key(&was_shown)
    {
        return None;
    }
    sibling_display_name_taken(kind, staying, to, &shown)
}

/// The address an UNNAMED document takes so it does not read like a sibling:
/// `path` itself when it reads distinctly, else the first `-2`, `-3`, ...
/// address that is free and shows no sibling's label; `None` when none in
/// range is free or valid.
#[must_use]
pub fn first_distinct_unnamed_path(
    path: &str,
    siblings: &[Named<'_>],
    is_occupied: impl Fn(&str) -> bool,
) -> Option<String> {
    let reads = |candidate: &str| {
        let name = shown_name(NamedKind::Document, Named { path: candidate, name: None });
        sibling_display_name_taken(NamedKind::Document, siblings, candidate, &name).is_some()
    };
    if !reads(path) {
        return Some(path.to_owned());
    }
    let parent = parent_of_path(path);
    let stem = if is_generated_document_path(path) {
        if parent.is_empty() { "untitled".to_owned() } else { format!("{parent}/untitled") }
    } else {
        path.to_owned()
    };
    for n in 2..1000_u32 {
        let candidate = format!("{stem}-{n}");
        if !is_document_path(&candidate) {
            return None;
        }
        if !is_occupied(&candidate) && !reads(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn names_that_read_as_one_share_a_key() {
        assert_eq!(display_name_key(" Week 6\u{feff}"), display_name_key("week 6"));
        assert_eq!(display_name_key("e\u{301}"), display_name_key("\u{e9}"));
        assert_ne!(display_name_key("\u{85}a"), display_name_key("a"));
    }

    #[test]
    fn an_unnamed_generated_address_shows_untitled_numbered() {
        let show = |path| shown_name(NamedKind::Document, Named { path, name: None });
        assert_eq!(show("a/untitled"), "Untitled");
        assert_eq!(show("a/untitled-3"), "Untitled 3");
        assert_eq!(show("a/plan"), "plan");
        assert_eq!(
            shown_name(NamedKind::Folder, Named { path: "untitled", name: Some(" ") }),
            "untitled"
        );
    }

    #[test]
    fn a_free_address_is_the_first_not_occupied_or_read_alike() {
        let siblings = [Named { path: "untitled", name: None }];
        assert_eq!(
            first_distinct_unnamed_path("untitled", &siblings, |_| false).as_deref(),
            Some("untitled-2")
        );
        let never = |_: &str| true;
        assert_eq!(first_distinct_unnamed_path("untitled", &siblings, never), None);
        let long = "a".repeat(1024);
        let held = [Named { path: &long, name: None }];
        assert_eq!(first_distinct_unnamed_path(&long, &held, |_| false), None);
    }
}
