//! The annotation layer a document stores one level above its content: a
//! `threads` map whose every value is a map of its own holding the thread's
//! anchor, status and a nested map of its messages (ADR-0026), and the marks
//! in the body that say where each thread's passage now is.
//!
//! A record the schema refuses costs that record and nothing beside it. A
//! thread is read from the container it is stored in; a value where a
//! container belongs, or a container where a field belongs, is a refusal.

use crate::anchor::annotation_anchor;
use crate::content::{Refusal, map_of, text_of, value_of};
use crate::plain::{object_of, plain};
use crate::stored::{field, map_of as value_map, names_only, node_id, optional, required, text};
use loro::{Container, LoroDoc, LoroMap, LoroValue, TextDelta, ValueOrContainer};
use whiteboard_model::Value;
use whiteboard_model::checks::{okf_actor, okf_timestamp};

pub(crate) const THREADS_KEY: &str = "threads";
pub(crate) const MESSAGES_KEY: &str = "messages";
const RETIRED_COMMENTS_KEY: &str = "comments";
const RETIRED_PLANE_REFUSAL: &str = "RetiredCommentPlaneError";
/// The prefix of the style key a thread's passage is marked with.
const MARK_PREFIX: &str = "comment-";

/// The map a stored entry is, `None` for a value or for any other container.
pub(crate) fn child_map(held: Option<ValueOrContainer>) -> Option<LoroMap> {
    match held {
        Some(ValueOrContainer::Container(Container::Map(map))) => Some(map),
        _ => None,
    }
}

/// What a record's field holds: nothing, a value, or a container, which no
/// field of a record may be.
pub(crate) enum Stored {
    Absent,
    Plain(LoroValue),
    Nested,
}

pub(crate) fn stored(map: &LoroMap, key: &str) -> Stored {
    match map.get(key) {
        None => Stored::Absent,
        Some(held) => value_of(held).map_or(Stored::Nested, Stored::Plain),
    }
}

/// An optional field's value: `Ok(None)` when absent, `Err` when it cannot be a field's.
pub(crate) fn optional_field(map: &LoroMap, key: &str) -> Result<Option<LoroValue>, ()> {
    match stored(map, key) {
        Stored::Absent => Ok(None),
        Stored::Plain(value) => Ok(Some(value)),
        Stored::Nested => Err(()),
    }
}

pub(crate) fn actor(value: &LoroValue) -> bool {
    text(value).is_some_and(|by| !by.is_empty() && okf_actor(by))
}

pub(crate) fn timestamp(value: &LoroValue) -> bool {
    text(value).is_some_and(okf_timestamp)
}

