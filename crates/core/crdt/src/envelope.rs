//! The document's envelope facets as the reader hands them back: the OKF core
//! family and the trust family, each stored one field to a map key so two
//! peers writing different fields both survive a merge.
//!
//! A field the schema refuses is dropped and the rest read; what is left is
//! no facets at all when no field survives, or, for the core family, when
//! `type` (the one required field) did not.

use crate::content::{DocumentKind, document_kind, map_of, value_of};
use crate::plain::{Undecided, plain};
use loro::{LoroDoc, LoroValue};
use whiteboard_model::Value;
use whiteboard_model::checks::{RESERVED_ROOT_KEYS, okf_actor, okf_timestamp};

const CORE_KEY: &str = "core";
const TRUST_KEY: &str = "trust";

/// The core fields the schema accepted, `title` never among them: a
/// document's name lives in the workspace.
pub(crate) struct Core {
    fields: Vec<(String, LoroValue)>,
}

fn is_text(value: &LoroValue) -> bool {
    matches!(value, LoroValue::String(_))
}

fn core_field_valid(key: &str, value: &LoroValue) -> Option<bool> {
    Some(match key {
        "type" => matches!(value, LoroValue::String(t) if !t.is_empty()),
        "description" | "resource" | "view" => is_text(value),
        "tags" => matches!(value, LoroValue::List(items) if items.iter().all(is_text)),
        "facetsRaw" => {
            matches!(value, LoroValue::Map(raw) if raw.iter().all(|(k, _)| !RESERVED_ROOT_KEYS.contains(&k.as_str())))
        }
        _ => return None,
    })
}

/// The stored core facets, or `None` for a spatial document, no stored field
/// and a stored set with no valid `type`.
pub(crate) fn core_facets(doc: &LoroDoc) -> Option<Core> {
    if document_kind(doc) == Some(DocumentKind::Spatial) {
        return None;
    }
    let map = map_of(doc, CORE_KEY);
    let mut fields = Vec::new();
    for key in map.keys() {
        let Some(value) = map.get(&key).and_then(value_of) else { continue };
        if core_field_valid(&key, &value) == Some(true) {
            fields.push((key.to_string(), value));
        }
    }
    fields.iter().any(|(key, _)| key == "type").then_some(Core { fields })
}

impl Core {
    fn held(&self, key: &str) -> Option<&LoroValue> {
        self.fields.iter().find(|(held, _)| held == key).map(|(_, value)| value)
    }

    pub(crate) fn description(&self) -> Option<&str> {
        match self.held("description")? {
            LoroValue::String(text) => Some(text.as_str()),
            _ => None,
        }
    }

    pub(crate) fn tags(&self) -> Option<&LoroValue> {
        self.held("tags")
    }

    /// The facets as a value, `None` for a payload the wire cannot write.
    pub(crate) fn value(&self) -> Option<Value> {
        let mut written = Vec::new();
        for (key, held) in &self.fields {
            written.push((key.clone(), plain(held)?));
        }
        written.sort_by(|a, b| a.0.cmp(&b.0));
        Some(Value::Map(written))
    }
}

/// One trust stamp: an object with an actor and a timestamp, whatever else it
/// carries.
fn trust_event(value: &LoroValue) -> bool {
    let LoroValue::Map(event) = value else { return false };
    matches!(event.get("by"), Some(LoroValue::String(by)) if !by.is_empty() && okf_actor(by))
        && matches!(event.get("at"), Some(LoroValue::String(at)) if okf_timestamp(at))
}

fn trust_field_valid(key: &str, value: &LoroValue) -> bool {
    match key {
        "generated" => trust_event(value),
        "verified" => matches!(value, LoroValue::List(events) if events.iter().all(trust_event)),
        _ => false,
    }
}

/// The trust family, `None` for a spatial document and when no field is
/// valid; undecided for a payload the wire cannot write.
pub(crate) fn trust_facets(doc: &LoroDoc) -> Result<Option<Value>, Undecided> {
    if document_kind(doc) == Some(DocumentKind::Spatial) {
        return Ok(None);
    }
    let map = map_of(doc, TRUST_KEY);
    let mut written = Vec::new();
    for key in map.keys() {
        let Some(value) = map.get(&key).and_then(value_of) else { continue };
        if trust_field_valid(&key, &value) {
            written.push((key.to_string(), plain(&value).ok_or(Undecided)?));
        }
    }
    written.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((!written.is_empty()).then_some(Value::Map(written)))
}
