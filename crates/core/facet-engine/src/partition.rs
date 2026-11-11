//! A facets bucket judged for a write, and a workspace's stencil library
//! composed beside the registry: the Rust counterpart of the server's
//! `partitionFacetWrites` and `composeWorkspaceStencils`, which every agent
//! write path asks the same question through.
//!
//! The bucket is judged key by key in the order it holds them and the first
//! refusal wins, so which refusal a caller reads does not depend on how many
//! keys it sent. A null payload deletes its key and is judged by nothing.

use std::collections::BTreeMap;

use whiteboard_model::Value;

use crate::plugin_manifest::{AssetKind, FacetTarget};
use crate::registry::{Registry, StencilRefusal, WORKSPACE_PLUGIN_ID, WriteRefusal};

/// What a bucket stores once judged: the payloads as their schemas parsed
/// them, in the bucket's order, and the keys it deletes.
#[derive(Debug, Clone, PartialEq)]
pub struct Writes {
    pub sets: Vec<(String, Value)>,
    pub deletions: Vec<String>,
}

/// Where a payload lost a key its sender wrote: the path of keys and indices
/// down to the object that held it, and the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stray {
    pub path: Vec<String>,
    pub key: String,
}

/// Why a key of a bucket is refused.
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    /// The facet does not attach to what the write targets; the targets it does.
    Target(Vec<FacetTarget>),
    /// The registry refuses the write.
    Write(WriteRefusal),
    /// The payload names a key its facet's schema does not keep.
    Unrecognized(Stray),
}

/// The first key a bucket is refused at, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub key: String,
    pub why: Refusal,
}

/// Splits `bucket` into validated sets and deletions for a write that
/// targets `target`, over the registry's own assets and the `extra` ones the
/// caller holds for this write.
///
/// A registered facet's payload must satisfy its schema, its key must be the
/// current version and its targets must include `target`; a key no plugin
/// registered passes as sent. A payload the schema stripped a key from is
/// refused rather than stored as the stripped remainder, so a caller reads
/// success as "stored as I sent it".
///
/// # Errors
///
/// The first key, in the bucket's order, the write is refused at, and the stage
/// that refused it: the facet's targets, the registry's own write check, and
/// last a key the schema strips.
pub fn partition(
    registry: &Registry,
    extra: &[(AssetKind, &[String])],
    target: FacetTarget,
    bucket: &[(String, Value)],
) -> Result<Writes, Refused> {
    let mut writes = Writes { sets: Vec::new(), deletions: Vec::new() };
    for (key, payload) in bucket {
        if *payload == Value::Null {
            writes.deletions.push(key.clone());
            continue;
        }
        let refused = |why| Refused { key: key.clone(), why };
        if let Some(targets) = registry.targets_of(key).filter(|held| !held.contains(&target)) {
            return Err(refused(Refusal::Target(targets.to_vec())));
        }
        let stored = registry
            .validate_facet_write_with(key, payload, extra)
            .map_err(|why| refused(Refusal::Write(why)))?;
        if let Some(stray) = first_unrecognized_key(payload, &stored) {
            return Err(refused(Refusal::Unrecognized(stray)));
        }
        writes.sets.push((key.clone(), stored));
    }
    Ok(writes)
}

/// The names `Object.prototype` holds, which a JavaScript `key in parsed`
/// finds in any plain object: a payload key spelt like one is never reported
/// as stripped, whatever the schema kept. `__proto__` is among them and is
/// refused before a payload is judged, so it never reaches here.
const OBJECT_PROTOTYPE: [&str; 12] = [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// Where `parsed` lost a key of `sent`, walking both together: the first key,
/// in `sent`'s order, that `parsed` does not hold, a list index at a time. A
/// schema that keeps every key (a catch-all record) is never reported.
#[must_use]
pub fn first_unrecognized_key(sent: &Value, parsed: &Value) -> Option<Stray> {
    find_stray(sent, parsed, &mut Vec::new())
}

fn find_stray(sent: &Value, parsed: &Value, path: &mut Vec<String>) -> Option<Stray> {
    match (sent, parsed) {
        (Value::Seq(items), Value::Seq(kept)) => {
            items.iter().enumerate().find_map(|(index, item)| {
                // Past the end of what was kept there is nothing to compare with.
                let counterpart = kept.get(index)?;
                path.push(index.to_string());
                let found = find_stray(item, counterpart, path);
                path.pop();
                found
            })
        }
        (Value::Map(entries), Value::Map(kept)) => {
            let held: BTreeMap<&str, &Value> =
                kept.iter().map(|(key, item)| (key.as_str(), item)).collect();
            entries.iter().find_map(|(key, item)| match held.get(key.as_str()) {
                Some(counterpart) => {
                    path.push(key.clone());
                    let found = find_stray(item, counterpart, path);
                    path.pop();
                    found
                }
                None if OBJECT_PROTOTYPE.contains(&key.as_str()) => None,
                None => Some(Stray { path: path.clone(), key: key.clone() }),
            })
        }
        _ => None,
    }
}

/// A workspace's library composed over a registry: the ids of the stencils
/// kept, and each stencil dropped with its refusal.
#[derive(Debug, Clone, PartialEq)]
pub struct Composition {
    /// `workspace.<name>` for each stencil the registry accepts, in the library's order.
    pub kept: Vec<String>,
    pub dropped: Vec<(String, StencilRefusal)>,
}

/// Judges each stencil of `library` (bare names) on its own, so one refused
/// entry takes none of the others with it.
#[must_use]
pub fn compose_library(registry: &Registry, library: &[(String, Value)]) -> Composition {
    let mut composition = Composition { kept: Vec::new(), dropped: Vec::new() };
    for (name, stencil) in library {
        match registry.judge_workspace_stencil(name, stencil) {
            Ok(()) => composition.kept.push(format!("{WORKSPACE_PLUGIN_ID}.{name}")),
            Err(why) => composition.dropped.push((name.clone(), why)),
        }
    }
    composition
}
