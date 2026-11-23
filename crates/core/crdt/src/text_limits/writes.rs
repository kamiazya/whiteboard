//! What a history's operations write, read off its JSON form once: the
//! places every bound is later judged at, in the order the ops first reached
//! each, which decides the breach a history past two bounds is named by.

use super::retired::Suspect;
use super::structure::{NameSuspect, content_kind, name_suspects};
use super::values::{BOUNDS, LongValue, length};
use loro::json::{JsonOp, JsonSchema};
use loro::{ContainerID, JsonListOp, JsonMapOp, JsonMovableListOp, JsonOpContent, JsonTextOp};
use std::collections::{BTreeMap, BTreeSet};

/// Entries keyed by container, in the order each container was first written.
pub(super) struct Ordered<V> {
    at: BTreeMap<String, usize>,
    pub entries: Vec<(ContainerID, V)>,
}

impl<V: Default> Ordered<V> {
    const fn new() -> Self {
        Self { at: BTreeMap::new(), entries: Vec::new() }
    }

    fn entry(&mut self, id: &ContainerID) -> Option<&mut V> {
        let key = id.to_string();
        let at = if let Some(&at) = self.at.get(&key) {
            at
        } else {
            let at = self.entries.len();
            self.entries.push((id.clone(), V::default()));
            self.at.insert(key, at);
            at
        };
        self.entries.get_mut(at).map(|(_, held)| held)
    }

    /// The containers, in first-written order.
    pub(super) fn ids(&self) -> Vec<ContainerID> {
        self.entries.iter().map(|(id, _)| id.clone()).collect()
    }
}

/// What the history's ops write.
pub(super) struct Writes {
    /// Characters inserted minus characters deleted, per text container.
    pub net: Ordered<i64>,
    /// Map entries set to a value past a bound, once per entry and bound.
    pub long_values: Vec<LongValue>,
    /// Where a container named past its bound may have come in.
    pub names: Vec<NameSuspect>,
    /// Every map a key was set in.
    pub set_into: Ordered<()>,
    /// Every map a key was set or deleted in.
    pub maps_written: Ordered<()>,
    /// The document content keys set or deleted, by map.
    pub content_keys: Ordered<Vec<String>>,
    /// Every place an op inserted into, once each.
    pub inserted: Vec<Suspect>,
}

/// Reads every op of `json`.
pub(super) fn read_writes(json: &JsonSchema) -> Writes {
    let mut writes = Writes {
        net: Ordered::new(),
        long_values: Vec::new(),
        names: Vec::new(),
        set_into: Ordered::new(),
        maps_written: Ordered::new(),
        content_keys: Ordered::new(),
        inserted: Vec::new(),
    };
    let mut long_seen = BTreeSet::new();
    let mut inserted_seen = BTreeSet::new();
    for op in json.changes.iter().flat_map(|change| &change.ops) {
        name_suspects(op, &mut writes.names);
        match &op.content {
            JsonOpContent::Map(map_op) => read_map_write(&mut writes, &mut long_seen, op, map_op),
            JsonOpContent::Text(text_op) => read_text_write(&mut writes, op, text_op),
            _ => {}
        }
        if let Some(suspect) = inserted_at(op)
            && inserted_seen.insert((op.container.to_string(), suspect.key.clone()))
        {
            writes.inserted.push(suspect);
        }
    }
    writes
}

/// A map write: the maps it reached, the content key it names, and a value
/// long enough to break a bound where that bound applies.
fn read_map_write(
    writes: &mut Writes,
    seen: &mut BTreeSet<(String, String, usize)>,
    op: &JsonOp,
    map_op: &JsonMapOp,
) {
    let key = match map_op {
        JsonMapOp::Insert { key, .. } | JsonMapOp::Delete { key } => key,
    };
    writes.maps_written.entry(&op.container);
    if content_kind(key).is_some()
        && let Some(keys) = writes.content_keys.entry(&op.container)
        && !keys.contains(key)
    {
        keys.push(key.clone());
    }
    let JsonMapOp::Insert { value, .. } = map_op else { return };
    writes.set_into.entry(&op.container);
    for (index, (measure, max)) in BOUNDS.into_iter().enumerate() {
        if length(measure, value) > max
            && seen.insert((op.container.to_string(), key.clone(), index))
        {
            writes.long_values.push(LongValue {
                container: op.container.clone(),
                key: key.clone(),
                measure,
                max,
            });
        }
    }
}

/// An insert grows its text container by its characters; a delete shrinks it.
fn read_text_write(writes: &mut Writes, op: &JsonOp, text_op: &JsonTextOp) {
    let by = match text_op {
        JsonTextOp::Insert { text, .. } => i64::try_from(text.chars().count()).unwrap_or(i64::MAX),
        JsonTextOp::Delete { len, .. } => 0_i64.saturating_sub(i64::from(len.unsigned_abs())),
        _ => return,
    };
    if let Some(net) = writes.net.entry(&op.container) {
        *net = net.saturating_add(by);
    }
}

/// The place an insert writes at — a map key, or (`key: None`) a list —
/// `None` for anything that is not an insert into a map or a list.
fn inserted_at(op: &JsonOp) -> Option<Suspect> {
    let key = match &op.content {
        JsonOpContent::Map(JsonMapOp::Insert { key, .. }) => Some(key.clone()),
        JsonOpContent::List(JsonListOp::Insert { .. })
        | JsonOpContent::MovableList(JsonMovableListOp::Insert { .. }) => None,
        _ => return None,
    };
    Some(Suspect { container: op.container.clone(), key })
}
