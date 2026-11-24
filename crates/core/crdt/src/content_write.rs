//! The document-content writers over a document that is the root of its own
//! `LoroDoc`: the markdown body and a text spliced by runs, the envelope's
//! kind, and the facet buckets, as `markdown-body.ts`, `document-envelope.ts`
//! and `document-envelope-reconcile.ts` write them — one loro call for one npm
//! loro-crdt call, in the same order, so the operations a write appends are
//! the TypeScript's own.
//!
//! An object argument is read in the order JavaScript enumerates its keys,
//! since that is the order the TypeScript writes them in.

use crate::host::{Host, LORO_REFUSAL};
use crate::spatial_write::{
    Fault, Step, delete, field, items, refuse_reserved_key, set, text, write_canvas_facets,
};
use loro::LoroText;
use whiteboard_model::crdt::WriterName;
use whiteboard_model::{Value, enumeration_order};

const BODY: &str = "body";
const DOCUMENT: &str = "document";
const FACETS: &str = "facets";
const CORE: &str = "core";
const TRUST: &str = "trust";

type Entries = Vec<(String, Value)>;

fn is_high(unit: u16) -> bool {
    (0xD800..=0xDBFF).contains(&unit)
}

fn is_low(unit: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&unit)
}

/// `minimalChange`, in UTF-16 code units: the one range `from..to` of
/// `current` whose replacement by the units answered makes `next`, widened to
/// whole code points.
pub(crate) fn minimal_change<'a>(current: &[u16], next: &'a [u16]) -> (usize, usize, &'a [u16]) {
    let mut from = current.iter().zip(next).take_while(|(a, b)| a == b).count();
    if let Some(before) = from.checked_sub(1)
        && current.get(before).copied().is_some_and(is_high)
    {
        from = before;
    }
    let current_tail = current.get(from..).unwrap_or_default();
    let next_tail = next.get(from..).unwrap_or_default();
    let shared = current_tail.iter().rev().zip(next_tail.iter().rev());
    let shared = shared.take_while(|(a, b)| a == b).count();
    let mut to = current.len().saturating_sub(shared);
    let mut end = next.len().saturating_sub(shared);
    if current.get(to).copied().is_some_and(is_low) {
        to = to.saturating_add(1);
        end = end.saturating_add(1);
    }
    (from, to, next.get(from..end).unwrap_or_default())
}

/// `spliceText` (`minimal-change.ts`): `next` written into `target` as the
/// one span that differs.
pub(crate) fn splice_minimal(target: &LoroText, next: &str) -> Step {
    let current: Vec<u16> = target.to_string().encode_utf16().collect();
    let next: Vec<u16> = next.encode_utf16().collect();
    let (from, to, insert) = minimal_change(&current, &next);
    // A delete of nothing is no operation in loro, as the TypeScript's guard
    // around it makes it.
    target.delete_utf16(from, to.saturating_sub(from)).map_err(|_| Fault::Declined)?;
    if !insert.is_empty() {
        let insert = String::from_utf16(insert).map_err(|_| Fault::Declined)?;
        target.insert_utf16(from, &insert).map_err(|_| Fault::Declined)?;
    }
    Ok(())
}

/// `writeMarkdownBody`.
fn write_markdown_body(host: &Host<'_>, body: &str) -> Step {
    splice_minimal(&host.text(BODY)?, body)?;
    host.commit();
    Ok(())
}

/// A UTF-16 offset as npm loro-crdt takes one: a whole, non-negative number.
fn offset(value: Option<&Value>) -> Result<usize, Fault> {
    match value {
        Some(Value::Number(n)) if n.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(n) => {
            n.to_string().parse().map_err(|_| Fault::Declined)
        }
        _ => Err(Fault::Declined),
    }
}

/// The engine's `spliceText`: each run spliced into the text `name`, in
/// UTF-16 code units, with no commit of its own.
fn splice_runs(host: &Host<'_>, name: &str, runs: &[Value]) -> Step {
    let target = host.text(name)?;
    for run in runs {
        let index = offset(field(run, "index"))?;
        let remove = offset(field(run, "remove"))?;
        let insert = text(field(run, "insert"))?;
        target.splice_utf16(index, remove, insert).map_err(|_| LORO_REFUSAL)?;
    }
    Ok(())
}

