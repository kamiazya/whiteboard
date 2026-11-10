//! The OKF exports' document wire: a frontmatter value as JSON, and back.
//!
//! A value is `null`, a boolean or a string as JSON spells it, and every
//! other kind is an array whose first element names it: `["f", hex]` the 64
//! bits of a double (JSON text cannot carry `-0`, `NaN` or an infinity, and
//! a parser that rounds a decimal differently from the host would move a
//! bit), `["b", digits]` a `bigint`, `["s", item...]` a sequence and
//! `["m", key, item, ...]` a mapping in the order the host enumerates it.
//! One array per collection, so a value nested to the writer's depth cap
//! stays inside `serde_json`'s recursion limit, which a tagged object per
//! entry would not.

use serde_json::{Value as Json, json};
use std::collections::BTreeSet;
use whiteboard_codec::frontmatter::Value;
use whiteboard_codec::okf::{Map, OkfMarkdownFrontmatter, OkfTrustEvent, enumeration_order};

/// The wire of a value.
pub(crate) fn value_json(value: &Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Bool(b) => json!(b),
        Value::String(s) => json!(s),
        Value::Number(n) => json!(["f", format!("{:016x}", n.to_bits())]),
        Value::BigInt(digits) => json!(["b", digits]),
        Value::Seq(items) => {
            Json::Array(std::iter::once(json!("s")).chain(items.iter().map(value_json)).collect())
        }
        Value::Map(entries) => Json::Array(
            std::iter::once(json!("m"))
                .chain(entries.iter().flat_map(|(key, item)| [json!(key), value_json(item)]))
                .collect(),
        ),
    }
}

/// The value a wire stands for, or `None` when it is not one: a bare number,
/// an object, an unknown tag, a double that is not sixteen hex digits, a
/// mapping with an odd tail, a non-string key or a key held twice (a host
/// object cannot hold one).
pub(crate) fn json_value(wire: &Json) -> Option<Value> {
    Some(match wire {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::String(s.clone()),
        Json::Number(_) | Json::Object(_) => return None,
        Json::Array(parts) => {
            let (tag, rest) = parts.split_first()?;
            match (tag.as_str()?, rest) {
                ("f", [Json::String(hex)]) => Value::Number(f64::from_bits(bits(hex)?)),
                ("b", [Json::String(digits)]) => Value::BigInt(digits.clone()),
                ("s", items) => Value::Seq(items.iter().map(json_value).collect::<Option<_>>()?),
                ("m", pairs) => Value::Map(entries(pairs)?),
                _ => return None,
            }
        }
    })
}

fn bits(hex: &str) -> Option<u64> {
    if hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        None
    }
}

fn entries(pairs: &[Json]) -> Option<Map> {
    let mut seen = BTreeSet::new();
    pairs
        .chunks(2)
        .map(|pair| {
            let [Json::String(key), item] = pair else { return None };
            seen.insert(key.as_str()).then_some(())?;
            Some((key.clone(), json_value(item)?))
        })
        .collect()
}

/// The root keys of a frontmatter, in the order the host's object holds them
/// (the schema's), which is also the order the wire must name them in.
const ORDER: [&str; 10] = [
    "type",
    "title",
    "description",
    "resource",
    "tags",
    "view",
    "generated",
    "verified",
    "facets",
    "facetsRaw",
];

