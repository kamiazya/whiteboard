//! How a drawn scene addresses a document, written in one place.
//!
//! A wiki link is drawn as `<a href="<documentId>">` and an embed placeholder
//! as `<a href="#<documentId>">`: addresses only the host application can
//! resolve, which a browser left to itself follows as a relative URL. The line
//! between those and an ordinary markdown link is the document-id grammar
//! itself, not "has no scheme": a relative link (`guide.md`) has no scheme and
//! names no document id.

use whiteboard_model::checks::canonical_ulid;

/// The href of a wiki link: the id itself, or the inert `#` for a value outside
/// the id grammar, which could be any URL.
#[must_use]
pub(super) fn document_href(document_id: &str) -> String {
    if canonical_ulid(document_id) { document_id.to_string() } else { "#".to_string() }
}

/// The href of an embed placeholder.
#[must_use]
pub(super) fn embed_href(document_id: &str) -> String {
    if canonical_ulid(document_id) { format!("#{document_id}") } else { "#".to_string() }
}

#[cfg(test)]
mod tests {
    use super::{document_href, embed_href};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    #[test]
    fn a_wiki_link_to_a_document_id_is_addressed_by_the_id_and_an_embed_by_the_hash_of_it() {
        assert_eq!(document_href(ID), ID);
        assert_eq!(embed_href(ID), format!("#{ID}"));
    }

    #[test]
    fn anything_outside_the_id_grammar_is_the_inert_hash() {
        let not_ids = [
            "",
            "doc-1",
            "https://example.com",
            "javascript:alert(1)",
            "01arz3ndektsv4rrffq69g5fav",
            "81ARZ3NDEKTSV4RRFFQ69G5FAV",
            "01ARZ3NDEKTSV4RRFFQ69G5FA",
            "01ARZ3NDEKTSV4RRFFQ69G5FAVV",
            "01ARZ3NDEKTSV4RRFFQ69G5FAU",
        ];
        for text in not_ids {
            assert_eq!(document_href(text), "#", "{text:?}");
            assert_eq!(embed_href(text), "#", "{text:?}");
        }
    }
}
