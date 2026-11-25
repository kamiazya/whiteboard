//! Where each passage of a call lands in the body, and what the whole set may
//! do to it: disjoint, still reading what its writer assumed, and within the
//! body limit. Positions are UTF-16 units, as the TypeScript's are.

use std::collections::HashSet;

use whiteboard_api_contracts::Refusal;
use whiteboard_codec::json_canvas::json_text;
use whiteboard_model::Value;
use whiteboard_model::text_anchor::{TextAnchor, TextQuote, resolve_text_anchor};

use super::BodyReplace;
use crate::content::field;
use crate::js_offset::offset;
use crate::text_refusal::phrase;

/// `MARKDOWN_MAX_CHARS`: a body longer than this is refused when an edit
/// grows it; a body stored longer before the limit may still shrink.
const MARKDOWN_MAX_CHARS: usize = 262_144;

/// A passage and where the body holds it: the change a caller sent, or one a
/// proposal already stores.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Placed {
    id: String,
    text: String,
    assumed: String,
    anchor: TextAnchor,
    start: usize,
    end: usize,
}

/// An index as the double a stored offset is.
fn double(index: usize) -> f64 {
    f64::from(u32::try_from(index).unwrap_or(u32::MAX))
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn quoted(text: &str) -> String {
    json_text(&Value::String(text.to_owned())).unwrap_or_default()
}

fn not_applicable(change_id: &str, detail: String) -> Refusal {
    Refusal::PassageNotApplicable { change_id: change_id.to_owned(), detail }
}

impl Placed {
    /// A passage the body holds at `start..end`.
    fn at(
        id: String,
        text: String,
        assumed: String,
        anchor: TextAnchor,
        at: (usize, usize),
    ) -> Self {
        Self { id, text, assumed, anchor, start: at.0, end: at.1 }
    }

    /// The change as a proposal stores it: its anchor stated at where its
    /// quote resolved, so every later reader takes the offsets' shortcut.
    pub(super) fn change(&self) -> Value {
        let held = |key: &str, text: &Option<String>| {
            text.as_ref().map(|text| (key.to_owned(), Value::String(text.clone())))
        };
        let quote: Vec<(String, Value)> = [
            held("prefix", &self.anchor.quote.prefix),
            Some(("exact".to_owned(), Value::String(self.anchor.quote.exact.clone()))),
            held("suffix", &self.anchor.quote.suffix),
        ]
        .into_iter()
        .flatten()
        .collect();
        let anchor = Value::Map(vec![
            ("kind".to_owned(), Value::String("text".to_owned())),
            ("quote".to_owned(), Value::Map(quote)),
            ("start".to_owned(), Value::Number(double(self.start))),
            ("end".to_owned(), Value::Number(double(self.end))),
        ]);
        Value::Map(vec![
            ("id".to_owned(), Value::String(self.id.clone())),
            ("status".to_owned(), Value::String("open".to_owned())),
            ("op".to_owned(), Value::String("body.replace".to_owned())),
            ("anchor".to_owned(), anchor),
            ("text".to_owned(), Value::String(self.text.clone())),
            ("assumed".to_owned(), Value::String(self.assumed.clone())),
        ])
    }
}

/// Every op of the call, with where `body` holds its passage, or the
/// refusal naming the first that cannot be placed. `taken` are the ids of a
/// proposal this call continues.
pub(super) fn place_all(
    body: &[u16],
    ops: &[BodyReplace],
    taken: &[String],
) -> Result<Vec<Placed>, Refusal> {
    let mut seen: HashSet<&str> = taken.iter().map(String::as_str).collect();
    let mut placed = Vec::with_capacity(ops.len());
    for op in ops {
        if !seen.insert(op.id.as_str()) {
            let why = if taken.contains(&op.id) {
                "the proposal this call continues already holds a change with that id, and storing it would replace that change rather than add one"
            } else {
                "two passages in this call share that change id, and an Adopt naming it could not tell them apart"
            };
            return Err(not_applicable(&op.id, why.to_owned()));
        }
        if let Some(node) = &op.node_id {
            let why = format!(
                "a markdown document has no node {}; omit nodeId to quote its body",
                quoted(node)
            );
            return Err(not_applicable(&op.id, why));
        }
        let anchor = TextAnchor {
            node_id: None,
            quote: TextQuote {
                prefix: op.prefix.clone(),
                exact: op.exact.clone(),
                suffix: op.suffix.clone(),
            },
            start: offset(op.start),
            end: offset(op.end),
        };
        let Some(found) = resolve_text_anchor(body, &anchor) else {
            return Err(not_applicable(&op.id, "its passage is no longer in the body".to_owned()));
        };
        placed.push(Placed::at(
            op.id.clone(),
            op.text.clone(),
            op.assumed.clone(),
            anchor,
            (found.start, found.end),
        ));
    }
    Ok(placed)
}

/// A stored change as a passage, when it is an open `body.replace` whose
/// passage the body still holds: only those are what a whole-proposal Adopt
/// would apply, so a decided change, a canvas change or a passage that has
/// since vanished reserves nothing.
fn stored_passage(body: &[u16], change: &Value) -> Option<Placed> {
    let named = |key: &str| match field(change, key) {
        Some(Value::String(held)) => Some(held.clone()),
        _ => None,
    };
    if named("op")? != "body.replace" || named("status")? != "open" {
        return None;
    }
    let anchor = field(change, "anchor")?;
    let quote = field(anchor, "quote")?;
    let member = |key: &str| match field(quote, key) {
        Some(Value::String(held)) => Some(held.clone()),
        _ => None,
    };
    let number = |key: &str| match field(anchor, key) {
        Some(Value::Number(held)) => Some(offset(*held)),
        _ => None,
    };
    let anchor = TextAnchor {
        node_id: None,
        quote: TextQuote {
            prefix: member("prefix"),
            exact: member("exact")?,
            suffix: member("suffix"),
        },
        start: number("start")?,
        end: number("end")?,
    };
    let found = resolve_text_anchor(body, &anchor)?;
    Some(Placed::at(
        named("id")?,
        named("text")?,
        named("assumed")?,
        anchor,
        (found.start, found.end),
    ))
}

/// The passages a proposal already holds, placed against the body as it now
/// stands.
pub(super) fn place_existing(body: &[u16], proposal: &Value) -> Vec<Placed> {
    match field(proposal, "changes") {
        Some(Value::Seq(changes)) => {
            changes.iter().filter_map(|change| stored_passage(body, change)).collect()
        }
        _ => Vec::new(),
    }
}

/// `[start, end)` as the refusals write a range.
fn range(passage: &Placed) -> String {
    format!("[{}, {})", passage.start, passage.end)
}

/// Refuses a set whose passages reach into one another. Ranges that merely
/// touch are disjoint; neighbours in start order are enough to compare, since
/// a passage starting between two starts before the earlier one ends.
pub(super) fn refuse_overlap(placed: &[Placed]) -> Result<(), Refusal> {
    let mut by_start: Vec<&Placed> = placed.iter().collect();
    by_start.sort_by_key(|passage| passage.start);
    for pair in by_start.windows(2) {
        let [earlier, later] = pair else { continue };
        if later.start < earlier.end {
            let why = format!(
                "its passage {} overlaps {}'s {} — applying both would write text neither one proposed",
                range(later),
                earlier.id,
                range(earlier)
            );
            return Err(not_applicable(&later.id, why));
        }
    }
    Ok(())
}

/// Refuses a set that would rewrite words the caller did not see: the first
/// passage, in call order, whose range no longer reads what it assumed.
pub(super) fn refuse_stale(placed: &[Placed], body: &[u16]) -> Result<(), Refusal> {
    for passage in placed {
        let now = body.get(passage.start..passage.end).unwrap_or_default();
        if now != units(&passage.assumed).as_slice() {
            let why = format!(
                "the body now reads {} there, not {}",
                quoted(&String::from_utf16_lossy(now)),
                quoted(&passage.assumed)
            );
            return Err(not_applicable(&passage.id, why));
        }
    }
    Ok(())
}

/// The body with every passage replaced, each read from the one body: the
/// passages must be disjoint, which [`refuse_overlap`] has judged.
pub(super) fn apply_disjoint(body: &[u16], placed: &[Placed]) -> Vec<u16> {
    let mut by_start: Vec<&Placed> = placed.iter().collect();
    by_start.sort_by_key(|passage| passage.start);
    let mut next = Vec::with_capacity(body.len());
    let mut kept = 0;
    for passage in by_start {
        next.extend_from_slice(body.get(kept..passage.start).unwrap_or_default());
        next.extend(passage.text.encode_utf16());
        kept = passage.end;
    }
    next.extend_from_slice(body.get(kept..).unwrap_or_default());
    next
}

/// How many units a passage adds to the body; a deletion adds less than none.
fn growth(passage: &Placed) -> i64 {
    let signed = |n: usize| i64::try_from(n).unwrap_or(i64::MAX);
    signed(passage.text.encode_utf16().count()) - signed(passage.end - passage.start)
}

/// Refuses growth past the body limit: only growth that ends past it, so a
/// body stored longer before the limit still takes an edit that shortens it.
/// The refusal names the passage of `placed` that grows the body most.
pub(super) fn refuse_growth(before: usize, placed: &[Placed], after: usize) -> Result<(), Refusal> {
    if after <= MARKDOWN_MAX_CHARS || after <= before {
        return Ok(());
    }
    let mut largest: Option<&Placed> = None;
    for passage in placed {
        if largest.is_none_or(|held| growth(passage) > growth(held)) {
            largest = Some(passage);
        }
    }
    let Some(largest) = largest else { return Ok(()) };
    let why =
        format!("the edit would leave the body {after} characters, over {}", phrase::MARKDOWN);
    Err(not_applicable(&largest.id, why))
}

#[cfg(test)]
mod tests;
