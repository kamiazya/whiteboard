//! Reading a document's bytes into the values the oracle records.

use loro::{LoroDoc, LoroValue};
use whiteboard_model::Value;

/// The doubles a JavaScript number holds every integer of.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Why bytes did not import: loro's own refusal, in its words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportError(pub String);

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ImportError {}

/// A fresh document that has imported `bytes`: a snapshot, an update batch or
/// a shallow snapshot, whichever loro-crdt exported.
pub fn import_bytes(bytes: &[u8]) -> Result<LoroDoc, ImportError> {
    let doc = LoroDoc::new();
    doc.import(bytes).map_err(|e| ImportError(e.to_string()))?;
    Ok(doc)
}

/// What `toJSON` answers: every root container resolved, a map's keys in
/// ascending order (the order is not part of the value).
pub fn deep_value(doc: &LoroDoc) -> Value {
    loro_value_to_value(&doc.get_deep_value())
}

/// A loro value as the model's. An integer past +-2^53 is a `BigInt`, as the
/// TypeScript reads it; a container id the document does not resolve is its
/// string form.
pub fn loro_value_to_value(value: &LoroValue) -> Value {
    match value {
        LoroValue::Null => Value::Null,
        LoroValue::Bool(b) => Value::Bool(*b),
        LoroValue::Double(d) => Value::Number(*d),
        LoroValue::I64(n) => {
            if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(n) {
                #[expect(
                    clippy::cast_precision_loss,
                    reason = "within +-2^53, where an i64 is exact as an f64"
                )]
                Value::Number(*n as f64)
            } else {
                Value::BigInt(n.to_string())
            }
        }
        LoroValue::Binary(bytes) => {
            Value::Seq(bytes.iter().map(|b| Value::Number(f64::from(*b))).collect())
        }
        LoroValue::String(s) => Value::String(s.to_string()),
        LoroValue::List(items) => Value::Seq(items.iter().map(loro_value_to_value).collect()),
        LoroValue::Map(entries) => {
            let mut map: Vec<(String, Value)> =
                entries.iter().map(|(k, v)| (k.clone(), loro_value_to_value(v))).collect();
            map.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Map(map)
        }
        LoroValue::Container(id) => Value::String(format!("{id:?}")),
    }
}

/// The oplog's version vector as `(peer, counter)` pairs, peers ascending
/// numerically, a peer a decimal string as the TypeScript records it.
pub fn version_pairs(doc: &LoroDoc) -> Vec<(String, i64)> {
    let mut pairs: Vec<(u64, i64)> =
        doc.oplog_vv().iter().map(|(peer, counter)| (*peer, i64::from(*counter))).collect();
    pairs.sort_by_key(|pair| *pair);
    pairs.into_iter().map(|(p, c)| (p.to_string(), c)).collect()
}

/// The oplog's frontiers as `(peer, counter)` pairs, in the order the
/// TypeScript sorts them: peer numerically, then counter.
pub fn frontier_pairs(doc: &LoroDoc) -> Vec<(String, i64)> {
    let mut pairs: Vec<(u64, i64)> =
        doc.oplog_frontiers().iter().map(|id| (id.peer, i64::from(id.counter))).collect();
    pairs.sort_by_key(|pair| *pair);
    pairs.into_iter().map(|(p, c)| (p.to_string(), c)).collect()
}
