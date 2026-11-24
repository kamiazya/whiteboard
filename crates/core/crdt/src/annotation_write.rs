//! The annotation layer's writers over a document that is the root of its own
//! `LoroDoc`, as `comment-threads.ts` and `thread-marks.ts` write it: one loro
//! call for one npm loro-crdt call, in the same order, so the operations a
//! write appends are the TypeScript's own.
//!
//! A value is written as JavaScript hands it to npm loro-crdt: an object's
//! keys in the order it enumerates them, which is the order loro's map value
//! receives them in. A value holding a `__proto__` key is not answered, since
//! what JavaScript makes of one depends on how the object was built.

use crate::annotations::{
    MESSAGES_KEY, RETIRED_COMMENTS_KEY, RETIRED_PLANE_REFUSAL, Stored, THREADS_KEY, child_map,
    read_thread, threads_in,
};
use crate::host::{Host, LORO_REFUSAL};
use crate::read::loro_value_to_value;
use crate::spatial_write::{Fault, Step, field, holds_reserved_key, items, text};
use crate::write::plain;
use loro::{
    Container, ExpandType, LoroMap, LoroValue, StyleConfig, StyleConfigMap, ValueOrContainer,
};
use whiteboard_model::{Value, enumeration_order};

const ANCHOR: &str = "anchor";
const STATUS: &str = "status";
const CREATED_AT: &str = "createdAt";
const BODY: &str = "body";
const MARK_PREFIX: &str = "comment-";
const TYPE_ERROR: Fault = Fault::Thrown("TypeError");

/// `openMergeableMap`: a mergeable child where the key is absent, and
/// otherwise what npm loro-crdt's `getOrCreateContainer` answers — the map
/// standing there, a fresh one over a null, and a refusal (thrown as a
/// string) over anything else.
pub(crate) fn open_mergeable_map(map: &LoroMap, key: &str) -> Result<LoroMap, Fault> {
    match map.get(key) {
        None => map.ensure_mergeable_map(key).map_err(|_| LORO_REFUSAL),
        Some(ValueOrContainer::Container(Container::Map(held))) => Ok(held),
        Some(ValueOrContainer::Value(LoroValue::Null)) => {
            map.insert_container(key, LoroMap::new()).map_err(|_| LORO_REFUSAL)
        }
        Some(_) => Err(LORO_REFUSAL),
    }
}

/// `map.set(key, value)`, the value as JavaScript enumerates it.
pub(crate) fn put(map: &LoroMap, key: &str, value: &Value) -> Step {
    if holds_reserved_key(value) {
        return Err(Fault::Declined);
    }
    let value = plain(&enumeration_order(value.clone())).map_err(|_| Fault::Declined)?;
    map.insert(key, value).map_err(|_| Fault::Declined)
}

/// `messageToFields`: the message's id, and the fields it carries.
fn message_fields(message: &Value) -> Result<(&str, Value), Fault> {
    let id = text(field(message, "id"))?;
    let mut fields = vec![("id".to_owned(), Value::String(id.to_owned()))];
    fields.push(("body".to_owned(), field(message, "body").ok_or(Fault::Declined)?.clone()));
    for key in ["author", "createdAt", "editedAt"] {
        if let Some(held) = field(message, key) {
            fields.push((key.to_owned(), held.clone()));
        }
    }
    Ok((id, Value::Map(fields)))
}

/// `assertFiniteAnchor`: a spatial anchor's position and size in whole,
/// finite pixels, an absent size read as none.
fn assert_finite_anchor(anchor: &Value) -> Step {
    if !matches!(anchor, Value::Map(_)) {
        return Err(Fault::Declined);
    }
    if field(anchor, "kind") != Some(&Value::String("spatial".to_owned())) {
        return Ok(());
    }
    for key in ["x", "y", "width", "height"] {
        let sized = matches!(key, "width" | "height");
        match field(anchor, key) {
            None | Some(Value::Null) if sized => {}
            Some(Value::Number(n)) if n.is_finite() && n.fract() == 0.0 => {}
            _ => return Err(TYPE_ERROR),
        }
    }
    Ok(())
}

/// The container a thread is stored in, `None` when it is not a map or the
/// plane is not there; peeked, so a thread not held opens nothing.
fn thread_container(host: &Host<'_>, id: &str) -> Result<Option<LoroMap>, Fault> {
    Ok(host.peek_map(THREADS_KEY)?.and_then(|threads| child_map(threads.get(id))))
}

