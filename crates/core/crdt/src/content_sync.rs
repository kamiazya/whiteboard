//! `reconcileDocContent` (`workspace-tree.ts` over `content-sync.ts`): a live
//! document's content made equal to a past one's as a new edit, root by root
//! and entry by entry, one loro call for one npm loro-crdt call.
//!
//! The TypeScript walks the roots in the order `toJSON` enumerates them, which
//! is the order wasm32's hash map holds them in, and that is not native's. So
//! a write that changes more than one root, whose operations land in that
//! order, is not answered; one that changes a root or none appends the same
//! operations in any order. Nor is a document holding a sequence root, which
//! no writer of the document model makes: the TypeScript would carry it over
//! by value as a movable list, through a projection that cannot tell a list
//! from a tree.

use crate::annotation_write::put;
use crate::content_write::splice_minimal;
use crate::copy::copied_map;
use crate::proposal_write::as_js;
use crate::spatial_write::{Fault, Step};
use loro::{Container, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroValue, ValueOrContainer};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_model::enumeration_order;

/// A root as `projectedKind` reads its projection: a text, or a map.
pub(crate) enum Root {
    Text(String),
    Map,
}

/// The roots a document projects, in the order its deep value holds them; a
/// scalar projection (a counter) is no root a sync reaches.
pub(crate) fn roots_of(doc: &LoroDoc) -> Result<Vec<(String, Root)>, Fault> {
    let LoroValue::Map(roots) = doc.get_deep_value() else { return Err(Fault::Declined) };
    let mut found = Vec::new();
    for (key, value) in roots.iter() {
        let root = match value {
            _ if key == "__proto__" => return Err(Fault::Declined),
            LoroValue::String(text) => Root::Text(text.to_string()),
            LoroValue::Map(_) => Root::Map,
            LoroValue::List(_) | LoroValue::Binary(_) | LoroValue::Container(_) => {
                return Err(Fault::Declined);
            }
            _ => continue,
        };
        found.push((key.clone(), root));
    }
    Ok(found)
}

/// `Object.is` over two numbers as JavaScript holds them.
fn same_number(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

/// A number as JavaScript holds it.
fn number(value: &LoroValue) -> Option<f64> {
    match value {
        #[expect(
            clippy::cast_precision_loss,
            reason = "npm loro-crdt hands every i64 to JavaScript as a number, so equality is asked of the rounded one"
        )]
        LoroValue::I64(n) => Some(*n as f64),
        LoroValue::Double(d) => Some(*d),
        _ => None,
    }
}

/// `jsonEqual` over two plain values as npm loro-crdt hands them over. Bytes
/// reach JavaScript as a typed array, compared there by index, and are not
/// answered.
pub(crate) fn json_equal(a: &LoroValue, b: &LoroValue) -> Result<bool, Fault> {
    if let (Some(x), Some(y)) = (number(a), number(b)) {
        return Ok(same_number(x, y));
    }
    Ok(match (a, b) {
        (LoroValue::Binary(_) | LoroValue::Container(_), _)
        | (_, LoroValue::Binary(_) | LoroValue::Container(_)) => return Err(Fault::Declined),
        (LoroValue::List(x), LoroValue::List(y)) => {
            x.len() == y.len() && all_equal(x.iter().zip(y.iter()))?
        }
        (LoroValue::Map(x), LoroValue::Map(y)) => {
            if x.contains_key("__proto__") || y.contains_key("__proto__") {
                return Err(Fault::Declined);
            }
            let pairs = x.iter().map(|(k, v)| (v, y.get(k)));
            x.len() == y.len()
                && pairs.clone().all(|(_, held)| held.is_some())
                && all_equal(pairs.filter_map(|(v, held)| Some((v, held?))))?
        }
        _ => a == b,
    })
}

fn all_equal<'a>(
    mut pairs: impl Iterator<Item = (&'a LoroValue, &'a LoroValue)>,
) -> Result<bool, Fault> {
    pairs.try_fold(true, |all, (x, y)| Ok(all && json_equal(x, y)?))
}

fn put_value(target: &LoroMap, key: &str, wanted: &LoroValue) -> Step {
    put(target, key, &as_js(wanted).ok_or(Fault::Declined)?)
}

fn delete(target: &LoroMap, key: &str) -> Step {
    target.delete(key).map_err(|_| Fault::Declined)
}

/// One plain value of `syncMapEntry`: a map standing at the key is replaced,
/// another container is written over, and an equal value appends nothing.
fn sync_value(target: &LoroMap, key: &str, wanted: &LoroValue) -> Result<bool, Fault> {
    match target.get(key) {
        Some(ValueOrContainer::Container(Container::Map(_))) => delete(target, key)?,
        Some(ValueOrContainer::Container(_)) => {
            // `jsonEqual` would read a container handle's own keys against an object.
            if matches!(wanted, LoroValue::Map(_) | LoroValue::List(_) | LoroValue::Binary(_)) {
                return Err(Fault::Declined);
            }
        }
        Some(ValueOrContainer::Value(held)) if json_equal(&held, wanted)? => return Ok(false),
        _ => {}
    }
    put_value(target, key, wanted)?;
    Ok(true)
}

