//! The writers of the record's own planes beside its tree, and of a document
//! node's meta (`workspace-tree.ts`, `workspace-trash.ts` and
//! `workspace-folder-name.ts`): the workspace's meta and pins, the trash, a
//! document's row-relocated meta, empty folders and folder names a restore
//! gives back.

use super::{ERROR_TYPE, LORO, ZOD_ERROR, document_node, field, text};
use crate::hosted_reads::is_safe_integer;
use crate::node_meta::WORKSPACE_TREE_KEY;
use crate::record::{PINNED_KEY, WORKSPACE_META_KEY};
use crate::trash::{TRASH_FOLDER_NAMES_MAX, is_digest};
use crate::tree_write::{
    forget_trash_entry, prune_empty_folders, reapply_folder_names, record_trash_entry, set_pinned,
};
use whiteboard_crdt::{
    ContainerKind, Entry, Fault, LoroDoc, Step, commit, peek, set_meta, set_root_entry,
};
use whiteboard_model::Value;
use whiteboard_model::checks::canonical_ulid;

fn entries(value: &Value) -> Option<&[(String, Value)]> {
    match value {
        Value::Map(entries) => Some(entries),
        _ => None,
    }
}

/// `z.number().int()`: a safe integer.
fn integer(value: Option<&Value>) -> Result<f64, Fault> {
    match value {
        Some(&Value::Number(n)) if is_safe_integer(n) => Ok(n),
        _ => Err(ZOD_ERROR),
    }
}

/// `setWorkspaceLastCompactedAt`.
pub(super) fn last_compacted_at(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let at = match field(args, "at") {
        held @ Some(Value::Number(_)) => integer(held)?,
        _ => return Err(Fault::Declined),
    };
    set_root_entry(doc, WORKSPACE_META_KEY, "lastCompactedAt", &Value::Number(at))
        .map_err(|_| LORO)?;
    commit(doc);
    Ok(())
}

/// `setWorkspacePinned`. A key holding a plain value is refused by the engine
/// as it opens the list; a map or a text there is no list to read.
pub(super) fn pinned(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let id = text(args, "documentId")?;
    let Some(&Value::Bool(pinned)) = field(args, "pinned") else { return Err(Fault::Declined) };
    if !canonical_ulid(id) {
        return Err(ZOD_ERROR);
    }
    match peek(doc, &format!("{WORKSPACE_META_KEY}/{PINNED_KEY}")) {
        None | Some(Entry::Container { kind: ContainerKind::MovableList, .. }) => {}
        Some(Entry::Value(_)) => return Err(LORO),
        Some(Entry::Container { kind: ContainerKind::Map | ContainerKind::Text, .. }) => {
            return Err(ERROR_TYPE);
        }
        Some(Entry::Container { .. }) => return Err(Fault::Declined),
    }
    set_pinned(doc, id, pinned).map_err(|_| LORO)
}

/// A string of at least one unit (`z.string().min(1)`).
fn non_empty(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(Value::String(text.clone())),
        _ => None,
    }
}

/// Whether `held`'s keys are all among `known` (a strict object's rule).
fn only(held: &[(String, Value)], known: &[&str]) -> bool {
    held.iter().all(|(key, _)| known.contains(&key.as_str()))
}

/// A strict `{ path, name }` row, both non-empty, in the schema's order.
fn folder_name_row(value: &Value) -> Option<Value> {
    let held = entries(value)?;
    let row =
        [("path", non_empty(field(value, "path"))?), ("name", non_empty(field(value, "name"))?)];
    only(held, &["path", "name"]).then(|| map_of(row))
}

