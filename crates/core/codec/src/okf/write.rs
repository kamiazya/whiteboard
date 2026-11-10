//! `serializeOkf`: the frontmatter in its caller's key order between fences,
//! then the body as it was given.

use super::document::{Document, Map};
use super::js::{compare_code_units, enumeration_order};
use crate::frontmatter::{Fault, Value, stringify};
use whiteboard_model::okf::{OkfMarkdownFrontmatter, OkfTrustEvent};

pub(super) fn document(doc: &Document) -> Result<String, Vec<Fault>> {
    let fm = &doc.frontmatter;
    let mut root = modelled(fm);
    root.extend(fm.facets.clone().map(|facets| ("facets".to_string(), Value::Map(facets))));
    root.extend(fm.facets_raw.clone().map(|raw| ("facetsRaw".to_string(), Value::Map(raw))));
    in_order(root, &doc.body)
}

/// Writes a frontmatter whose root keys are in the order its caller built
/// them, as `serializeOkf` does: `{...rest, ...facetsRaw, facets}`, so every
/// key but `facets` and `facetsRaw` keeps its place, and those two come last.
pub(super) fn in_order(root: Map, body: &str) -> Result<String, Vec<Fault>> {
    let mut entries = Map::new();
    let (mut facets, mut facets_raw) = (None, None);
    for (name, item) in root {
        match (name.as_str(), item) {
            ("facets", Value::Map(record)) => facets = Some(record),
            ("facetsRaw", Value::Map(record)) => facets_raw = Some(record),
            (_, item) => entries.push((name, item)),
        }
    }
    // `facetsRaw` is spread after the rest, and `facets` last, so a key held
    // twice keeps the position of its first holder and takes the value of its
    // last, as an object spread does.
    let rest_len = entries.len();
    for (name, item) in canonical(facets_raw.as_deref()) {
        // The preserved keys arrive sorted and a record holds a key once, so a
        // key can only meet one of the rest or, if held twice, the one just
        // before it. Searching all of `entries` made a record of many keys
        // quadratic.
        let held =
            entries.iter().take(rest_len).position(|(held, _)| *held == name).or_else(|| {
                let last = entries.len().checked_sub(1).filter(|last| *last >= rest_len);
                last.filter(|last| entries.get(*last).is_some_and(|(held, _)| *held == name))
            });
        assign(&mut entries, held, name, item);
    }
    if facets.is_some() {
        let held = entries.iter().position(|(held, _)| held == "facets");
        assign(&mut entries, held, "facets".to_string(), Value::Map(canonical(facets.as_deref())));
    }
    let yaml = stringify(&enumeration_order(Value::Map(entries)))?;
    // `stringify` drops the line break the writer ends with. When what is left
    // still ends in one, the last value is a keep-chomped block whose final
    // line break is its own, and the reader stops at the line break before the
    // fence, so it goes back: as `serializeOkf` keeps it.
    let fence = if yaml.ends_with('\n') { "\n\n---\n" } else { "\n---\n" };
    Ok(format!("---\n{yaml}{fence}{body}"))
}

/// The keys the schema models, present ones only, in the schema's order.
fn modelled(fm: &OkfMarkdownFrontmatter) -> Map {
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

fn event(event: &OkfTrustEvent) -> Value {
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

/// `{...entries, [name]: value}`, given the position `held` of `name` in `entries`.
fn assign(entries: &mut Map, held: Option<usize>, name: String, value: Value) {
    match held.and_then(|at| entries.get_mut(at)) {
        Some(slot) => slot.1 = value,
        None => entries.push((name, value)),
    }
}

#[cfg(test)]
mod tests {
    use super::document;
    use crate::frontmatter::Value;
    use crate::okf::{Document, OkfMarkdownFrontmatter};
    // On wasm32 the same tests run under Node (QR-21 layer 3).
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn written(frontmatter: OkfMarkdownFrontmatter) -> String {
        document(&Document { frontmatter, body: String::new() }).unwrap_or_default()
    }

    fn number(n: f64) -> Value {
        Value::Number(n)
    }

    #[test]
    fn a_preserved_key_held_twice_is_written_once_with_its_last_value() {
        let raw = vec![
            ("b".to_owned(), number(1.0)),
            ("a".to_owned(), number(2.0)),
            ("a".to_owned(), number(3.0)),
            ("a".to_owned(), number(4.0)),
        ];
        let fm = OkfMarkdownFrontmatter {
            r#type: "x".to_owned(),
            facets_raw: Some(raw),
            ..OkfMarkdownFrontmatter::default()
        };
        assert_eq!(written(fm), "---\ntype: x\na: 4\nb: 1\n---\n");
    }

    #[test]
    fn a_preserved_key_named_like_a_modelled_one_takes_its_place_and_the_last_value_wins() {
        let raw = vec![
            ("facets".to_owned(), number(7.0)),
            ("title".to_owned(), Value::String("raw".to_owned())),
            ("type".to_owned(), Value::String("raw type".to_owned())),
        ];
        let fm = OkfMarkdownFrontmatter {
            r#type: "x".to_owned(),
            title: Some("t".to_owned()),
            facets: Some(vec![("a.b/v1".to_owned(), Value::Null)]),
            facets_raw: Some(raw),
            ..OkfMarkdownFrontmatter::default()
        };
        // `title` and `type` keep their modelled places with the raw values;
        // `facets` was first held by the preserved key and then replaced.
        assert_eq!(written(fm), "---\ntype: raw type\ntitle: raw\nfacets:\n  a.b/v1: null\n---\n");
    }
}
