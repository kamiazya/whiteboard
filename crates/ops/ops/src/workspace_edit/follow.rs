//! Whether a move's follow pass (`followReferencesAfterRename`) would rewrite
//! any document: the aliases the move retires (`movesForPathChange` and
//! `planReferenceRewrite`'s keys), and whether any document's references, read as
//! the facts cache reads them, name one. A pass that rewrites nothing writes
//! nothing and reports nothing; one that rewrites is not answered here yet.

use std::collections::BTreeSet;

use whiteboard_reference_graph::{RawReference, extract_content_facts};
use whiteboard_workspace_index::document_path::is_self_or_descendant;
use whiteboard_workspace_index::{DocumentEntry, WorkspaceRecord, list_documents};

use super::Halt;
use crate::content::read_loaded;
use crate::document_get::engine::Hosted;

/// The old paths whose references a move of `from` rewrites (the caller has
/// held that it moves somewhere else): every document the move carried, but
/// a path that spells a live document's id, which resolves to that document
/// whoever's path it is.
pub(super) fn retired_aliases(before: &[DocumentEntry], from: &str) -> BTreeSet<String> {
    let live: BTreeSet<&str> = before.iter().map(|entry| entry.document_id.as_str()).collect();
    before
        .iter()
        .filter(|entry| is_self_or_descendant(&entry.path, from))
        .filter(|entry| !live.contains(entry.path.as_str()))
        .map(|entry| entry.path.clone())
        .collect()
}

/// Whether any document the record now holds names an alias the move of
/// `from` retired. A document whose content this crate does not read leaves
/// the pass undecided, even where the TypeScript's plan was empty and it read
/// nothing.
pub(super) fn rewrites_any(
    record: &WorkspaceRecord,
    before: &[DocumentEntry],
    from: &str,
) -> Result<bool, Halt> {
    let retired = retired_aliases(before, from);
    let after = list_documents(record).map_err(|_| Halt::Pending)?;
    for entry in &after {
        let hosted = Hosted { record, document_id: &entry.document_id };
        let facts = read_loaded(hosted, entry, extract_content_facts).map_err(|_| Halt::Pending)?;
        if facts.refs.iter().any(|reference| retired.contains(target_of(reference))) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn target_of(reference: &RawReference) -> &str {
    match reference {
        RawReference::Wikilink { target, .. } | RawReference::Node { target, .. } => target,
    }
}