/// An object argument's entries in enumeration order, declined otherwise.
fn entries_of(value: Option<&Value>) -> Result<Entries, Fault> {
    match value.cloned().map(enumeration_order) {
        Some(Value::Map(entries)) => Ok(entries),
        _ => Err(Fault::Declined),
    }
}

fn lookup<'a>(entries: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// `replaceBucket`: every entry written, then every stored key the entries do
/// not name deleted, in one commit.
fn replace_bucket(host: &Host<'_>, map: &str, entries: &[(String, Value)]) -> Step {
    refuse_reserved_key(&Value::Map(entries.to_vec()))?;
    let stored: Vec<String> = host.map(map)?.keys().map(|k| k.to_string()).collect();
    for (key, value) in entries {
        set(host, map, key, value)?;
    }
    for key in stored.iter().filter(|key| lookup(entries, key).is_none()) {
        delete(host, map, key)?;
    }
    host.commit();
    Ok(())
}

/// `{ ...value }` of an object the TypeScript's types promise.
fn spread(value: &Value) -> Result<Value, Fault> {
    entries_of(Some(value)).map(Value::Map)
}

/// `writeTrustFacets`: `generated` and `verified` copied, nothing else.
fn write_trust(host: &Host<'_>, trust: &Value) -> Step {
    if !matches!(trust, Value::Map(_)) {
        return Err(Fault::Declined);
    }
    let mut entries = Vec::new();
    if let Some(generated) = field(trust, "generated") {
        entries.push(("generated".to_owned(), spread(generated)?));
    }
    if let Some(verified) = field(trust, "verified") {
        let events = items(Some(verified))?.iter().map(spread).collect::<Result<_, _>>()?;
        entries.push(("verified".to_owned(), Value::Seq(events)));
    }
    replace_bucket(host, TRUST, &entries)
}

/// `reconcileBucket`: the map opened, what is new or changed set, then each
/// key `prev` held and `next` lacks deleted, whether or not the map holds it,
/// in one commit.
/// Two values are the same when JSON writes them alike, which over values in
/// enumeration order is equality.
fn reconcile_bucket(
    host: &Host<'_>,
    map: &str,
    prev: &[(String, Value)],
    next: &[(String, Value)],
) -> Step {
    refuse_reserved_key(&Value::Map(next.to_vec()))?;
    host.map(map)?;
    for (key, value) in next {
        if lookup(prev, key) != Some(value) {
            set(host, map, key, value)?;
        }
    }
    for (key, _) in prev.iter().filter(|(key, _)| lookup(next, key).is_none()) {
        delete(host, map, key)?;
    }
    host.commit();
    Ok(())
}

/// `reconcileCoreFacets`'s `{ ...prev }`: nothing for an absent or null one.
fn core_prev(prev: Option<&Value>) -> Result<Entries, Fault> {
    match prev {
        None | Some(Value::Null) => Ok(Vec::new()),
        held => entries_of(held),
    }
}