/// Orders two ids as `compareCodeUnit` does: by UTF-16 code unit, which is
/// not the order of code points.
pub(crate) fn by_code_unit(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn message(value: &LoroValue) -> bool {
    value_map(value).is_some_and(|m| {
        names_only(m, &["id", "body", "author", "createdAt", "editedAt"])
            && required(m, "id", node_id)
            && required(m, "body", |v| text(v).is_some_and(|body| !body.is_empty()))
            && optional(m, "author", actor)
            && optional(m, "createdAt", timestamp)
            && optional(m, "editedAt", timestamp)
    })
}

/// The entries of `container` that `check` accepts, in the container's key
/// order; an entry that is itself a container is refused.
pub(crate) fn accepted_entries(
    container: &LoroMap,
    check: impl Fn(&LoroValue) -> bool,
) -> Vec<LoroValue> {
    container
        .keys()
        .filter_map(|key| container.get(&key).and_then(value_of))
        .filter(|record| check(record))
        .collect()
}

/// A message's order key: when it was written (none sorts first), then its id.
fn message_key(value: &LoroValue) -> (&str, &str) {
    let of = |key: &str| value_map(value).and_then(|m| field(m, key)).and_then(text);
    (of("createdAt").unwrap_or(""), of("id").unwrap_or(""))
}

fn compare_messages(a: &LoroValue, b: &LoroValue) -> std::cmp::Ordering {
    let ((a_at, a_id), (b_at, b_id)) = (message_key(a), message_key(b));
    by_code_unit(a_at, b_at).then_with(|| by_code_unit(a_id, b_id))
}

/// One thread by id, `None` when it is absent or the schema refuses it.
pub(crate) fn read_thread(threads: &LoroMap, id: &str) -> Option<Value> {
    let container = child_map(threads.get(id))?;
    let Stored::Plain(anchor) = stored(&container, "anchor") else { return None };
    let Stored::Plain(status) = stored(&container, "status") else { return None };
    let created_at = optional_field(&container, "createdAt").ok()?;
    let mut messages = child_map(container.get(MESSAGES_KEY))
        .map(|held| accepted_entries(&held, message))
        .unwrap_or_default();
    messages.sort_by(compare_messages);
    if id.is_empty()
        || !annotation_anchor(&anchor)
        || !matches!(text(&status), Some("open" | "resolved"))
        || !created_at.as_ref().is_none_or(timestamp)
        || messages.is_empty()
    {
        return None;
    }
    let mut entries = vec![
        ("id".to_owned(), Value::String(id.to_owned())),
        ("anchor".to_owned(), plain(&anchor)?),
        ("status".to_owned(), plain(&status)?),
        (
            "messages".to_owned(),
            Value::Seq(messages.iter().map(plain).collect::<Option<Vec<_>>>()?),
        ),
    ];
    if let Some(at) = created_at {
        entries.push(("createdAt".to_owned(), plain(&at)?));
    }
    Some(object_of(entries))
}

/// `commentThreads`: every thread the document holds, ordered by id.
pub(crate) fn comment_threads(doc: &LoroDoc) -> Value {
    let threads = map_of(doc, THREADS_KEY);
    let mut ids: Vec<String> = threads.keys().map(|id| id.to_string()).collect();
    ids.sort_by(|a, b| by_code_unit(a, b));
    let read = ids.iter().filter_map(|id| read_thread(&threads, id));
    Value::Seq(read.collect())
}

/// `annotations`: the threads, refused for a document still holding comments
/// in the plane before threads.
pub(crate) fn annotations(doc: &LoroDoc) -> Result<Value, Refusal> {
    if map_of(doc, RETIRED_COMMENTS_KEY).is_empty() {
        Ok(comment_threads(doc))
    } else {
        Err(Refusal(RETIRED_PLANE_REFUSAL))
    }
}

/// `threadMessageCounts`: what each thread STORES, readable or not, by id. A
/// plain JavaScript object cannot hold `__proto__` as data, so that id is
/// not in the answer.
pub(crate) fn thread_message_counts(doc: &LoroDoc) -> Value {
    let threads = map_of(doc, THREADS_KEY);
    let counts = threads.keys().filter(|id| id.as_str() != "__proto__").map(|id| {
        let held = child_map(threads.get(&id))
            .and_then(|thread| child_map(thread.get(MESSAGES_KEY)))
            .map_or(0, |messages| messages.len());
        let held = f64::from(u32::try_from(held).unwrap_or(u32::MAX));
        (id.to_string(), Value::Number(held))
    });
    object_of(counts.collect())
}

/// The thread id a style key names, `None` for a key this layer did not write
/// or one carrying a malformed escape (`decodeURIComponent` refuses it).
pub(crate) fn thread_id_of_style_key(key: &str) -> Option<String> {
    percent_decode(key.strip_prefix(MARK_PREFIX)?)
}

/// `decodeURIComponent`: every `%XX` is a byte of a UTF-8 sequence that must
/// be whole and well formed (the final decode refuses a stray continuation), and anything else stands for itself.
fn percent_decode(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0_usize;
    while let Some(&byte) = bytes.get(at) {
        if byte != b'%' {
            out.push(byte);
            at = at.saturating_add(1);
            continue;
        }
        let lead = escaped_byte(bytes, at)?;
        let length = match lead {
            0x00..=0x7f => 1_usize,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        out.push(lead);
        for step in 1..length {
            out.push(escaped_byte(bytes, at.saturating_add(step.saturating_mul(3)))?);
        }
        at = at.saturating_add(length.saturating_mul(3));
    }
    String::from_utf8(out).ok()
}

/// The byte `%XX` at `at` writes.
fn escaped_byte(bytes: &[u8], at: usize) -> Option<u8> {
    let &[percent, high, low] = bytes.get(at..at.checked_add(3)?)? else { return None };
    let digit = |d: u8| char::from(d).to_digit(16);
    if percent != b'%' {
        return None;
    }
    u8::try_from(digit(high)?.checked_mul(16)?.checked_add(digit(low)?)?).ok()
}

/// `threadMarks`: every thread whose passage is still marked in the body, and
/// where, as UTF-16 offsets, in the order the walk first meets each thread.
pub(crate) fn thread_marks(doc: &LoroDoc) -> Value {
    let mut found: Vec<(String, usize, usize)> = Vec::new();
    let mut at = 0_usize;
    for run in text_of(doc).to_delta() {
        let TextDelta::Insert { insert, attributes } = run else { continue };
        let end = at.saturating_add(insert.encode_utf16().count());
        for key in attributes.iter().flat_map(|marks| marks.keys()) {
            let Some(id) = thread_id_of_style_key(key) else { continue };
            match found.iter_mut().find(|(known, ..)| *known == id) {
                Some(known) => known.2 = end,
                None => found.push((id, at, end)),
            }
        }
        at = end;
    }
    let offset = |n: usize| Value::Number(f64::from(u32::try_from(n).unwrap_or(u32::MAX)));
    let entries = found.into_iter().map(|(id, start, end)| {
        let range =
            object_of(vec![("start".to_owned(), offset(start)), ("end".to_owned(), offset(end))]);
        Value::Seq(vec![Value::String(id), range])
    });
    Value::Map(vec![("$map".to_owned(), Value::Seq(entries.collect()))])
}
