//! `serializeOkf`: the frontmatter in canonical key order between fences,
//! then the body as it was given.

use super::document::{Document, Frontmatter, Map, TrustEvent};
use super::js::{compare_code_units, enumeration_order};
use crate::frontmatter::{Unwritable, Value, stringify};

pub(super) fn document(doc: &Document) -> Result<String, Unwritable> {
    let fm = &doc.frontmatter;
    let mut entries = modelled(fm);
    // `facetsRaw` is spread at the root it came from, and `facets` last, so
    // a key held twice keeps the position of its first holder and takes the
    // value of its last, as an object spread does.
    for (name, item) in canonical(fm.facets_raw.as_deref()) {
        assign(&mut entries, name, item);
    }
    if fm.facets.is_some() {
        assign(&mut entries, "facets".to_string(), Value::Map(canonical(fm.facets.as_deref())));
    }
    let yaml = stringify(&enumeration_order(Value::Map(entries)))?;
    Ok(format!("---\n{yaml}\n---\n{}", doc.body))
}

/// The keys the schema models, present ones only, in the schema's order.
fn modelled(fm: &Frontmatter) -> Map {
    let text = |name: &str, value: &Option<String>| {
        value.as_ref().map(|v| (name.to_string(), Value::String(v.clone())))
    };
    let events = fm
        .verified
        .as_ref()
        .map(|list| ("verified".to_string(), Value::Seq(list.iter().map(event).collect())));
    [
        Some(("type".to_string(), Value::String(fm.r#type.clone()))),
        text("title", &fm.title),
        text("description", &fm.description),
        text("resource", &fm.resource),
        fm.tags.as_ref().map(|tags| {
            ("tags".to_string(), Value::Seq(tags.iter().cloned().map(Value::String).collect()))
        }),
        text("view", &fm.view),
        fm.generated.as_ref().map(|e| ("generated".to_string(), event(e))),
        events,
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn event(event: &TrustEvent) -> Value {
    let named = [
        ("by".to_string(), Value::String(event.by.clone())),
        ("at".to_string(), Value::String(event.at.clone())),
    ];
    Value::Map(named.into_iter().chain(event.extra.iter().cloned()).collect())
}

/// A record's entries in `compareCodeUnit` order.
fn canonical(record: Option<&[(String, Value)]>) -> Map {
    let mut entries = record.map(<[_]>::to_vec).unwrap_or_default();
    entries.sort_by(|(a, _), (b, _)| compare_code_units(a, b));
    entries
}

/// `{...entries, [name]: value}`.
fn assign(entries: &mut Map, name: String, value: Value) {
    match entries.iter_mut().find(|(held, _)| *held == name) {
        Some(slot) => slot.1 = value,
        None => entries.push((name, value)),
    }
}
