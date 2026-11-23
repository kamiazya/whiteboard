//! The bounds a single map VALUE is held to — a node, an edge, a line, a
//! message and a thread's anchor are each one value, so no text container
//! ever sees what they carry — measured the way every reader reads it
//! (`sync-value-bounds.ts` and `value-lengths.ts`).
//!
//! A value is read as the TypeScript holds it: an object's field is a string
//! or nothing, an array is a value with no fields, and a container is no
//! value at all.

use super::breach::{BreachShape, TextBreach, count, text};
use super::place::{Place, map_at, place_of, units, value_at};
use loro::{ContainerID, LoroDoc, LoroValue};
use whiteboard_model::Value;

/// What one bound measures of a value, and where it applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Measure {
    NodeText,
    NodeLocation,
    Label,
    Message,
    AnchorNodes,
    ThreadQuote,
    ChangeQuote,
    ElementTagCount,
    ElementTagChars,
    BoardTagCount,
    BoardTagChars,
}

/// Each bound and its ceiling, in the order the TypeScript asks them, which
/// decides the breach a value past two of them is named by.
pub(super) const BOUNDS: [(Measure, usize); 11] = [
    (Measure::NodeText, 8192),
    (Measure::NodeLocation, 8192),
    (Measure::Label, 1024),
    (Measure::Message, 4096),
    (Measure::AnchorNodes, 2000),
    (Measure::ThreadQuote, 1024),
    (Measure::ChangeQuote, 1024),
    (Measure::ElementTagCount, 1024),
    (Measure::ElementTagChars, 1024),
    (Measure::BoardTagCount, 1024),
    (Measure::BoardTagChars, 1024),
];

/// Whether `amount` is past a ceiling of `max`. The one comparison both the
/// history's filter and the state's judgement make, so they cannot disagree
/// about a value exactly at its ceiling.
pub(super) const fn past(amount: usize, max: usize) -> bool {
    amount > max
}

/// An object's field, `None` for anything that is not an object.
fn field<'a>(value: Option<&'a LoroValue>, key: &str) -> Option<&'a LoroValue> {
    match value? {
        LoroValue::Map(entries) => entries.get(key),
        _ => None,
    }
}

/// The length of an object's string field, 0 when it has none.
fn field_len(value: Option<&LoroValue>, key: &str) -> usize {
    match field(value, key) {
        Some(LoroValue::String(held)) => units(held),
        _ => 0,
    }
}

/// The tags a value carries: the board's are the value itself, an element's
/// its `tags` field.
fn tags_in(value: &LoroValue) -> &[LoroValue] {
    let held = match value {
        LoroValue::List(_) => Some(value),
        LoroValue::Map(_) => field(Some(value), "tags"),
        _ => None,
    };
    match held {
        Some(LoroValue::List(items)) => items,
        _ => &[],
    }
}

fn longest_tag(value: &LoroValue) -> usize {
    tags_in(value)
        .iter()
        .filter_map(|tag| match tag {
            LoroValue::String(held) => Some(units(held)),
            _ => None,
        })
        .max()
        .unwrap_or(0)
}

/// What `measure` reads of `value`.
pub(super) fn length(measure: Measure, value: &LoroValue) -> usize {
    let value = Some(value);
    match measure {
        Measure::NodeText => field_len(field(value, "resource"), "content"),
        Measure::NodeLocation => {
            let resource = field(value, "resource");
            field_len(resource, "location")
                .max(field_len(resource, "subpath"))
                .max(field_len(value, "background"))
        }
        Measure::Label => field_len(value, "label"),
        Measure::Message => field_len(value, "body"),
        Measure::AnchorNodes => match field(value, "nodeIds") {
            Some(LoroValue::List(ids)) => ids.len(),
            _ => 0,
        },
        Measure::ThreadQuote => field_len(field(value, "quote"), "exact"),
        Measure::ChangeQuote => field_len(field(field(value, "anchor"), "quote"), "exact"),
        Measure::ElementTagCount | Measure::BoardTagCount => value.map_or(0, |v| tags_in(v).len()),
        Measure::ElementTagChars | Measure::BoardTagChars => value.map_or(0, longest_tag),
    }
}

