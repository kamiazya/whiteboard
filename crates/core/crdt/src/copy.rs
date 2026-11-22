//! Copying a node's meta map into another node, container by container, as
//! the TypeScript's node copy does: a plain value is set and a container is
//! made fresh at its key and filled with what the source holds.

use crate::tree::{ContainerKind, Entry, NodeId, Tree, kind_of};
use crate::write::{WriteError, refused};
use loro::{
    Container, ContainerTrait, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroValue,
    ValueOrContainer,
};
use whiteboard_det::utf16;

/// The longest a mergeable child container's name may be (`CONTAINER_NAME_MAX_CHARS`):
/// its parent's id and its key together, in UTF-16 units. A child that would
/// pass it is made with an op-created id instead.
const CONTAINER_NAME_MAX_CHARS: usize = 1024;

/// A node of a tree container.
#[derive(Clone, Copy)]
pub struct NodeAt<'a> {
    pub doc: &'a LoroDoc,
    pub tree: &'a str,
    pub node: NodeId,
}

impl NodeAt<'_> {
    /// The entry of the node's meta map at `key`. The node is one the tree
    /// holds, so the tree is registered and asking for it writes nothing.
    #[must_use]
    pub fn entry(&self, key: &str) -> Option<Entry> {
        Tree(self.doc.get_tree(self.tree)).entry(self.node, key)
    }
}

fn meta(at: NodeAt<'_>) -> Result<LoroMap, WriteError> {
    at.doc.get_tree(at.tree).get_meta(at.node.0).map_err(refused)
}

