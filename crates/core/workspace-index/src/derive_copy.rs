//! What a duplicate is called and where it goes: beside its source, in the
//! source's folder, in the first free number rather than past the highest one
//! seen, held to the bound the schemas write with.

use crate::display_name::{display_name_key, js_trim_end};
use crate::document_path::{DOCUMENT_PATH_MAX_LENGTH, leaf_of_path, parent_of_path};
use crate::write_input::DOCUMENT_NAME_MAX_LENGTH;
use std::collections::BTreeSet;
use whiteboard_det::utf16;

/// The longest prefix of `text` of whole characters within `max` UTF-16 units.
/// A cut never lands inside a surrogate pair: the pair is dropped whole.
fn fit_to_length(text: &str, max: usize) -> &str {
    let mut units = 0_usize;
    for (at, c) in text.char_indices() {
        units = units.saturating_add(c.len_utf16());
        if units > max {
            return text.get(..at).unwrap_or_default();
        }
    }
    text
}

/// "Foo" -> "Foo (copy)" -> "Foo (copy 2)" -> ..., compared as the siblings'
/// rule compares, so a copy never takes a name another document shows in
/// another case. A base at the bound is shortened to make room for the suffix.
#[must_use]
pub fn derive_copy_name(base_name: &str, existing_names: &[String]) -> String {
    let taken: BTreeSet<String> =
        existing_names.iter().map(|name| display_name_key(name)).collect();
    let candidate = |suffix: &str| {
        let room = DOCUMENT_NAME_MAX_LENGTH.saturating_sub(utf16::len(suffix));
        format!("{}{suffix}", js_trim_end(fit_to_length(base_name, room)))
    };
    let free = |name: &str| !taken.contains(&display_name_key(name));
    let first = candidate(" (copy)");
    if free(&first) {
        return first;
    }
    let mut n = 2_usize;
    loop {
        let name = candidate(&format!(" (copy {n})"));
        if free(&name) {
            return name;
        }
        n = n.saturating_add(1);
    }
}

/// `path` without the hyphens a cut can leave at its end.
fn trim_trailing_hyphens(text: &str) -> &str {
    text.trim_end_matches('-')
}

/// "notes/roadmap" -> "notes/roadmap-copy" -> "notes/roadmap-copy-2" -> ...
///
/// Only the last segment changes, so the copy stays in its source's folder.
/// `None` when that folder leaves no room under the path bound for a copy
/// segment at all: putting the copy anywhere else would be a placement nobody
/// asked for.
#[must_use]
pub fn derive_copy_path(source_path: &str, existing_paths: &[String]) -> Option<String> {
    let parent = parent_of_path(source_path);
    let folder = if parent.is_empty() { String::new() } else { format!("{parent}/") };
    let leaf = leaf_of_path(source_path);
    let candidate = |suffix: &str| -> Option<String> {
        let room = DOCUMENT_PATH_MAX_LENGTH
            .saturating_sub(utf16::len(&folder))
            .saturating_sub(utf16::len(suffix));
        let kept = trim_trailing_hyphens(fit_to_length(leaf, room));
        (!kept.is_empty()).then(|| format!("{folder}{kept}{suffix}"))
    };
    let mut suffix = "-copy".to_owned();
    for n in 2_usize.. {
        let path = candidate(&suffix)?;
        if !existing_paths.contains(&path) {
            return Some(path);
        }
        suffix = format!("-copy-{n}");
    }
    None
}
