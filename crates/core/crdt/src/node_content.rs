//! `writeWorkspaceDocumentContent` (`workspace-tree.ts` over `content-sync.ts`):
//! the content of a document hosted on a tree node made equal to a standalone
//! document's, root by root and entry by entry, one loro call for one npm
//! loro-crdt call.
//!
//! The TypeScript walks the source's roots in the order `toJSON` enumerates
//! them, which is the order wasm32's hash map holds them in, and that is not
//! native's. So a write that appends operations under more than one root, in
//! that order, is not answered; one that writes under a root or none appends
//! the same operations in any order. The roots the source lacks are cleared
//! after, in the order the content containers are declared, which is fixed.

use crate::content_sync::{Root, roots_of, sync_entries};
use crate::content_write::splice_minimal;
use crate::copy::NodeAt;
use crate::judgement::CONTENT_KEYS;
use crate::spatial_write::Fault;
use loro::{Container, LoroDoc, LoroMap, LoroText, LoroValue, ValueOrContainer};

/// A stored plane belongs to the record, not the document.
const STORED_PLANE_KEY_PREFIX: &str = "plane:";

/// The one content container held as text; the rest are maps.
const BODY: &str = "body";

fn declined<E>(_: E) -> Fault {
    Fault::Declined
}

/// Whether the node's map holds, at `key`, nothing or a container `root`'s
/// projection matches (`rootFitsNode`): never a key the node keeps for itself.
fn root_fits(meta: &LoroMap, key: &str, root: &Root, reserved: &[&str]) -> bool {
    if reserved.contains(&key) {
        return false;
    }
    match meta.get(key) {
        None => true,
        Some(ValueOrContainer::Value(_)) => false,
        Some(ValueOrContainer::Container(held)) => matches!(
            (root, &held),
            (Root::Text(_), Container::Text(_)) | (Root::Map, Container::Map(_))
        ),
    }
}

/// Whether the node's map holds, at a content key, nothing or the container it
/// is declared as (`holdsDeclaredContent`).
fn holds_declared(meta: &LoroMap, key: &str) -> bool {
    match meta.get(key) {
        Some(ValueOrContainer::Container(held)) => {
            matches!((key == BODY, &held), (true, Container::Text(_)) | (false, Container::Map(_)))
        }
        Some(ValueOrContainer::Value(_)) => false,
        None => true,
    }
}

/// The text at `key`, made with an op-created id when absent, as
/// `getOrCreateContainer` makes one; a key holding anything else was refused
/// before this is asked.
fn text_at(meta: &LoroMap, key: &str) -> Result<LoroText, Fault> {
    match meta.get(key) {
        None => meta.insert_container(key, LoroText::new()).map_err(declined),
        Some(ValueOrContainer::Container(Container::Text(text))) => Ok(text),
        Some(_) => Err(Fault::Declined),
    }
}

/// The map at `key`, made as [`text_at`] makes a text.
fn map_at(meta: &LoroMap, key: &str) -> Result<LoroMap, Fault> {
    match meta.get(key) {
        None => meta.insert_container(key, LoroMap::new()).map_err(declined),
        Some(ValueOrContainer::Container(Container::Map(map))) => Ok(map),
        Some(_) => Err(Fault::Declined),
    }
}

/// `syncRootContainer` onto the node: whether the root changed.
fn sync_root(meta: &LoroMap, source: &LoroDoc, key: &str, root: &Root) -> Result<bool, Fault> {
    match root {
        Root::Text(wanted) => {
            let target = text_at(meta, key)?;
            let changed = target.to_string() != *wanted;
            splice_minimal(&target, wanted)?;
            Ok(changed)
        }
        Root::Map => sync_entries(&map_at(meta, key)?, &source.get_map(key)),
    }
}

/// `clearRootContainer` onto the node, opening the container when absent:
/// whether it held anything.
fn clear_root(meta: &LoroMap, key: &str) -> Result<bool, Fault> {
    if key == BODY {
        let text = text_at(meta, key)?;
        let length = text.len_utf16();
        text.delete_utf16(0, length).map_err(declined)?;
        return Ok(length > 0);
    }
    let map = map_at(meta, key)?;
    let keys: Vec<String> = map.keys().map(|k| k.to_string()).collect();
    for entry in &keys {
        map.delete(entry).map_err(declined)?;
    }
    Ok(!keys.is_empty())
}

/// The keys the source's deep value holds, a scalar root's among them.
fn projected_keys(source: &LoroDoc) -> Vec<String> {
    match source.get_deep_value() {
        LoroValue::Map(roots) => roots.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Makes the content of the document `at` hosts equal `source`'s: every root
/// the node may hold synced, then every content container the source lacks
/// cleared. Nothing is committed. Answers whether the content changed, which
/// is what a stamp of the edit rides; opening an empty container is no change.
/// `reserved` names the keys the node keeps for itself.
pub fn sync_node_content(
    at: NodeAt<'_>,
    source: &LoroDoc,
    reserved: &[&str],
) -> Result<bool, Fault> {
    let meta = at.doc.get_tree(at.tree).get_meta(at.node.0).map_err(declined)?;
    let mut changed = false;
    let mut written = 0_usize;
    for (key, root) in &roots_of(source)? {
        if key.starts_with(STORED_PLANE_KEY_PREFIX) || !root_fits(&meta, key, root, reserved) {
            continue;
        }
        let before = at.doc.get_pending_txn_len();
        changed |= sync_root(&meta, source, key, root)?;
        written = written.saturating_add(usize::from(at.doc.get_pending_txn_len() != before));
        if written > 1 {
            return Err(Fault::Declined);
        }
    }
    let projected = projected_keys(source);
    for key in CONTENT_KEYS {
        if projected.iter().any(|held| held == key) || !holds_declared(&meta, key) {
            continue;
        }
        changed |= clear_root(&meta, key)?;
    }
    Ok(changed)
}