fn map_of<const N: usize>(row: [(&str, Value); N]) -> Value {
    Value::Map(row.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

/// `{ algorithm: 'sha-256', digestHex }`, a key it does not know stripped.
fn blob(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    entries(value)?;
    let digest = non_empty(field(value, "digestHex"))?;
    let algorithm = non_empty(field(value, "algorithm"))?;
    let valid = matches!(&digest, Value::String(hex) if is_digest(hex))
        && algorithm == Value::String("sha-256".to_owned());
    valid.then(|| map_of([("algorithm", algorithm), ("digestHex", digest)]))
}

/// The keys a trash row may hold, in the order the schema writes them.
const TRASH_KEYS: [&str; 6] = ["documentId", "path", "name", "folderNames", "deletedAt", "blob"];

/// `trashEntrySchema.parse`: the row as the strict schema outputs it, or
/// `None` for one it refuses.
fn trash_row(entry: &Value) -> Option<(String, Value)> {
    let Some(Value::String(id)) = field(entry, "documentId") else { return None };
    if !canonical_ulid(id) || !only(entries(entry)?, &TRASH_KEYS) {
        return None;
    }
    let mut row = vec![
        ("documentId".to_owned(), Value::String(id.clone())),
        ("path".to_owned(), non_empty(field(entry, "path"))?),
    ];
    if let Some(name) = field(entry, "name") {
        row.push(("name".to_owned(), non_empty(Some(name))?));
    }
    if let Some(names) = field(entry, "folderNames") {
        let Value::Seq(names) = names else { return None };
        let names = names.iter().map(folder_name_row).collect::<Option<Vec<_>>>()?;
        (names.len() <= TRASH_FOLDER_NAMES_MAX).then_some(())?;
        row.push(("folderNames".to_owned(), Value::Seq(names)));
    }
    let deleted_at = integer(field(entry, "deletedAt")).ok().filter(|at| *at >= 0.0)?;
    row.push(("deletedAt".to_owned(), Value::Number(deleted_at)));
    row.push(("blob".to_owned(), blob(field(entry, "blob"))?));
    Some((id.clone(), Value::Map(row)))
}

/// `recordTrashEntry`.
pub(super) fn record_trash(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let entry = field(args, "entry").filter(|entry| entries(entry).is_some());
    let (id, row) = trash_row(entry.ok_or(Fault::Declined)?).ok_or(ZOD_ERROR)?;
    record_trash_entry(doc, &id, &row).map_err(|_| LORO)
}

/// `forgetTrashEntry`.
pub(super) fn forget_trash(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    forget_trash_entry(doc, text(args, "documentId")?).map_err(|_| LORO)
}

/// The keys a meta patch may hold, in the order the schema outputs them.
const PATCH_KEYS: [&str; 3] = ["kind", "createdAt", "updatedAt"];

/// The patch's fields as the strict schema outputs them, or `None` for one it refuses.
fn meta_patch(patch: &Value) -> Option<Vec<(&'static str, Value)>> {
    if !only(entries(patch)?, &PATCH_KEYS) {
        return None;
    }
    let mut fields = Vec::new();
    for key in PATCH_KEYS {
        let Some(value) = field(patch, key) else { continue };
        let valid = if key == "kind" {
            matches!(value, Value::String(kind) if kind == "spatial" || kind == "markdown")
        } else {
            integer(Some(value)).is_ok()
        };
        if !valid {
            return None;
        }
        fields.push((key, value.clone()));
    }
    Some(fields)
}

/// `updateWorkspaceDocumentMeta`: only the keys the patch holds are written.
pub(super) fn update_meta(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let id = text(args, "documentId")?;
    let patch = field(args, "patch").filter(|patch| entries(patch).is_some());
    let fields = meta_patch(patch.ok_or(Fault::Declined)?).ok_or(ZOD_ERROR)?;
    if let Some(node) = document_node(doc, id) {
        for (key, value) in &fields {
            set_meta(doc, WORKSPACE_TREE_KEY, node, key, value).map_err(|_| LORO)?;
        }
    }
    commit(doc);
    Ok(())
}

/// `pruneEmptyFolders`.
pub(super) fn prune(doc: &LoroDoc, _: &Value, _: f64) -> Step {
    prune_empty_folders(doc).map_err(|_| LORO)
}

/// `reapplyFolderNames`.
pub(super) fn reapply_names(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let Some(Value::Seq(items)) = field(args, "names") else { return Err(Fault::Declined) };
    let names = items
        .iter()
        .map(|item| Ok((text(item, "path")?.to_owned(), text(item, "name")?.to_owned())))
        .collect::<Result<Vec<_>, Fault>>()?;
    reapply_folder_names(doc, &names).map_err(|_| LORO)
}