/// Whether `measure` applies to the value at `key` of the map at `place`.
fn holds(measure: Measure, place: &Place, key: &str) -> bool {
    let thread = || place.key_back(2) == Some("threads") && place.at_document_depth(2);
    match measure {
        Measure::NodeText | Measure::NodeLocation => place.is_content_at("nodes"),
        Measure::Label => ["nodes", "edges", "lines"].iter().any(|at| place.is_content_at(at)),
        Measure::Message => {
            place.key_back(1) == Some("messages")
                && place.key_back(3) == Some("threads")
                && place.at_document_depth(3)
        }
        Measure::AnchorNodes | Measure::ThreadQuote => key == "anchor" && thread(),
        Measure::ChangeQuote => {
            place.key_back(1) == Some("changes")
                && place.key_back(3) == Some("proposals")
                && place.at_document_depth(3)
        }
        Measure::ElementTagCount | Measure::ElementTagChars => {
            ["nodes", "edges"].iter().any(|at| place.is_content_at(at))
        }
        Measure::BoardTagCount | Measure::BoardTagChars => {
            key == "tags" && place.is_content_at("canvas")
        }
    }
}

/// The breach `measure` names for `amount` at `key` of `container`.
fn breach(
    measure: Measure,
    amount: usize,
    key: &str,
    container: Value,
    place: &Place,
) -> TextBreach {
    let own = || text(place.key_back(1).unwrap_or_default());
    let (shape, fields) = match measure {
        Measure::NodeText => {
            (BreachShape::NodeText, vec![("chars", count(amount)), ("nodeId", text(key))])
        }
        Measure::NodeLocation => {
            (BreachShape::NodeLocation, vec![("chars", count(amount)), ("nodeId", text(key))])
        }
        Measure::Label => {
            (BreachShape::Label, vec![("chars", count(amount)), ("elementId", text(key))])
        }
        Measure::Message => {
            (BreachShape::CommentMessage, vec![("chars", count(amount)), ("messageId", text(key))])
        }
        Measure::AnchorNodes => {
            (BreachShape::ThreadAnchor, vec![("count", count(amount)), ("threadId", own())])
        }
        Measure::ThreadQuote => {
            (BreachShape::AnchorQuote, vec![("chars", count(amount)), ("elementId", own())])
        }
        Measure::ChangeQuote => {
            (BreachShape::AnchorQuote, vec![("chars", count(amount)), ("elementId", text(key))])
        }
        Measure::ElementTagCount
        | Measure::ElementTagChars
        | Measure::BoardTagCount
        | Measure::BoardTagChars => {
            return tag_breach(measure, amount, key, container);
        }
    };
    let mut fields = fields;
    fields.push(("container", container));
    TextBreach::new(shape, fields)
}

fn tag_breach(measure: Measure, amount: usize, key: &str, container: Value) -> TextBreach {
    let which = match measure {
        Measure::ElementTagCount | Measure::BoardTagCount => "count",
        _ => "chars",
    };
    let element = match measure {
        Measure::BoardTagCount | Measure::BoardTagChars => Value::Null,
        _ => text(key),
    };
    TextBreach::new(
        BreachShape::Tags,
        vec![
            ("measure", text(which)),
            ("amount", count(amount)),
            ("elementId", element),
            ("container", container),
        ],
    )
}

/// A map entry some op set to a value past a bound, judged on the state.
pub(super) struct LongValue {
    pub container: ContainerID,
    pub key: String,
    pub measure: Measure,
    pub max: usize,
}

/// The first long value the state still holds past its bound where the bound applies.
pub(super) fn value_breach(doc: &LoroDoc, long: &[LongValue]) -> Option<TextBreach> {
    long.iter().find_map(|value| {
        let place = place_of(doc, &value.container)?;
        if !holds(value.measure, &place, &value.key) {
            return None;
        }
        let held = map_at(doc, &value.container).and_then(|map| value_at(&map, &value.key));
        let amount = held.map_or(0, |held| length(value.measure, &held));
        let container = text(&value.container.to_string());
        past(amount, value.max)
            .then(|| breach(value.measure, amount, &value.key, container, &place))
    })
}
