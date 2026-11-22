//! Reading a document's bytes into the values the oracle records.

use loro::{LoroDoc, LoroValue};
use whiteboard_model::Value;

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

/// A loro value as the model's, as npm loro-crdt's `toJSON` answers it: every
/// integer is a JavaScript number, so one past +-2^53 rounds to the nearest
/// double exactly as it does there, and a container id the document does not
/// resolve is its string form (`cid:root-name:Map`, `cid:4@7:Map`).
pub fn loro_value_to_value(value: &LoroValue) -> Value {
    match value {
        LoroValue::Null => Value::Null,
        LoroValue::Bool(b) => Value::Bool(*b),
        LoroValue::Double(d) => Value::Number(*d),
        #[expect(
            clippy::cast_precision_loss,
            reason = "npm loro-crdt hands every i64 to JavaScript as a number, rounding past +-2^53 the same way"
        )]
        LoroValue::I64(n) => Value::Number(*n as f64),
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
        LoroValue::Container(id) => Value::String(id.to_string()),
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
