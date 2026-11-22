//! Copying a node's meta map into another node, container by container, as
//! the TypeScript's node copy does: a plain value is set and a container is
//! made fresh at its key and filled with what the source holds.

use crate::tree::{ContainerKind, NodeId, kind_of};
use crate::write::{WriteError, refused};
use loro::{
    Container, ContainerTrait, LoroDoc, LoroMap, LoroMovableList, LoroText, ValueOrContainer,
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
            fill_map(&child, source)
        }
        Container::Text(source) => {
            let child = target.insert_container(key, LoroText::new()).map_err(refused)?;
            child.insert(0, &source.to_string()).map_err(refused)
        }
        Container::List(_) | Container::MovableList(_) => {
            let child = target.insert_container(key, LoroMovableList::new()).map_err(refused)?;
            push_all(&child, container)
        }
        _ => Ok(()),
    }
}

/// A sequence's entries as plain values: a container inside one is flattened
/// to the value it holds, which is what a copy of a sequence carries.
fn push_all(child: &LoroMovableList, container: &Container) -> Result<(), WriteError> {
    let held = ValueOrContainer::Container(container.clone());
    let loro::LoroValue::List(items) = held.get_deep_value() else { return Ok(()) };
    for item in items.iter() {
        child.push(item.clone()).map_err(refused)?;
    }
    Ok(())
}

/// Makes `target`'s entries equal `source`'s, entry by entry: a container the
/// source holds is synced into one of the same kind, an equal plain value
/// appends nothing, and a key the source lacks is deleted.
fn fill_map(target: &LoroMap, source: &LoroMap) -> Result<(), WriteError> {
    for key in source.keys() {
        let key = key.to_string();
        match source.get(&key) {
            None => {}
            Some(ValueOrContainer::Value(value)) => {
                if let Some(ValueOrContainer::Container(_)) = target.get(&key) {
                    target.delete(&key).map_err(refused)?;
                }
                target.insert(&key, value).map_err(refused)?;
            }
            Some(ValueOrContainer::Container(container)) => sync_entry(target, &key, &container)?,
        }
    }
    let stale: Vec<String> =
        target.keys().map(|key| key.to_string()).filter(|key| source.get(key).is_none()).collect();
    for key in stale {
        target.delete(&key).map_err(refused)?;
    }
    Ok(())
}

fn sync_entry(target: &LoroMap, key: &str, container: &Container) -> Result<(), WriteError> {
    let Container::Map(source) = container else {
        if target.get(key).is_some() {
            target.delete(key).map_err(refused)?;
        }
        return copy_container(target, key, container);
    };
    match target.get(key) {
        Some(ValueOrContainer::Container(Container::Map(existing))) => fill_map(&existing, source),
        held => {
            if held.is_some() {
                target.delete(key).map_err(refused)?;
            }
            fill_map(&copied_map(target, key)?, source)
        }
    }
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
