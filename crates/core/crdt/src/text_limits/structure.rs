//! What a history leaves standing, judged before anything is measured
//! (`sync-structure-limits.ts`, `container-names.ts`): a write into a
//! container its change never saw created, a `__proto__` key, a container
//! named past the bound a snapshot can carry, and a document node's content
//! key holding anything but its content container.

use super::breach::{BreachShape, TextBreach, count, text};
use super::place::{map_at, place_of, units};
use loro::json::{JsonChange, JsonOp, JsonSchema};
use loro::{
    Container, ContainerID, ContainerTrait, ContainerType, Frontiers, JsonListOp, JsonMapOp,
    JsonMovableListOp, JsonOpContent, JsonTextOp, LoroDoc, LoroValue, ValueOrContainer,
};

/// The longest name a container may carry, in UTF-16 units.
const CONTAINER_NAME_MAX_CHARS: usize = 1024;
/// The key every JSON projection assigns rather than stores.
const RESERVED_MAP_KEY: &str = "__proto__";
const ROOT_PREFIX: &str = "cid:root-";

/// The container `change` writes into without its creation in the change's
/// causal past: its own earlier ops, and what its deps reach.
fn unattached_in(doc: &LoroDoc, change: &JsonChange) -> Option<ContainerID> {
    let peer = change.id.peer;
    let past = doc.frontiers_to_vv(&Frontiers::from(change.deps.clone())).unwrap_or_default();
    change.ops.iter().find_map(|op| {
        let ContainerID::Normal { peer: creator, counter, .. } = op.container else { return None };
        if creator == peer && counter < op.counter {
            return None;
        }
        let reached = past.get(&creator).copied().unwrap_or(0);
        (reached <= counter).then(|| op.container.clone())
    })
}

/// The first write in the history into a container it never saw created.
pub(super) fn unattached_breach(doc: &LoroDoc, json: &JsonSchema) -> Option<TextBreach> {
    json.changes.iter().find_map(|change| unattached_in(doc, change)).map(|container| {
        TextBreach::new(
            BreachShape::UnattachedContainer,
            vec![("container", text(&container.to_string()))],
        )
    })
}

/// Whether a value carries the reserved key where a JavaScript projection
/// keeps it: holding an object, a list or bytes, which becomes the object's
/// prototype. Assigned anything else, the key is dropped and never seen.
fn holds_reserved_key(value: &LoroValue) -> bool {
    match value {
        LoroValue::Map(entries) => entries.iter().any(|(key, held)| {
            if key == RESERVED_MAP_KEY {
                matches!(held, LoroValue::Map(_) | LoroValue::List(_) | LoroValue::Binary(_))
            } else {
                holds_reserved_key(held)
            }
        }),
        LoroValue::List(items) => items.iter().any(holds_reserved_key),
        _ => false,
    }
}

/// Whether `op` writes the reserved key: a map key, a mark's key, a value
/// carrying one, or a root of that name. A delete is how a record is repaired.
fn writes_reserved_key(op: &JsonOp) -> bool {
    let root = matches!(&op.container, ContainerID::Root { name, .. } if name.as_str() == RESERVED_MAP_KEY);
    root || match &op.content {
        JsonOpContent::Map(JsonMapOp::Insert { key, value }) => {
            key == RESERVED_MAP_KEY || holds_reserved_key(value)
        }
        JsonOpContent::List(JsonListOp::Insert { value, .. })
        | JsonOpContent::MovableList(JsonMovableListOp::Insert { value, .. }) => {
            value.iter().any(holds_reserved_key)
        }
        JsonOpContent::MovableList(JsonMovableListOp::Set { value, .. }) => {
            holds_reserved_key(value)
        }
        JsonOpContent::Text(JsonTextOp::Mark { style_key, style_value, .. }) => {
            style_key == RESERVED_MAP_KEY || holds_reserved_key(style_value)
        }
        _ => false,
    }
}

/// The first op in the history writing the reserved key.
pub(super) fn reserved_key_breach(json: &JsonSchema) -> Option<TextBreach> {
    let op =
        json.changes.iter().flat_map(|change| &change.ops).find(|op| writes_reserved_key(op))?;
    Some(TextBreach::new(
        BreachShape::ReservedMapKey,
        vec![("container", text(&op.container.to_string()))],
    ))
}