/// One content writer by name; `None` for a writer that is not one.
pub(crate) fn apply_content(host: &Host<'_>, op: WriterName, args: &Value) -> Option<Step> {
    let arg = |key: &str| field(args, key);
    Some(match op {
        WriterName::WriteMarkdownBody => {
            text(arg("body")).and_then(|b| write_markdown_body(host, b))
        }
        WriterName::SpliceText => text(arg("text"))
            .and_then(|name| items(arg("runs")).and_then(|runs| splice_runs(host, name, runs))),
        WriterName::WriteDocumentKind => text(arg("kind")).and_then(|kind| {
            set(host, DOCUMENT, "kind", &Value::String(kind.to_owned()))?;
            host.commit();
            Ok(())
        }),
        WriterName::WriteFacets => {
            entries_of(arg("facets")).and_then(|e| replace_bucket(host, FACETS, &e))
        }
        WriterName::WriteCoreFacets => {
            entries_of(arg("core")).and_then(|e| replace_bucket(host, CORE, &e))
        }
        WriterName::WriteTrustFacets => {
            arg("trust").ok_or(Fault::Declined).and_then(|t| write_trust(host, t))
        }
        WriterName::ReconcileFacets => entries_of(arg("prev"))
            .and_then(|prev| reconcile_bucket(host, FACETS, &prev, &entries_of(arg("next"))?)),
        WriterName::ReconcileCoreFacets => core_prev(arg("prev"))
            .and_then(|prev| reconcile_bucket(host, CORE, &prev, &entries_of(arg("next"))?)),
        WriterName::WriteCanvasFacetsField => write_canvas_facets(host, arg("next")),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::minimal_change;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert, prop_assert_eq};
    use whiteboard_proptest::proptest::test_runner::TestCaseError;
    use whiteboard_proptest::{Floor, check};

    /// Characters that share units with one another: two astral ones with one
    /// high half, two with one low half, and plain ones.
    const ALPHABET: [&str; 6] = ["a", "b", "é", "😀", "😁", "🈀"];

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn run() -> impl Strategy<Value = String> {
        prop::collection::vec(0..ALPHABET.len(), 0..6)
            .prop_map(|picks| picks.iter().filter_map(|&i| ALPHABET.get(i).copied()).collect())
    }

    /// How many units two sequences share from the front.
    fn shared_prefix(a: &[u16], b: &[u16]) -> usize {
        a.iter().zip(b).take_while(|(x, y)| x == y).count()
    }

    fn splits_pair(units: &[u16], at: usize) -> bool {
        units.get(at).is_some_and(|u| (0xDC00..=0xDFFF).contains(u))
    }

    /// The change rebuilds `next`, cuts no pair, and is the shared prefix and
    /// suffix trimmed, widened by at most the one unit a pair needs. Answers
    /// whether the front and the back were widened.
    fn holds(current: &str, next: &str) -> Result<(bool, bool), TestCaseError> {
        let (current, next) = (units(current), units(next));
        let (from, to, insert) = minimal_change(&current, &next);
        let mut rebuilt = current[..from].to_vec();
        rebuilt.extend_from_slice(insert);
        rebuilt.extend_from_slice(&current[to..]);
        prop_assert_eq!(&rebuilt, &next);
        prop_assert!(!splits_pair(&current, from) && !splits_pair(&current, to));
        prop_assert!(String::from_utf16(insert).is_ok());
        prop_assert_eq!(from == to && insert.is_empty(), current == next);
        let front = shared_prefix(&current, &next);
        let tail: Vec<u16> = current[from..].iter().rev().copied().collect();
        let next_tail: Vec<u16> = next[from..].iter().rev().copied().collect();
        let back_shared = shared_prefix(&tail, &next_tail);
        prop_assert!(from == front || from + 1 == front);
        let kept_back = current.len() - to;
        prop_assert!(kept_back == back_shared || kept_back + 1 == back_shared);
        Ok((from < front, kept_back < back_shared))
    }

    #[test]
    fn a_minimal_change_rebuilds_the_next_text_cutting_no_pair() {
        let front = Floor::new("a change widened over a shared high half");
        let back = Floor::new("a change widened over a shared low half");
        check((run(), run(), run(), run()), None, |(before, after, x, y)| {
            // Every draw holds one of each by construction: two smileys share
            // their high half, and a smiley and the squared ideograph their low.
            let (widened_front, _) =
                holds(&format!("{before}😀{after}"), &format!("{before}😁{after}"))?;
            front.draw(widened_front);
            let (_, widened_back) =
                holds(&format!("{before}😀{after}"), &format!("{before}🈀{after}"))?;
            back.draw(widened_back);
            holds(&format!("{before}{x}{after}"), &format!("{before}{y}{after}"))?;
            Ok(())
        });
        front.assert(150);
        back.assert(150);
    }
}
