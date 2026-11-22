//! What a path is, as a string: inside another, rebased, split, and whether
//! the grammar admits it. The rule is a SEGMENT boundary throughout.

use whiteboard_det::utf16;

/// `DOCUMENT_PATH_MAX_LENGTH`, in UTF-16 units.
pub const DOCUMENT_PATH_MAX_LENGTH: usize = 1024;
/// `WORKSPACE_SEGMENT_MAX_LENGTH`, in UTF-16 units.
pub const WORKSPACE_SEGMENT_MAX_LENGTH: usize = 200;

/// Whether `path` is `ancestor` itself or sits below it.
#[must_use]
pub fn is_self_or_descendant(path: &str, ancestor: &str) -> bool {
    path == ancestor || path.strip_prefix(ancestor).is_some_and(|rest| rest.starts_with('/'))
}

/// Where `path` is once the subtree rooted at `from` has become `to`; a path
/// outside the subtree comes back unchanged.
#[must_use]
pub fn rebase_path(path: &str, from: &str, to: &str) -> String {
    if path == from {
        return to.to_owned();
    }
    match path.strip_prefix(from) {
        Some(rest) if rest.starts_with('/') => format!("{to}{rest}"),
        _ => path.to_owned(),
    }
}

/// The folder `path` sits in; `""`, the workspace root, for a top-level path.
#[must_use]
pub fn parent_of_path(path: &str) -> &str {
    path.rfind('/').map_or("", |cut| path.get(..cut).unwrap_or(""))
}

/// The last segment of `path`, the whole path when it is top-level.
#[must_use]
pub fn leaf_of_path(path: &str) -> &str {
    path.rfind('/').map_or(path, |cut| path.get(cut.saturating_add(1)..).unwrap_or(""))
}

/// `compareDocumentPaths`, the port's order for a listing: segment against
/// segment by UTF-16 code unit, and a path sorts before every path it prefixes.
#[must_use]
pub fn compare_document_paths(left: &str, right: &str) -> std::cmp::Ordering {
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

/// ASCII letters and digits with interior hyphens, which is
/// `DOCUMENT_PATH_SEGMENT_PATTERN`.
fn is_path_segment(segment: &str) -> bool {
    let alnum = |c: char| c.is_ascii_alphanumeric();
    let mut chars = segment.chars();
    let Some(first) = chars.next() else { return false };
    if !alnum(first) {
        return false;
    }
    segment.chars().all(|c| alnum(c) || c == '-') && segment.chars().next_back().is_some_and(alnum)
}

/// `documentPathSchema`: non-empty, within the bound, every segment valid.
#[must_use]
pub fn is_document_path(path: &str) -> bool {
    !path.is_empty()
        && utf16::len(path) <= DOCUMENT_PATH_MAX_LENGTH
        && path.split('/').all(is_path_segment)
}

/// What a canonical ULID is spelled as, which a workspace segment must not be.
fn is_ulid_shaped(upper: &str) -> bool {
    let mut chars = upper.chars();
    let first_ok = chars.next().is_some_and(|c| ('0'..='7').contains(&c));
    first_ok
        && upper.chars().count() == 26
        && chars.all(
            |c| matches!(c, '0'..='9' | 'A'..='H' | 'J' | 'K' | 'M' | 'N' | 'P'..='T' | 'V'..='Z'),
        )
}

/// `workspaceSegmentSchema`: a path segment within the bound that is not
/// shaped like a ULID in either case.
#[must_use]
pub fn is_workspace_segment(segment: &str) -> bool {
    utf16::len(segment) <= WORKSPACE_SEGMENT_MAX_LENGTH
        && is_path_segment(segment)
        && !is_ulid_shaped(&segment.to_ascii_uppercase())
}

/// A leaf the new-document flow generated: `untitled`, or `untitled-N` for
/// N >= 2 (`isGeneratedDocumentPath`).
#[must_use]
pub fn is_generated_document_path(path: &str) -> bool {
    let leaf = leaf_of_path(path);
    let Some(rest) = leaf.strip_prefix("untitled") else { return false };
    if rest.is_empty() {
        return true;
    }
    let Some(digits) = rest.strip_prefix('-') else { return false };
    let mut chars = digits.chars();
    let Some(first) = chars.next() else { return false };
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if digits.chars().count() == 1 { ('2'..='9').contains(&first) } else { first != '0' }
}

#[cfg(test)]
mod tests {
    #[test]
    fn listings_order_segment_by_segment_by_code_unit() {
        use std::cmp::Ordering::{Equal, Greater, Less};
        assert_eq!(compare_document_paths("a", "a"), Equal);
        assert_eq!(compare_document_paths("a", "a/b"), Less);
        assert_eq!(compare_document_paths("a/b", "a"), Greater);
        assert_eq!(compare_document_paths("a-x", "a/b"), Greater);
        assert_eq!(compare_document_paths("a/z", "b/a"), Less);
        assert_eq!(compare_document_paths("B", "a"), Less);
        assert_eq!(compare_document_paths("\u{e000}", "\u{1f600}"), Greater);
    }

    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_descendant_is_judged_at_a_segment_boundary() {
        assert!(is_self_or_descendant("a/b", "a"));
        assert!(is_self_or_descendant("a", "a"));
        assert!(!is_self_or_descendant("ab", "a"));
        assert_eq!(rebase_path("a/b", "a", "c"), "c/b");
        assert_eq!(rebase_path("ab", "a", "c"), "ab");
        assert_eq!(rebase_path("a", "a", "c"), "c");
    }

    #[test]
    fn a_path_splits_into_its_parent_and_leaf() {
        assert_eq!(parent_of_path("a/b/c"), "a/b");
        assert_eq!(parent_of_path("a"), "");
        assert_eq!(leaf_of_path("a/b/c"), "c");
        assert_eq!(leaf_of_path("a"), "a");
    }

    #[test]
    fn the_path_grammar_is_ascii_with_interior_hyphens() {
        for good in ["a", "a-b", "a/b-c/d", "A1"] {
            assert!(is_document_path(good), "{good}");
        }
        for bad in ["", "-a", "a-", "a//b", "a/", "\u{e9}", "a b", "a\n"] {
            assert!(!is_document_path(bad), "{bad:?}");
        }
        assert!(!is_document_path(&"a".repeat(1025)));
        assert!(is_document_path(&"a".repeat(1024)));
    }

    #[test]
    fn a_workspace_segment_is_not_a_ulid_in_either_case() {
        assert!(is_workspace_segment("plan"));
        assert!(!is_workspace_segment("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert!(!is_workspace_segment("01arz3ndektsv4rrffq69g5fav"));
        assert!(is_workspace_segment("81ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert!(!is_workspace_segment("0ZZZZZZZZZZZZZZZZZZZZZZZZZ"));
        assert!(!is_workspace_segment(&"a".repeat(201)));
    }

    #[test]
    fn a_generated_address_is_untitled_or_untitled_from_two() {
        for good in ["untitled", "x/untitled", "untitled-2", "untitled-9", "untitled-10"] {
            assert!(is_generated_document_path(good), "{good}");
        }
        for bad in ["untitled-1", "untitled-0", "untitled-02", "untitled-", "untitled2", "x"] {
            assert!(!is_generated_document_path(bad), "{bad}");
        }
    }
}
