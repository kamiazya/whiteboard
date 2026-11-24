//! Whether the canvas crosses the wasm wire the TypeScript sends it over
//! (`core-wasm`'s `wireOf`, compact, then `JSON.stringify`): an object nested
//! past the shim's depth is no wire, and a wire text past the entry's cap is
//! refused, by the shim on its UTF-16 length and by the export on its bytes.
//! A text is never fewer bytes than units, so the bytes decide. Neither
//! depends on the order of an object's keys, so the engine's order answers
//! for the TypeScript's.

use whiteboard_codec::json_canvas::MAX_BYTES;
use whiteboard_model::Value;

/// `WIRE_DEPTH`: an object deeper than this is no wire.
const WIRE_DEPTH: usize = 100;

/// `JSON_CANVAS_SERIALIZE`'s `maxBytes`, the cap on the wire text: the
/// codec's own, which `whiteboard-wasm` holds it to.
const MAX_WIRE: u64 = MAX_BYTES as u64;

/// The largest integer a double holds exactly: one the wire writes as itself.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// Whether the shim sends `canvas` and the export takes it.
pub(super) fn carried(canvas: &Value) -> bool {
    size(canvas, 0).is_some_and(|bytes| bytes <= MAX_WIRE)
}

/// The bytes of `JSON.stringify` of `value`'s wire, `None` when it is none.
pub(super) fn size(value: &Value, depth: usize) -> Option<u64> {
    Some(match value {
        Value::Null | Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::String(text) => quoted(text),
        Value::Number(n) => number(*n),
        // `["b","<digits>"]`
        Value::BigInt(digits) => quoted(digits).saturating_add(6),
        Value::Seq(_) | Value::Map(_) if depth > WIRE_DEPTH => return None,
        // `["s"`, then `,` and an item each, then `]`.
        Value::Seq(items) => items.iter().try_fold(5_u64, |sum, item| {
            Some(sum.saturating_add(size(item, depth.saturating_add(1))?).saturating_add(1))
        })?,
        // `["m"`, then `,"<key>",` and an item each, then `]`.
        Value::Map(entries) => entries.iter().try_fold(5_u64, |sum, (key, item)| {
            let pair = quoted(key).saturating_add(size(item, depth.saturating_add(1))?);
            Some(sum.saturating_add(pair).saturating_add(2))
        })?,
    })
}

/// A number's wire text: a safe integer other than `-0` as its digits, any
/// other number as `["f","<16 hex digits>"]`.
fn number(n: f64) -> u64 {
    let whole = n.fract() == 0.0 && n.abs() <= MAX_SAFE && !(n == 0.0 && n.is_sign_negative());
    if whole { format!("{n}").len() as u64 } else { 24 }
}

/// A string as `JSON.stringify` quotes it.
fn quoted(text: &str) -> u64 {
    text.chars().fold(2, |sum, c| {
        sum.saturating_add(match c {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            c if u32::from(c) < 0x20 => 6,
            c => c.len_utf8() as u64,
        })
    })
}

#[cfg(test)]
mod tests;
