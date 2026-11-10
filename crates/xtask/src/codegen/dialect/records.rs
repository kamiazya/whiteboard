//! Lowering of records: a record of any values, and a record whose keys are a
//! string definition's and whose entries are one schema.

use super::super::parse::Empty;
use super::{Additional, Cap, CheckedDef, Node, Ty, lower, only, refusal};

/// A record is `additionalProperties`: any value (`x-wb-any`) under any key, or
/// one schema under the keys `propertyNames` references.
pub(super) fn lower_record<'a>(node: &'a Node, at: &str, v: &mut Vec<String>) -> Option<Ty<'a>> {
    only(
        node,
        &[
            "additionalProperties",
            "x-wb-check",
            "propertyNames",
            "maxProperties",
            "x-wb-maxPropertiesMessage",
            "default",
        ],
        "a record",
        at,
        v,
    );
    if matches!(node.default, Some(Empty::List)) {
        v.push(format!("{at}: a record's default is `{{}}`"));
    }
    match (&node.property_names, &node.additional) {
        (None, Some(Additional::Schema(value)))
            if value.any == Some(true)
                && value.kind.is_none()
                && value.keywords() == ["x-wb-any"] =>
        {
            for (there, keyword) in [
                (node.max_properties.is_some(), "maxProperties"),
                (node.max_properties_message.is_some(), "x-wb-maxPropertiesMessage"),
            ] {
                if there {
                    v.push(format!("{at}: `{keyword}` needs `propertyNames`"));
                }
            }
            Some(Ty::Record { check: node.check.as_deref() })
        }
        (Some(names), Some(Additional::Schema(value))) => lower_map(node, names, value, at, v),
        (Some(_), _) => {
            v.push(format!("{at}: a keyed record's `additionalProperties` is a schema"));
            None
        }
        (None, _) => {
            v.push(format!(
                "{at}: a record is `additionalProperties: {{ \"x-wb-any\": true }}`, or names its \
                 keys with `propertyNames` and its entries with a schema; any other value type \
                 is not implemented"
            ));
            None
        }
    }
}

fn lower_map<'a>(
    node: &'a Node,
    names: &'a Node,
    value: &'a Node,
    at: &str,
    v: &mut Vec<String>,
) -> Option<Ty<'a>> {
    if node.check.is_some() {
        v.push(format!("{at}: a record with `propertyNames` carries no x-wb-check"));
    }
    let key = lower(names, &format!("{at}.propertyNames"), false, v);
    let key = match key {
        Some(Ty::Ref(name)) => Some(name),
        Some(_) => {
            v.push(format!("{at}.propertyNames: is a `$ref` to a string definition"));
            None
        }
        None => None,
    };
    let value = lower(value, &format!("{at}.additionalProperties"), false, v);
    let cap = lower_cap(node, at, v);
    Some(Ty::Map { key: key?, value: Box::new(value?), cap })
}

/// The bound on a record's entries and the sentence that speaks for it.
fn lower_cap<'a>(node: &'a Node, at: &str, v: &mut Vec<String>) -> Option<Cap<'a>> {
    match (node.max_properties, node.max_properties_message.as_deref()) {
        (None, None) => None,
        (Some(max), Some(message)) => {
            if let Err(e) = refusal(message) {
                v.push(format!("{at}.x-wb-maxPropertiesMessage: {e}"));
            }
            if message.contains(['`', '$']) || !message.contains("{count}") {
                v.push(format!(
                    "{at}.x-wb-maxPropertiesMessage: holds `{{count}}` and no backtick or `$`"
                ));
            }
            Some(Cap { max, message })
        }
        _ => {
            v.push(format!("{at}: maxProperties and x-wb-maxPropertiesMessage need each other"));
            None
        }
    }
}

/// Every key of a record names a string definition, and a bounded record is
/// a definition of its own: its Zod half is a pipe, which no property holds.
pub(super) fn check_map_keys(defs: &[CheckedDef<'_>], v: &mut Vec<String>) {
    for def in defs {
        let at = format!("$defs.{}", def.name);
        let own = matches!(&def.ty, Ty::Map { cap: Some(_), .. });
        let mut maps = Vec::new();
        collect(&def.ty, &mut maps);
        for (i, (key, capped)) in maps.into_iter().enumerate() {
            if capped && !(own && i == 0) {
                v.push(format!("{at}: name a bounded record in $defs and `$ref` it"));
            }
            if let Some(found) = defs.iter().find(|d| d.name == key)
                && !matches!(found.ty, Ty::Str { .. })
            {
                v.push(format!("{at}: the keys of a record are `{key}`, which is not a string"));
            }
        }
    }
}

/// The key definition of every record under `ty`, and whether it is bounded.
fn collect<'a>(ty: &Ty<'a>, out: &mut Vec<(&'a str, bool)>) {
    match ty {
        Ty::Map { key, value, cap } => {
            out.push((key, cap.is_some()));
            collect(value, out);
        }
        Ty::Array { item, .. } => collect(item, out),
        Ty::Object(object) => object.fields.iter().for_each(|f| collect(&f.ty, out)),
        _ => {}
    }
}