/// The frontmatter as the host's object: the keys that are set, in `ORDER`.
pub(crate) fn frontmatter_value(fm: &OkfMarkdownFrontmatter) -> Value {
    let text = |held: &Option<String>| held.clone().map(Value::String);
    let map = |held: &Option<Map>| held.clone().map(Value::Map);
    let slots = [
        Some(Value::String(fm.r#type.clone())),
        text(&fm.title),
        text(&fm.description),
        text(&fm.resource),
        fm.tags.as_ref().map(|t| Value::Seq(t.iter().cloned().map(Value::String).collect())),
        text(&fm.view),
        fm.generated.as_ref().map(event_value),
        fm.verified.as_ref().map(|l| Value::Seq(l.iter().map(event_value).collect())),
        map(&fm.facets),
        map(&fm.facets_raw),
    ];
    // A trust event's integer-like extra keys come before `by`, as a host
    // object enumerates them.
    enumeration_order(Value::Map(
        ORDER
            .iter()
            .zip(slots)
            .filter_map(|(name, slot)| Some(((*name).to_owned(), slot?)))
            .collect(),
    ))
}

fn event_value(event: &OkfTrustEvent) -> Value {
    let named = [
        ("by".to_owned(), Value::String(event.by.clone())),
        ("at".to_owned(), Value::String(event.at.clone())),
    ];
    Value::Map(named.into_iter().chain(event.extra.iter().cloned()).collect())
}

/// The frontmatter a host's object stands for, or `None` when it is not one
/// the schema allows: a mapping whose keys are the schema's, each at most
/// once and in any order, `type` among them, each of the kind the schema gives
/// it, and trust events that name `by` and `at`. The order is the caller's to
/// keep, and the writer keeps it from the wire, not from what this returns.
pub(crate) fn frontmatter_from(value: Value) -> Option<OkfMarkdownFrontmatter> {
    let Value::Map(entries) = value else { return None };
    let mut fm = OkfMarkdownFrontmatter::default();
    let mut held = None::<String>;
    let mut seen = BTreeSet::new();
    for (name, item) in entries {
        if !ORDER.contains(&name.as_str()) || !seen.insert(name.clone()) {
            return None;
        }
        match name.as_str() {
            "type" => held = Some(string(item)?),
            "title" => fm.title = Some(string(item)?),
            "description" => fm.description = Some(string(item)?),
            "resource" => fm.resource = Some(string(item)?),
            "tags" => fm.tags = Some(strings(item)?),
            "view" => fm.view = Some(string(item)?),
            "generated" => fm.generated = Some(event(item)?),
            "verified" => fm.verified = Some(events(item)?),
            "facets" => fm.facets = Some(map(item)?),
            _ => fm.facets_raw = Some(map(item)?),
        }
    }
    fm.r#type = held?;
    Some(fm)
}

fn string(value: Value) -> Option<String> {
    if let Value::String(s) = value { Some(s) } else { None }
}

fn strings(value: Value) -> Option<Vec<String>> {
    let Value::Seq(items) = value else { return None };
    items.into_iter().map(string).collect()
}

fn map(value: Value) -> Option<Map> {
    if let Value::Map(entries) = value { Some(entries) } else { None }
}

fn events(value: Value) -> Option<Vec<OkfTrustEvent>> {
    let Value::Seq(items) = value else { return None };
    items.into_iter().map(event).collect()
}

fn event(value: Value) -> Option<OkfTrustEvent> {
    let entries = map(value)?;
    let mut by = None;
    let mut at = None;
    let mut extra = Map::new();
    for (name, item) in entries {
        match name.as_str() {
            // A host object holds a key once, so a wire naming one twice is no object.
            "by" if by.is_none() => by = Some(string(item)?),
            "at" if at.is_none() => at = Some(string(item)?),
            "by" | "at" => return None,
            _ => extra.push((name, item)),
        }
    }
    Some(OkfTrustEvent { by: by?, at: at?, extra })
}

#[cfg(test)]
mod tests {
    use super::{ORDER, frontmatter_from, frontmatter_value, json_value, value_json};
    use serde_json::json;
    use whiteboard_codec::frontmatter::Value;
    use whiteboard_codec::okf::{OkfMarkdownFrontmatter, OkfTrustEvent};

    /// The contract's `x-wb-order` for the frontmatter, which the generator
    /// does not emit as a constant, so `ORDER` is held to it here.
    const CONTRACT: &str = include_str!("../../../../contracts/model/okf.schema.json");

    #[test]
    fn the_wire_names_frontmatter_keys_in_the_contracts_order() {
        let contract: serde_json::Value = serde_json::from_str(CONTRACT).unwrap();
        let order = &contract["$defs"]["OkfMarkdownFrontmatter"]["x-wb-order"];
        assert_eq!(order.as_array().map(Vec::len), Some(ORDER.len()), "{order}");
        assert_eq!(*order, json!(ORDER));
    }

    #[test]
    fn every_kind_of_value_survives_the_wire_with_its_bits() {
        let value = Value::Map(vec![
            ("n".to_owned(), Value::Null),
            ("b".to_owned(), Value::Bool(true)),
            ("z".to_owned(), Value::Number(-0.0)),
            ("nan".to_owned(), Value::Number(f64::NAN)),
            ("big".to_owned(), Value::BigInt("-9007199254740993".to_owned())),
            ("s".to_owned(), Value::String("a\u{2028}\"".to_owned())),
            ("l".to_owned(), Value::Seq(vec![Value::Number(0.1), Value::Seq(Vec::new())])),
            ("m".to_owned(), Value::Map(Vec::new())),
        ]);
        let wire = value_json(&value);
        let back = json_value(&wire);
        let same = |a: &Value, b: &Value| format!("{a:?}") == format!("{b:?}");
        assert!(back.as_ref().is_some_and(|b| same(b, &value)), "{wire} came back as {back:?}");
        assert_eq!(wire[0], json!("m"));
        assert_eq!(wire[6], json!(["f", "8000000000000000"]));
    }

    #[test]
    fn a_wire_that_is_no_value_is_refused() {
        for wire in [
            json!(1),
            json!({"m": []}),
            json!([]),
            json!(["x"]),
            json!(["f"]),
            json!(["f", "3ff"]),
            json!(["f", "3ff000000000000g"]),
            json!(["f", "+ff0000000000000"]),
            json!(["f", "3ff0000000000000", 1]),
            json!(["b", 1]),
            json!(["s", 1]),
            json!(["m", "k"]),
            json!(["m", 1, null]),
            json!(["m", "k", null, "k", null]),
        ] {
            assert_eq!(json_value(&wire), None, "{wire}");
        }
        assert!(json_value(&json!(["m", "k", null, "j", null])).is_some());
    }

    fn mapping(pairs: &[(&str, Value)]) -> Value {
        Value::Map(pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
    }

    fn text(s: &str) -> Value {
        Value::String(s.to_owned())
    }

    #[test]
    fn a_frontmatter_round_trips_through_the_object_the_host_holds() {
        let event = OkfTrustEvent {
            by: "me".to_owned(),
            at: "2025-01-01T00:00:00Z".to_owned(),
            extra: vec![("note".to_owned(), text("x"))],
        };
        let fm = OkfMarkdownFrontmatter {
            r#type: "note".to_owned(),
            title: Some("t".to_owned()),
            description: Some("d".to_owned()),
            resource: Some("r".to_owned()),
            tags: Some(vec!["a".to_owned()]),
            view: Some("v".to_owned()),
            generated: Some(event.clone()),
            verified: Some(vec![event]),
            facets: Some(vec![("a.b/v1".to_owned(), Value::Null)]),
            facets_raw: Some(vec![("k".to_owned(), Value::Bool(false))]),
        };
        let object = frontmatter_value(&fm);
        let Value::Map(entries) = &object else { unreachable!("{object:?}") };
        let names: Vec<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            [
                "type",
                "title",
                "description",
                "resource",
                "tags",
                "view",
                "generated",
                "verified",
                "facets",
                "facetsRaw"
            ]
        );
        assert_eq!(frontmatter_from(object), Some(fm));
        let bare =
            OkfMarkdownFrontmatter { r#type: "x".to_owned(), ..OkfMarkdownFrontmatter::default() };
        assert_eq!(frontmatter_value(&bare), mapping(&[("type", text("x"))]));
    }

    #[test]
    fn root_keys_and_trust_event_keys_are_allowed_in_any_order() {
        let cases = [
            mapping(&[("title", text("t")), ("type", text("x"))]),
            mapping(&[
                ("type", text("x")),
                ("generated", mapping(&[("at", text("t")), ("by", text("me"))])),
            ]),
            mapping(&[
                ("facets", mapping(&[])),
                ("type", text("x")),
                (
                    "generated",
                    mapping(&[("by", text("me")), ("note", text("n")), ("at", text("t"))]),
                ),
            ]),
        ];
        for case in cases {
            assert!(frontmatter_from(case.clone()).is_some(), "{case:?}");
        }
    }

    #[test]
    fn an_object_the_schema_does_not_allow_is_refused() {
        let event = |pairs: &[(&str, Value)]| mapping(pairs);
        let good_event = event(&[("by", text("me")), ("at", text("t"))]);
        let cases = [
            Value::Null,
            mapping(&[]),
            mapping(&[("title", text("t"))]),
            mapping(&[("type", text("x")), ("type", text("y"))]),
            mapping(&[("type", text("x")), ("other", text("y"))]),
            mapping(&[("type", Value::Null)]),
            mapping(&[("type", text("x")), ("title", Value::Null)]),
            mapping(&[("type", text("x")), ("tags", text("a"))]),
            mapping(&[("type", text("x")), ("tags", Value::Seq(vec![Value::Null]))]),
            mapping(&[("type", text("x")), ("facets", Value::Null)]),
            mapping(&[("type", text("x")), ("facetsRaw", Value::Null)]),
            mapping(&[("type", text("x")), ("generated", Value::Null)]),
            mapping(&[("type", text("x")), ("generated", event(&[("at", text("t"))]))]),
            mapping(&[("type", text("x")), ("generated", event(&[("by", text("me"))]))]),
            mapping(&[
                ("type", text("x")),
                ("generated", event(&[("by", text("me")), ("by", text("you")), ("at", text("t"))])),
            ]),
            mapping(&[
                ("type", text("x")),
                ("generated", event(&[("by", text("me")), ("at", text("t")), ("at", text("u"))])),
            ]),
            mapping(&[
                ("type", text("x")),
                ("generated", event(&[("by", Value::Null), ("at", text("t"))])),
            ]),
            mapping(&[
                ("type", text("x")),
                ("generated", event(&[("by", text("me")), ("at", Value::Null)])),
            ]),
            mapping(&[("type", text("x")), ("verified", good_event.clone())]),
            mapping(&[("type", text("x")), ("verified", Value::Seq(vec![Value::Null]))]),
        ];
        for case in cases {
            assert_eq!(frontmatter_from(case.clone()), None, "{case:?}");
        }
        let ok = mapping(&[("type", text("x")), ("verified", Value::Seq(vec![good_event]))]);
        assert!(frontmatter_from(ok).is_some());
    }
}