/// `recreateSequence`: a text or a list made fresh at the key, whatever stood there.
fn recreate(target: &LoroMap, key: &str, wanted: &Container) -> Result<bool, Fault> {
    if target.get(key).is_some() {
        delete(target, key)?;
    }
    if let Container::Text(text) = wanted {
        let fresh = target.insert_container(key, LoroText::new()).map_err(|_| Fault::Declined)?;
        fresh.insert(0, &text.to_string()).map_err(|_| Fault::Declined)?;
        return Ok(true);
    }
    let held = ValueOrContainer::Container(wanted.clone()).get_deep_value();
    let LoroValue::List(entries) = held else { return Err(Fault::Declined) };
    let fresh =
        target.insert_container(key, LoroMovableList::new()).map_err(|_| Fault::Declined)?;
    for entry in entries.iter() {
        let entry = as_js(entry).map(enumeration_order).ok_or(Fault::Declined)?;
        if crate::spatial_write::holds_reserved_key(&entry) {
            return Err(Fault::Declined);
        }
        let entry = crate::write::plain(&entry).map_err(|_| Fault::Declined)?;
        fresh.push(entry).map_err(|_| Fault::Declined)?;
    }
    Ok(true)
}

/// `syncNestedMap`: a map synced into the one standing at the key, or into a
/// mergeable one opened in place of whatever stood there.
fn sync_nested(target: &LoroMap, key: &str, wanted: &LoroMap) -> Result<bool, Fault> {
    match target.get(key) {
        Some(ValueOrContainer::Container(Container::Map(existing))) => {
            sync_entries(&existing, wanted)
        }
        held => {
            if held.is_some() {
                delete(target, key)?;
            }
            sync_entries(&copied_map(target, key).map_err(|_| Fault::Declined)?, wanted)?;
            Ok(true)
        }
    }
}

/// `syncMapEntry`: `target[key]` made equal to what the source holds there.
fn sync_entry(target: &LoroMap, key: &str, wanted: ValueOrContainer) -> Result<bool, Fault> {
    match wanted {
        ValueOrContainer::Value(value) => sync_value(target, key, &value),
        ValueOrContainer::Container(Container::Map(map)) => sync_nested(target, key, &map),
        ValueOrContainer::Container(
            held @ (Container::Text(_) | Container::List(_) | Container::MovableList(_)),
        ) => recreate(target, key, &held),
        ValueOrContainer::Container(_) => Err(Fault::Declined),
    }
}

/// `syncMapEntries`: every source entry synced, then every key the source
/// lacks deleted; whether anything changed.
pub(crate) fn sync_entries(target: &LoroMap, source: &LoroMap) -> Result<bool, Fault> {
    let mut changed = false;
    for key in source.keys() {
        if let Some(wanted) = source.get(&key) {
            changed |= sync_entry(target, &key, wanted)?;
        }
    }
    let held: Vec<String> = target.keys().map(|key| key.to_string()).collect();
    for key in held.iter().filter(|key| source.get(key).is_none()) {
        delete(target, key)?;
        changed = true;
    }
    Ok(changed)
}

/// `syncRootContainer`: a text spliced at its one differing span, a map synced
/// entry by entry.
fn sync_root(doc: &LoroDoc, source: &LoroDoc, key: &str, root: &Root) -> Result<bool, Fault> {
    match root {
        Root::Text(wanted) => {
            let target = doc.get_text(key);
            let changed = target.to_string() != *wanted;
            splice_minimal(&target, wanted)?;
            Ok(changed)
        }
        Root::Map => sync_entries(&doc.get_map(key), &source.get_map(key)),
    }
}

/// `clearRootContainer`: a root the past lacks emptied; whether it held anything.
fn clear_root(doc: &LoroDoc, key: &str, root: &Root) -> Result<bool, Fault> {
    match root {
        Root::Map => {
            let map = doc.get_map(key);
            let keys: Vec<String> = map.keys().map(|k| k.to_string()).collect();
            for entry in &keys {
                delete(&map, entry)?;
            }
            Ok(!keys.is_empty())
        }
        Root::Text(_) => {
            let text = doc.get_text(key);
            let length = text.len_utf16();
            // A delete of nothing is no operation in loro, as the TypeScript's
            // guard around it makes it.
            text.delete_utf16(0, length).map_err(|_| Fault::Declined)?;
            Ok(length > 0)
        }
    }
}

/// `reconcileDocContent`: the content of the document `past` holds, as base64
/// snapshot or update bytes, written over this one in one commit.
pub(crate) fn reconcile_doc_content(doc: &LoroDoc, past: &str) -> Step {
    let bytes = base64_to_bytes(past).ok_or(Fault::Declined)?;
    let source = crate::import_bytes(&bytes).map_err(|_| Fault::Declined)?;
    let (wanted, current) = (roots_of(&source)?, roots_of(doc)?);
    let mut changed = 0_usize;
    for (key, root) in &wanted {
        changed = changed.saturating_add(usize::from(sync_root(doc, &source, key, root)?));
    }
    for (key, root) in &current {
        if !wanted.iter().any(|(held, _)| held == key) {
            changed = changed.saturating_add(usize::from(clear_root(doc, key, root)?));
        }
    }
    if changed > 1 {
        return Err(Fault::Declined);
    }
    doc.commit();
    Ok(())
}
