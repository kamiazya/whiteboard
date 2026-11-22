//! `duplicateDocument`: a document copied beside its source as one change to the
//! record, so a keeper saves it once and no reader sees the copy empty or unnamed.

use crate::ceiling::refuse_new_documents;
use crate::derive_copy::{derive_copy_name, derive_copy_path};
use crate::display_name::{Named, NamedKind, shown_name};
use crate::entry::{DocumentEntry, require_time};
use crate::index_error::IndexError;
use crate::index_writes::{Outcome, created_entry};
use crate::node_meta::{DocumentMeta, NodeRead};
use crate::record::WorkspaceRecord;
use crate::tree_write::{NewDocument, copy_document_content, create_document_at_path};
use crate::walk::Walked;
use crate::write_input::{require_id, require_path};

/// `duplicateDocument`'s input; `without_annotations` leaves the comment
/// threads and open proposals behind, so the copy is the content alone.
pub struct DuplicateDocument<'a> {
    pub workspace_id: &'a str,
    pub path: &'a str,
    pub without_annotations: bool,
}

/// What a document shows where a person reads it in its folder.
fn shown(path: &str, meta: &DocumentMeta) -> String {
    shown_name(NamedKind::Document, Named { path, name: meta.name.as_deref() })
}

/// `duplicateDocument`: the path and the name of the copy are derived here,
/// from what the record holds now, so two duplicates of one source cannot both
/// take `-copy`. The copy is named as chosen, the way a name typed at create is.
pub fn duplicate_document(
    record: &WorkspaceRecord,
    input: &DuplicateDocument<'_>,
    mint: &mut dyn FnMut() -> String,
    now_ms: f64,
) -> Result<Outcome<DocumentEntry>, IndexError> {
    require_id(input.workspace_id)?;
    require_path(input.path)?;
    let walked = record.nodes();
    let documents: Vec<(&Walked, &DocumentMeta)> = walked
        .iter()
        .filter_map(|node| match &node.read {
            NodeRead::Document(meta) => Some((node, meta)),
            NodeRead::Folder { .. } => None,
        })
        .collect();
    let mut at_path = documents.iter().filter(|(node, _)| node.path == input.path);
    let Some(&(source, meta)) = at_path.next() else {
        return Err(IndexError::DocumentNotFound {
            workspace_id: input.workspace_id.to_owned(),
            target: input.path.to_owned(),
        });
    };
    if at_path.next().is_some() {
        return Err(IndexError::PathContested {
            workspace_id: input.workspace_id.to_owned(),
            path: input.path.to_owned(),
        });
    }
    refuse_new_documents(documents.len(), 1)?;
    let paths: Vec<String> = walked.iter().map(|node| node.path.clone()).collect();
    let path = derive_copy_path(&source.path, &paths)
        .ok_or_else(|| IndexError::NoRoomForCopy { path: source.path.clone() })?;
    require_time(now_ms)?;
    let document_id = mint();
    let names: Vec<String> = documents.iter().map(|(node, meta)| shown(&node.path, meta)).collect();
    let name = derive_copy_name(&shown(&source.path, meta), &names);
    let created =
        NewDocument { document_id: &document_id, kind: &meta.kind, name: Some(&name), now_ms };
    create_document_at_path(record.doc(), &path, &created)?;
    if let Some(to) = record.document_node(&document_id) {
        copy_document_content(record.doc(), source.id, to.id, input.without_annotations, now_ms)?;
    }
    created_entry(record, input.workspace_id, &document_id, &path)
}