/// Where a long name may come in: a container written into, or the child a
/// map insert opened at `key`.
pub(super) struct NameSuspect {
    pub container: ContainerID,
    pub key: Option<String>,
}

/// Whether a name of `chars` units is past the bound. The one comparison the
/// history's filter and the state's judgement both make.
const fn name_past(chars: usize) -> bool {
    chars > CONTAINER_NAME_MAX_CHARS
}

/// The length of the name a root container's id carries; 0 for any other.
fn name_length(id: &str) -> usize {
    let Some(rest) = id.strip_prefix(ROOT_PREFIX) else { return 0 };
    rest.rfind(':').map_or(0, |end| units(rest.get(..end).unwrap_or_default()))
}

/// The suspects one op contributes: a child's name is its parent's id
/// rewritten plus its key, so a map insert whose two fit cannot open one past it.
pub(super) fn name_suspects(op: &JsonOp, into: &mut Vec<NameSuspect>) {
    let id = op.container.to_string();
    if name_past(name_length(&id)) {
        into.push(NameSuspect { container: op.container.clone(), key: None });
    }
    if let JsonOpContent::Map(JsonMapOp::Insert { key, .. }) = &op.content
        && name_past(units(&id).saturating_add(units(key)))
    {
        into.push(NameSuspect { container: op.container.clone(), key: Some(key.clone()) });
    }
}

/// The id a suspect names in the state: the container itself, or what the
/// map holds at the key — a child's id, or a plain object's `id` field, which
/// the TypeScript reads the same way.
fn named(doc: &LoroDoc, suspect: &NameSuspect) -> Option<String> {
    let Some(key) = &suspect.key else { return Some(suspect.container.to_string()) };
    match map_at(doc, &suspect.container)?.get(key)? {
        ValueOrContainer::Container(child) => Some(child.id().to_string()),
        ValueOrContainer::Value(LoroValue::Map(entries)) => match entries.get("id") {
            Some(LoroValue::String(id)) => Some(id.to_string()),
            _ => None,
        },
        ValueOrContainer::Value(_) => None,
    }
}

/// The first container the history brought in under a name past the bound.
/// One a peer's op id names carries none, but a content copy names it by its
/// key, so the key's length stands for it.
pub(super) fn long_name_breach(doc: &LoroDoc, suspects: &[NameSuspect]) -> Option<TextBreach> {
    suspects.iter().find_map(|suspect| {
        let id = named(doc, suspect)?;
        let own = name_length(&id);
        let chars = match &suspect.key {
            Some(key) if own == 0 => units(key),
            _ => own,
        };
        name_past(chars).then(|| {
            TextBreach::new(
                BreachShape::ContainerName,
                vec![("chars", count(chars)), ("container", text(&id))],
            )
        })
    })
}

/// The kind each document content key's container is declared as.
pub(super) fn content_kind(key: &str) -> Option<ContainerType> {
    match key {
        "nodes" | "edges" | "lines" | "canvas" | "threads" | "proposals" | "facets"
        | "nodeLocks" | "edgeLocks" | "core" | "trust" | "document" => Some(ContainerType::Map),
        "body" => Some(ContainerType::Text),
        _ => None,
    }
}

fn kind_of(held: Option<ValueOrContainer>) -> Option<ContainerType> {
    match held? {
        ValueOrContainer::Container(container) => Some(container_type(&container)),
        ValueOrContainer::Value(_) => None,
    }
}

fn container_type(container: &Container) -> ContainerType {
    container.id().container_type()
}

/// A tree node's own map left holding, at a content key the history wrote,
/// anything but a container of the declared kind.
pub(super) fn content_root_breach(
    doc: &LoroDoc,
    written: &[(ContainerID, Vec<String>)],
) -> Option<TextBreach> {
    written.iter().find_map(|(container, keys)| {
        let place = place_of(doc, container)?;
        if place.len() != 2 || !place.under_tree() {
            return None;
        }
        let map = map_at(doc, container)?;
        let key = keys.iter().find(|key| kind_of(map.get(key)) != content_kind(key))?;
        Some(TextBreach::new(
            BreachShape::ContentRoot,
            vec![("key", text(key)), ("container", text(&container.to_string()))],
        ))
    })
}
