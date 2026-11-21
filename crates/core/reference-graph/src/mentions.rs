//! Where a name occurs in a text OUTSIDE any `[[…]]` span: the one rule both
//! mention detection and linking apply, so what a panel lists is exactly what
//! linking will rewrite.

use crate::units::UnitOffsets;
use whiteboard_codec::references::{ReferenceMatch, find_next_reference};
use whiteboard_det::utf16;

/// One occurrence: where it is in UTF-16 units, as a JavaScript caller counts,
/// and in bytes, as a Rust caller slices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub index: usize,
    pub length: usize,
    pub byte_index: usize,
    pub byte_length: usize,
}

/// The spans, one at a time, so a caller that needs a few stops the walk
/// there. References are disjoint and come in order, so the only one that can
/// cover an occurrence is the first that ends after it: one forward pass over
/// both, each reference scanned only once an occurrence has reached it.
#[derive(Debug)]
pub struct UnlinkedNameSpans<'a> {
    text: &'a str,
    name: &'a str,
    reference: Option<ReferenceMatch<'a>>,
    cursor: usize,
    units: UnitOffsets<'a>,
    name_units: usize,
}

impl<'a> UnlinkedNameSpans<'a> {
    #[must_use]
    pub fn new(text: &'a str, name: &'a str) -> Self {
        Self {
            text,
            name,
            reference: find_next_reference(text, 0),
            cursor: 0,
            units: UnitOffsets::new(text),
            name_units: utf16::len(name),
        }
    }

    /// The first reference that ends after `at`, scanning only as far as needed.
    fn reference_past(&mut self, at: usize) {
        while let Some(reference) = self.reference {
            let end = reference.index.saturating_add(reference.full.len());
            if end > at {
                return;
            }
            self.reference = find_next_reference(self.text, end);
        }
    }
}

impl Iterator for UnlinkedNameSpans<'_> {
    type Item = Span;

    fn next(&mut self) -> Option<Span> {
        // An empty name occurs everywhere and nowhere in particular.
        if self.name.is_empty() {
            return None;
        }
        loop {
            let at = self.cursor.saturating_add(self.text.get(self.cursor..)?.find(self.name)?);
            self.cursor = at.saturating_add(self.name.len());
            self.reference_past(at);
            if self.reference.is_some_and(|reference| at >= reference.index) {
                continue;
            }
            return Some(Span {
                index: self.units.at(at),
                length: self.name_units,
                byte_index: at,
                byte_length: self.name.len(),
            });
        }
    }
}

/// Where `name` occurs in `text` outside any reference.
#[must_use]
pub fn unlinked_name_spans(text: &str, name: &str) -> Vec<Span> {
    UnlinkedNameSpans::new(text, name).collect()
}

#[cfg(test)]
mod tests {
    use super::unlinked_name_spans;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn indexes(text: &str, name: &str) -> Vec<usize> {
        unlinked_name_spans(text, name).iter().map(|s| s.index).collect()
    }

    #[test]
    fn a_name_inside_either_half_of_a_reference_is_not_a_mention() {
        assert_eq!(indexes("Plan [[Plan|Plan]] Plan", "Plan"), [0, 19]);
        assert_eq!(indexes("![[x]]Plan", "Plan"), [6]);
    }

    #[test]
    fn occurrences_do_not_overlap_and_are_placed_in_units() {
        assert_eq!(indexes("aaa", "aa"), [0]);
        assert_eq!(indexes("😀 x 😀", "😀"), [0, 5]);
        assert_eq!(indexes("x", ""), Vec::<usize>::new());
    }
}
