//! The WRITER of the reference grammar the scanner reads.

use crate::references::is_document_id;

/// What the scanner cannot read back inside the bracket pair: a `]`, which ends
/// a target or alias, and a line break, which cannot sit inside an inline
/// reference. The scanner knows no escape, so none is invented here.
const fn unwritable(c: char) -> bool {
    matches!(c, ']' | '\r' | '\n')
}

/// `|` ends a target and `#` begins its fragment; in an alias they are text.
const fn unwritable_as_target(c: char) -> bool {
    matches!(c, '|' | '#')
}

/// `[[target]]`, or `[[target|alias]]` when an alias is given; none when either
/// half is something the scanner would misread, never markup that reads back
/// as a different, shorter reference. An empty alias is no alias.
#[must_use]
pub fn reference_markup(target: &str, alias: Option<&str>) -> Option<String> {
    if target.is_empty() || target.chars().any(|c| unwritable(c) || unwritable_as_target(c)) {
        return None;
    }
    match alias {
        None | Some("") => Some(format!("[[{target}]]")),
        Some(alias) if alias.chars().any(unwritable) => None,
        Some(alias) => Some(format!("[[{target}|{alias}]]")),
    }
}

/// The document a reference names, as a listing knows it.
#[derive(Debug, Clone, Copy)]
pub struct ReferenceSubject<'a> {
    pub id: &'a str,
    pub path: &'a str,
    pub name: Option<&'a str>,
}

/// The markup that links to a document: its PATH, which is the written form,
/// or its id when the path cannot be written or would read as a different id
/// (ids resolve first, so the id spelling is the one nothing can shadow).
///
/// `label` is the prose to display instead of the target's name. One the
/// scanner cannot read, or one that repeats the path, is dropped rather than
/// written, since the bare reference shows the same name. When the path cannot
/// be written the id form carries `label`, or else the `name`.
#[must_use]
pub fn document_reference_markup(subject: &ReferenceSubject<'_>, label: Option<&str>) -> String {
    let wanted = label.filter(|label| !label.is_empty());
    if !is_document_id(subject.path) {
        let alias = wanted.filter(|wanted| *wanted != subject.path);
        if let Some(by_path) =
            reference_markup(subject.path, alias).or_else(|| reference_markup(subject.path, None))
        {
            return by_path;
        }
    }
    reference_markup(subject.id, wanted.or(subject.name))
        .or_else(|| reference_markup(subject.id, None))
        // An id never holds a bracket, so the arms above cannot refuse.
        .unwrap_or_else(|| format!("[[{}]]", subject.id))
}

#[cfg(test)]
mod tests {
    use super::{ReferenceSubject, document_reference_markup, reference_markup};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    #[test]
    fn a_half_the_scanner_would_misread_is_refused() {
        assert_eq!(reference_markup("a", Some("b")).as_deref(), Some("[[a|b]]"));
        assert_eq!(reference_markup("a", Some("")).as_deref(), Some("[[a]]"));
        assert_eq!(reference_markup("", None), None);
        assert_eq!(reference_markup("a|b", None), None);
        assert_eq!(reference_markup("a#b", None), None);
        assert_eq!(reference_markup("a]", None), None);
        assert_eq!(reference_markup("a\r", None), None);
        assert_eq!(reference_markup("a", Some("b\n")), None);
        assert_eq!(reference_markup("a", Some("b|#")).as_deref(), Some("[[a|b|#]]"));
    }

    #[test]
    fn a_document_is_linked_by_path_unless_the_path_cannot_carry_it() {
        let by = |path, name| {
            document_reference_markup(&ReferenceSubject { id: ID, path, name: Some("N") }, name)
        };
        assert_eq!(by("a/b", Some("Plan")), "[[a/b|Plan]]");
        assert_eq!(by("a/b", Some("a/b")), "[[a/b]]");
        assert_eq!(by("a/b", Some("x]")), "[[a/b]]");
        assert_eq!(by("a#b", Some("Plan")), format!("[[{ID}|Plan]]"));
        assert_eq!(by("a#b", None), format!("[[{ID}|N]]"));
        assert_eq!(by(ID, Some("Plan")), format!("[[{ID}|Plan]]"));
        assert_eq!(by("a#b", Some("x]")), format!("[[{ID}]]"));
    }
}
