//! The references a text or a canvas holds, as facts: where each was written,
//! or the fixed phrase a node's own reference is quoted by.

use crate::units::UnitOffsets;
use std::sync::Arc;
use whiteboard_codec::references::find_next_reference;
use whiteboard_det::utf16;

/// How a node refers to a document without prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeVia {
    Embed,
    File,
}

/// A reference as extracted: the token as written, resolved only when asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawReference {
    /// A `[[…]]` in prose carries WHERE it was written: the text it was found
    /// in, shared rather than copied, and its span in UTF-16 units. Its
    /// excerpt is cut when a backlink is answered.
    Wikilink { target: String, by_id: bool, text: Arc<str>, index: usize, length: usize },
    /// A node's own reference, quoted by a fixed phrase.
    Node { target: String, via: NodeVia, context: String },
}

/// `ULID_PATTERN`: a canonical ULID, which is what `documentIdSchema` accepts.
#[must_use]
pub fn is_document_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 26
        && bytes.first().is_some_and(|b| (b'0'..=b'7').contains(b))
        && bytes.iter().skip(1).all(|b| {
            matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
        })
}

/// Every `[[…]]` and `![[…]]` of `value`, in order, as the facts a body contributes.
#[must_use]
pub fn text_references(value: &str) -> Vec<RawReference> {
    let shared: Arc<str> = Arc::from(value);
    let mut units = UnitOffsets::new(value);
    let mut found = Vec::new();
    let mut cursor = 0;
    while let Some(reference) = find_next_reference(value, cursor) {
        found.push(RawReference::Wikilink {
            target: reference.target.to_owned(),
            by_id: is_document_id(reference.target),
            text: Arc::clone(&shared),
            index: units.at(reference.index),
            length: utf16::len(reference.full),
        });
        cursor = reference.index.saturating_add(reference.full.len());
    }
    found
}

#[cfg(test)]
mod tests {
    use super::{RawReference, is_document_id, text_references};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_document_id_is_a_canonical_ulid_in_capitals() {
        assert!(is_document_id("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert!(!is_document_id("81ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert!(!is_document_id("01arz3ndektsv4rrffq69g5fav"));
        assert!(!is_document_id("01ARZ3NDEKTSV4RRFFQ69G5FAI"));
        assert!(!is_document_id("01ARZ3NDEKTSV4RRFFQ69G5FA"));
    }

    #[test]
    fn a_reference_after_an_astral_character_is_placed_in_units() {
        let found = text_references("😀 ![[a|b]]");
        let [RawReference::Wikilink { target, index, length, .. }] = found.as_slice() else {
            panic!("one wikilink, got {found:?}");
        };
        assert_eq!((target.as_str(), *index, *length), ("a", 3, 8));
    }
}