/// Copies every entry of `from`'s meta map that `wanted` admits into `to`'s.
/// `wanted` is told the key and, for a container, its kind; a container lands
/// as a fresh one at its key, replacing whatever stood there.
pub fn copy_meta(
    from: NodeAt<'_>,
    to: NodeAt<'_>,
    wanted: &dyn Fn(&str, Option<ContainerKind>) -> bool,
) -> Result<(), WriteError> {
    let (source, target) = (meta(from)?, meta(to)?);
    let mut keys: Vec<String> = source.keys().map(|key| key.to_string()).collect();
    keys.sort();
    for key in keys {
        match source.get(&key) {
            Some(ValueOrContainer::Value(value)) => {
                if wanted(&key, None) {
                    target.insert(&key, value).map_err(refused)?;
                }
            }
            Some(ValueOrContainer::Container(container))
                if wanted(&key, Some(kind_of(&container))) =>
            {
                copy_container(&target, &key, &container)?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// A container made fresh at `key` of `target`, holding what `container` holds.
fn copy_container(target: &LoroMap, key: &str, container: &Container) -> Result<(), WriteError> {
    match container {
        Container::Map(source) => {
            let child = target.insert_container(key, LoroMap::new()).map_err(refused)?;
            fill_map(&child, source).map(|_| ())
        }
        Container::Text(source) => {
            let child = target.insert_container(key, LoroText::new()).map_err(refused)?;
            child.insert(0, &source.to_string()).map_err(refused)
        }
        Container::List(_) | Container::MovableList(_) => {
            let child = target.insert_container(key, LoroMovableList::new()).map_err(refused)?;
            push_all(&child, container)
        }
        // A kind nothing writes (a tree, a counter) is dropped rather than half-copied,
        // as the TypeScript's copy drops it: a wrong copy is worse than a visible gap.
        _ => Ok(()),
    }
}

/// A sequence's entries as plain values: a container inside one is flattened
/// to the value it holds, which is what a copy of a sequence carries.
fn push_all(child: &LoroMovableList, container: &Container) -> Result<(), WriteError> {
    let held = ValueOrContainer::Container(container.clone());
    let LoroValue::List(items) = held.get_deep_value() else { return Ok(()) };
    for item in items.iter() {
        child.push(item.clone()).map_err(refused)?;
    }
    Ok(())
}

/// Makes `target`'s entries equal `source`'s, entry by entry, and says whether
/// anything changed: a container the source holds is synced into one of the same
/// kind, an equal plain value appends nothing, and a key the source lacks is
/// deleted.
fn fill_map(target: &LoroMap, source: &LoroMap) -> Result<bool, WriteError> {
    let mut changed = false;
    for key in source.keys() {
        let key = key.to_string();
        changed |= match source.get(&key) {
            Some(ValueOrContainer::Value(value)) => set_plain(target, &key, value)?,
            Some(ValueOrContainer::Container(container)) => sync_entry(target, &key, &container)?,
            None => false,
        };
    }
    let stale: Vec<String> =
        target.keys().map(|key| key.to_string()).filter(|key| source.get(key).is_none()).collect();
    for key in &stale {
        target.delete(key).map_err(refused)?;
    }
    Ok(changed || !stale.is_empty())
}

/// A plain value at `key`, replacing a container that stands there; `false`
/// when the key already holds an equal one.
fn set_plain(target: &LoroMap, key: &str, value: LoroValue) -> Result<bool, WriteError> {
    match target.get(key) {
        Some(ValueOrContainer::Value(held)) if held == value => return Ok(false),
        Some(ValueOrContainer::Container(_)) => target.delete(key).map_err(refused)?,
        _ => {}
    }
    target.insert(key, value).map_err(refused)?;
    Ok(true)
}

/// A nested text or list is recreated whole, never diffed: there is no cheaper
/// equality for a container than the rewrite, and the TypeScript rewrites it too.
fn sync_entry(target: &LoroMap, key: &str, container: &Container) -> Result<bool, WriteError> {
    let Container::Map(source) = container else {
        if target.get(key).is_some() {
            target.delete(key).map_err(refused)?;
        }
        copy_container(target, key, container)?;
        return Ok(true);
    };
    match target.get(key) {
        Some(ValueOrContainer::Container(Container::Map(existing))) => fill_map(&existing, source),
        held => {
            if held.is_some() {
                target.delete(key).map_err(refused)?;
            }
            fill_map(&copied_map(target, key)?, source)?;
            Ok(true)
        }
    }
}

/// Fills the containers `to` holds, opening each it lacks, with what `from`
/// holds at the same keys, for each container `wanted` admits; a key `to` holds
/// as another kind is left alone. The containers `to` holds are taken to be
/// empty, as a node's are when it has just been created. Says whether anything
/// was written.
pub fn fill_meta(
    from: NodeAt<'_>,
    to: NodeAt<'_>,
    wanted: &dyn Fn(&str, ContainerKind) -> bool,
) -> Result<bool, WriteError> {
    let (source, target) = (meta(from)?, meta(to)?);
    let mut keys: Vec<String> = source.keys().map(|key| key.to_string()).collect();
    keys.sort();
    let mut changed = false;
    for key in keys {
        let Some(ValueOrContainer::Container(held)) = source.get(&key) else { continue };
        if wanted(&key, kind_of(&held)) {
            changed |= fill_container(&target, &key, &held)?;
        }
    }
    Ok(changed)
}

/// A container opened for the copy is no change by itself, only what it is filled
/// with: the TypeScript's sync counts the entries it writes, and `updatedAt` rides that.
fn fill_container(target: &LoroMap, key: &str, held: &Container) -> Result<bool, WriteError> {
    match (held, target.get(key)) {
        (Container::Map(source), Some(ValueOrContainer::Container(Container::Map(into)))) => {
            fill_map(&into, source)
        }
        (Container::Map(source), None) => {
            fill_map(&target.insert_container(key, LoroMap::new()).map_err(refused)?, source)
        }
        (Container::Text(source), Some(ValueOrContainer::Container(Container::Text(into)))) => {
            fill_text(&into, source)
        }
        (Container::Text(source), None) => {
            fill_text(&target.insert_container(key, LoroText::new()).map_err(refused)?, source)
        }
        (
            Container::List(_) | Container::MovableList(_),
            Some(ValueOrContainer::Container(Container::MovableList(into))),
        ) => fill_list(&into, held),
        (Container::List(_) | Container::MovableList(_), None) => {
            fill_list(&target.insert_container(key, LoroMovableList::new()).map_err(refused)?, held)
        }
        _ => Ok(false),
    }
}

/// Makes `into` hold the entries `source` holds, rewriting it only when they differ.
fn fill_list(into: &LoroMovableList, source: &Container) -> Result<bool, WriteError> {
    let held = ValueOrContainer::Container(source.clone());
    let LoroValue::List(wanted) = held.get_deep_value() else { return Ok(false) };
    if into.get_deep_value() == LoroValue::List(wanted.clone()) {
        return Ok(false);
    }
    into.clear().map_err(refused)?;
    push_all(into, source)?;
    Ok(true)
}

/// Makes `into` read as `source` does, rewriting it only when it differs.
fn fill_text(into: &LoroText, source: &LoroText) -> Result<bool, WriteError> {
    let wanted = source.to_string();
    if into.to_string() == wanted {
        return Ok(false);
    }
    into.delete(0, into.len_unicode()).map_err(refused)?;
    into.insert(0, &wanted).map_err(refused)?;
    Ok(true)
}

/// The child map a copy opens at `key`: mergeable, so two peers creating one
/// thread at once converge, unless its name would pass the bound.
fn copied_map(target: &LoroMap, key: &str) -> Result<LoroMap, WriteError> {
    let name_chars = utf16::len(&target.id().to_string()).saturating_add(utf16::len(key));
    if name_chars > CONTAINER_NAME_MAX_CHARS {
        target.insert_container(key, LoroMap::new()).map_err(refused)
    } else {
        target.ensure_mergeable_map(key).map_err(refused)
    }
}
