//! The writers of a hosted document's whole content and of the names and
//! stamps that follow it (`workspace-tree.ts`, `name-from-title.ts`,
//! `touched-documents.ts` and `workspace-duplicate.ts`): a content write made
//! as a diff, a name seeded from a heading, the edit clock an import moves,
//! and a document copied beside its source.

use super::{LORO, ZOD_ERROR, create_at, document_node, field, optional_number, text};
use crate::hosted_reads::is_safe_integer;
use crate::name_seed::{first_node_naming, seed_node};
use crate::node_meta::{META_KEYS, NodeRead, WORKSPACE_TREE_KEY};
use crate::record::WorkspaceRecord;
use crate::touched::touched_documents;
use crate::tree_write::NewDocument;
use whiteboard_crdt::{
    Fault, LoroDoc, NodeAt, Step, VersionVector, commit, import_bytes, project_node_without,
    set_meta, sync_node_content, tree,
};
use whiteboard_model::Value;
use whiteboard_model::encoding::base64_to_bytes;

/// The standalone document a writer's base64 `key` names.
fn source_of(args: &Value, key: &str) -> Result<LoroDoc, Fault> {
    let bytes = base64_to_bytes(text(args, key)?).ok_or(Fault::Declined)?;
    import_bytes(&bytes).map_err(|_| Fault::Declined)
}

/// `writeWorkspaceDocumentContent`'s body: `false`, with nothing written, when
/// the record holds no such document; `updatedAt` set to `stamp` only when the
/// content changed. Committed.
fn write_content_of(doc: &LoroDoc, id: &str, source: &LoroDoc, stamp: f64) -> Result<bool, Fault> {
    let Some(node) = document_node(doc, id) else { return Ok(false) };
    let at = NodeAt { doc, tree: WORKSPACE_TREE_KEY, node };
    if sync_node_content(at, source, &META_KEYS)? {
        set_meta(doc, WORKSPACE_TREE_KEY, node, "updatedAt", &Value::Number(stamp))
            .map_err(|_| LORO)?;
    }
    commit(doc);
    Ok(true)
}

/// `writeWorkspaceDocumentContent`.
pub(super) fn write_content(doc: &LoroDoc, args: &Value, now_ms: f64) -> Step {
    let (id, source) = (text(args, "documentId")?, source_of(args, "source")?);
    let stamp = optional_number(args, "updatedAt")?.unwrap_or(now_ms);
    write_content_of(doc, id, &source, stamp).map(|_| ())
}

/// `seedNameFromTitle`: the first node naming the document, breadth first.
fn seed_by_id(doc: &LoroDoc, id: &str) -> Step {
    if let Some(held) = tree(doc, WORKSPACE_TREE_KEY)
        && let Some(node) = first_node_naming(&held, id)
    {
        seed_node(doc, &held, node).map_err(|_| LORO)?;
    }
    commit(doc);
    Ok(())
}

/// `seedNameFromTitle`.
pub(super) fn seed_name(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    seed_by_id(doc, text(args, "documentId")?)
}

/// `writeDocumentContentAndName`.
pub(super) fn write_content_and_name(doc: &LoroDoc, args: &Value, now_ms: f64) -> Step {
    let (id, source) = (text(args, "documentId")?, source_of(args, "source")?);
    if write_content_of(doc, id, &source, now_ms)? {
        seed_by_id(doc, id)?;
    }
    Ok(())
}

/// `versionOfPairs`: `[peer, counter]` pairs, a later pair for a peer winning.
fn since(args: &Value) -> Result<VersionVector, Fault> {
    let Some(Value::Seq(pairs)) = field(args, "since") else { return Err(Fault::Declined) };
    let mut version = VersionVector::new();
    for pair in pairs {
        let Value::Seq(pair) = pair else { return Err(Fault::Declined) };
        let [Value::String(peer), Value::Number(counter)] = pair.as_slice() else {
            return Err(Fault::Declined);
        };
        let digits = !peer.is_empty() && peer.bytes().all(|b| b.is_ascii_digit());
        let peer: u64 = peer.parse().ok().filter(|_| digits).ok_or(Fault::Declined)?;
        let counter = (counter.fract() == 0.0 && (0.0..=f64::from(i32::MAX)).contains(counter))
            .then(|| counter.to_string().parse::<i32>().ok())
            .flatten()
            .ok_or(Fault::Declined)?;
        version.insert(peer, counter);
    }
    Ok(version)
}

/// `seedNamesFromTitles` over the documents the operations after `since` touched.
pub(super) fn seed_names(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let touched = touched_documents(doc, &since(args)?);
    if let Some(held) = tree(doc, WORKSPACE_TREE_KEY) {
        for each in &touched {
            seed_node(doc, &held, each.node).map_err(|_| LORO)?;
        }
    }
    commit(doc);
    Ok(())
}

/// `stampEditedDocuments`: `updatedAt` on every touched document whose content
/// was written; `at` absent is `Date.now`.
pub(super) fn stamp_edited(doc: &LoroDoc, args: &Value, now_ms: f64) -> Step {
    let touched = touched_documents(doc, &since(args)?);
    let stamp = optional_number(args, "at")?.unwrap_or(now_ms);
    if !is_safe_integer(stamp) {
        return Err(ZOD_ERROR);
    }
    for each in touched.iter().filter(|each| each.content_written) {
        set_meta(doc, WORKSPACE_TREE_KEY, each.node, "updatedAt", &Value::Number(stamp))
            .map_err(|_| LORO)?;
    }
    commit(doc);
    Ok(())
}

/// The annotation layer a copy without annotations leaves behind.
const ANNOTATION_LAYER_KEYS: [&str; 2] = ["threads", "proposals"];

/// `duplicateWorkspaceDocument`: the source's content, projected as a value
/// copy, written into a document created at `path` and named as chosen.
/// Nothing is written when the source is not in the tree or a document owns
/// `path`.
pub(super) fn duplicate(doc: &LoroDoc, args: &Value, now_ms: f64) -> Step {
    let (source_id, id) = (text(args, "sourceDocumentId")?, text(args, "documentId")?);
    let (path, name) = (text(args, "path")?, text(args, "name")?);
    let bare = match field(args, "withoutAnnotations") {
        None => false,
        Some(&Value::Bool(bare)) => bare,
        Some(_) => return Err(Fault::Declined),
    };
    let Some(source) = WorkspaceRecord::over(doc).document_node(source_id) else { return Ok(()) };
    let NodeRead::Document(meta) = &source.read else { return Ok(()) };
    let at = NodeAt { doc, tree: WORKSPACE_TREE_KEY, node: source.id };
    let omit: &[&str] = if bare { &ANNOTATION_LAYER_KEYS } else { &[] };
    let projection = project_node_without(at, omit).map_err(|_| Fault::Declined)?;
    let document = NewDocument {
        document_id: id,
        kind: &meta.kind,
        name: Some(name),
        created_at: now_ms,
        updated_at: now_ms,
    };
    if create_at(doc, path, &document)? {
        write_content_of(doc, id, &projection, now_ms)?;
    }
    Ok(())
}