/// `writeCommentThread`: the thread's own fields and its messages, in one
/// commit, the anchor asserted before anything is written.
fn write_comment_thread(host: &Host<'_>, thread: &Value) -> Step {
    assert_finite_anchor(field(thread, ANCHOR).ok_or(Fault::Declined)?)?;
    let id = text(field(thread, "id"))?;
    let status = field(thread, STATUS).ok_or(Fault::Declined)?;
    let messages = items(field(thread, "messages"))?;
    let messages = messages.iter().map(message_fields).collect::<Result<Vec<_>, _>>()?;
    let container = open_mergeable_map(&host.map(THREADS_KEY)?, id)?;
    put(&container, ANCHOR, field(thread, ANCHOR).ok_or(Fault::Declined)?)?;
    put(&container, STATUS, status)?;
    if let Some(at) = field(thread, CREATED_AT) {
        put(&container, CREATED_AT, at)?;
    }
    let held = open_mergeable_map(&container, MESSAGES_KEY)?;
    for (message_id, fields) in &messages {
        put(&held, message_id, fields)?;
    }
    host.doc().commit();
    Ok(())
}

/// `writeThreadMessage`: one message, nothing for a thread not held.
fn write_thread_message(host: &Host<'_>, thread_id: &str, message: Option<&Value>) -> Step {
    let Some(container) = thread_container(host, thread_id)? else { return Ok(()) };
    let (id, fields) = message_fields(message.ok_or(Fault::Declined)?)?;
    put(&open_mergeable_map(&container, MESSAGES_KEY)?, id, &fields)?;
    host.doc().commit();
    Ok(())
}

/// `setCommentThreadStatus`: nothing for a thread not held.
fn set_thread_status(host: &Host<'_>, thread_id: &str, status: Option<&Value>) -> Step {
    let Some(container) = thread_container(host, thread_id)? else { return Ok(()) };
    put(&container, STATUS, status.ok_or(Fault::Declined)?)?;
    host.doc().commit();
    Ok(())
}

/// Whether the anchor's `key` is the drop's, as `===` asks of two JSON values.
fn same(anchor: &loro::LoroMapValue, drop: &Value, key: &str) -> bool {
    anchor.get(key).map(loro_value_to_value).as_ref() == field(drop, key)
}

/// `movedAnchor`: the spatial point pinned where it was dropped; `None` for
/// an anchor that stays (a region, a node set, a passage, the document, or a
/// point dropped where it is).
fn moved_anchor(anchor: &LoroValue, drop: &Value) -> Result<Option<Value>, Fault> {
    let LoroValue::Map(held) = anchor else { return Ok(None) };
    let spatial =
        matches!(held.get("kind"), Some(LoroValue::String(kind)) if kind.as_str() == "spatial");
    if !spatial || held.contains_key("nodeIds") || held.contains_key("width") {
        return Ok(None);
    }
    if !matches!(drop, Value::Map(_)) {
        return Err(Fault::Declined);
    }
    if ["x", "y", "nodeId", "edgeId"].iter().all(|key| same(held, drop, key)) {
        return Ok(None);
    }
    let mut moved = vec![("kind".to_owned(), Value::String("spatial".to_owned()))];
    for key in ["x", "y"] {
        moved.push((key.to_owned(), field(drop, key).ok_or(TYPE_ERROR)?.clone()));
    }
    for key in ["nodeId", "edgeId"] {
        if let Some(held) = field(drop, key) {
            moved.push((key.to_owned(), held.clone()));
        }
    }
    Ok(Some(Value::Map(moved)))
}

/// `moveCommentThread`: nothing for a thread not held or read, nor for one
/// whose anchor stays.
fn move_thread(host: &Host<'_>, thread_id: &str, drop: Option<&Value>) -> Step {
    let Some(threads) = host.peek_map(THREADS_KEY)? else { return Ok(()) };
    let Some(container) = read_thread(&threads, thread_id).and(child_map(threads.get(thread_id)))
    else {
        return Ok(());
    };
    let Stored::Plain(anchor) = crate::annotations::stored(&container, ANCHOR) else {
        return Ok(());
    };
    let Some(moved) = moved_anchor(&anchor, drop.ok_or(Fault::Declined)?)? else { return Ok(()) };
    assert_finite_anchor(&moved)?;
    put(&container, ANCHOR, &moved)?;
    host.doc().commit();
    Ok(())
}

/// `threadStyleKey`: the id percent-encoded but for the characters a style
/// key carries verbatim and those `encodeURIComponent` leaves alone.
pub(crate) fn thread_style_key(thread_id: &str) -> String {
    let mut key = MARK_PREFIX.to_owned();
    for c in thread_id.chars() {
        if c.is_ascii_alphanumeric() || "-_.~!*'()".contains(c) {
            key.push(c);
        } else {
            let mut bytes = [0_u8; 4];
            for byte in c.encode_utf8(&mut bytes).bytes() {
                key.push('%');
                for digit in [byte >> 4, byte & 0xF] {
                    let digit = char::from_digit(u32::from(digit), 16).unwrap_or('0');
                    key.push(digit.to_ascii_uppercase());
                }
            }
        }
    }
    key
}

/// `new Map(passages)`: each id once, where it first came, with the range it
/// was given last.
fn passage_map(passages: &[Value]) -> Result<Vec<(&str, &Value)>, Fault> {
    let mut ranges: Vec<(&str, &Value)> = Vec::new();
    for entry in passages {
        let [id, range] = items(Some(entry))? else { return Err(Fault::Declined) };
        let id = text(Some(id))?;
        match ranges.iter_mut().find(|(held, _)| *held == id) {
            Some(known) => known.1 = range,
            None => ranges.push((id, range)),
        }
    }
    Ok(ranges)
}

/// One end of a passage, clamped to the body's length in UTF-16 units.
fn clamped(range: &Value, key: &str, length: usize) -> Result<usize, Fault> {
    match field(range, key) {
        Some(Value::Number(n)) if *n >= 0.0 && n.fract() == 0.0 => {
            // `abs` folds `-0`, which prints as "-0" and would not parse.
            let at: usize = n.abs().to_string().parse().unwrap_or(usize::MAX);
            Ok(at.min(length))
        }
        _ => Err(Fault::Declined),
    }
}

/// `readAnnotations` over the host's planes, peeked: the threads, refused
/// for a document still holding comments in the plane before threads.
fn held_annotations(host: &Host<'_>) -> Result<Value, Fault> {
    let retired = host.peek_map(RETIRED_COMMENTS_KEY)?;
    if retired.is_some_and(|plane| !plane.is_empty()) {
        return Err(Fault::Thrown(RETIRED_PLANE_REFUSAL));
    }
    Ok(host.peek_map(THREADS_KEY)?.map_or(Value::Seq(Vec::new()), |plane| threads_in(&plane)))
}

/// `markThreadPassages`: the styles of every thread held and marked
/// registered on the whole `LoroDoc`, then each passage marked in the host's
/// body as far as it reaches, in one commit; nothing for no passages.
fn mark_passages(host: &Host<'_>, passages: &[Value]) -> Step {
    let ranges = passage_map(passages)?;
    if ranges.is_empty() {
        return Ok(());
    }
    let held = held_annotations(host)?;
    let mut styles = StyleConfigMap::new();
    let held_ids = items(Some(&held))?.iter().filter_map(|thread| field(thread, "id"));
    let held_ids = held_ids.map(|id| text(Some(id))).collect::<Result<Vec<_>, _>>()?;
    for id in ranges.iter().map(|(id, _)| *id).chain(held_ids) {
        styles.insert(thread_style_key(id).into(), StyleConfig { expand: ExpandType::None });
    }
    host.doc().config_text_style(styles);
    let body = host.text(BODY)?;
    let length = body.len_utf16();
    for (id, range) in ranges {
        let (start, end) = (clamped(range, "start", length)?, clamped(range, "end", length)?);
        if end > start {
            let key = thread_style_key(id);
            body.mark_utf16(start..end, &key, true).map_err(|_| Fault::Declined)?;
        }
    }
    host.doc().commit();
    Ok(())
}

/// One annotation writer by name; `None` for a writer that is not one.
pub(crate) fn apply_annotation(
    host: &Host<'_>,
    op: whiteboard_model::crdt::WriterName,
    args: &Value,
) -> Option<Step> {
    use whiteboard_model::crdt::WriterName;
    let arg = |key: &str| field(args, key);
    let thread_id = || text(arg("threadId"));
    Some(match op {
        WriterName::WriteCommentThread => {
            arg("thread").ok_or(Fault::Declined).and_then(|t| write_comment_thread(host, t))
        }
        WriterName::WriteThreadMessage => {
            thread_id().and_then(|id| write_thread_message(host, id, arg("message")))
        }
        WriterName::SetCommentThreadStatus => {
            thread_id().and_then(|id| set_thread_status(host, id, arg("status")))
        }
        WriterName::MoveCommentThread => {
            thread_id().and_then(|id| move_thread(host, id, arg("drop")))
        }
        WriterName::MarkThreadPassages => {
            items(arg("passages")).and_then(|passages| mark_passages(host, passages))
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::thread_style_key;
    use crate::annotations::thread_id_of_style_key;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert, prop_assert_eq};
    use whiteboard_proptest::{Floor, check};

    /// Characters kept verbatim, kept by `encodeURIComponent` alone, and
    /// escaped across one to four UTF-8 bytes, `%` and `:` among them.
    const ALPHABET: [&str; 10] = ["a", "Z", "7", "~", "(", "!", "%", ":", "é", "😀"];

    #[test]
    fn a_style_key_names_its_thread_and_carries_only_safe_characters() {
        let both = Floor::new("an id holding a character escaped and one kept");
        let ids = prop::collection::vec(0..ALPHABET.len(), 0..8)
            .prop_map(|picks| picks.iter().filter_map(|&i| ALPHABET.get(i).copied()).collect());
        check(ids, None, |tail: String| {
            // `a:` holds one character kept and one escaped, by construction.
            let id = format!("a:{tail}");
            let key = thread_style_key(&id);
            prop_assert_eq!(thread_id_of_style_key(&key), Some(id.clone()));
            let safe = |c: char| c.is_ascii_alphanumeric() || "-_.~!*'()%".contains(c);
            prop_assert!(key.chars().all(safe), "{key}");
            both.draw(key.contains('%') && key.len() > "comment-".len());
            Ok(())
        });
        both.assert(150);
    }
}
