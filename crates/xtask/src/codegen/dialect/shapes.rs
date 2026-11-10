//! Lowering of the constructs that name a closed set of values, a choice of
//! definitions, or a bounded list, and the Rust spelling of an enum's variants.

use std::collections::BTreeSet;

use super::{DEFS_PREFIX, Node, Ty, lower, only};

/// A string enum: `type: string` with the values it may hold, a definition of
/// its own so both languages give it a name.
pub(super) fn lower_enum<'a>(
    node: &'a Node,
    at: &str,
    top: bool,
    v: &mut Vec<String>,
) -> Option<Ty<'a>> {
    only(node, &["enum"], "an enum", at, v);
    if !top {
        v.push(format!("{at}: name an enum in $defs and `$ref` it"));
        return None;
    }
    let values = node.values.as_deref().unwrap_or_default();
    if values.is_empty() {
        v.push(format!("{at}.enum: declares no value"));
    }
    let mut variants = BTreeSet::new();
    for value in values {
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            v.push(format!("{at}.enum: `{value}` is not lowercase letters and digits"));
            continue;
        }
        let variant = variant_name(value);
        if variant == "Self" {
            v.push(format!("{at}.enum: `{value}` is not a name a Rust variant takes"));
        } else if !variants.insert(variant.clone()) {
            v.push(format!("{at}.enum: two values name the Rust variant `{variant}`"));
        }
    }
    Some(Ty::Enum(values.iter().map(String::as_str).collect()))
}

/// The Rust variant for an enum value: capitalised, and `V`-prefixed where it
/// would begin with a digit.
pub(in super::super) fn variant_name(value: &str) -> String {
    let mut chars = value.chars();
    let first = chars.next().unwrap_or_default();
    if first.is_ascii_digit() {
        return format!("V{value}");
    }
    first.to_ascii_uppercase().to_string() + chars.as_str()
}

/// A union: `anyOf` over `$ref`s to definitions, each a Rust variant of the
/// referenced type's name.
pub(super) fn lower_union<'a>(
    node: &'a Node,
    at: &str,
    top: bool,
    v: &mut Vec<String>,
) -> Option<Ty<'a>> {
    only(node, &["anyOf"], "a union", at, v);
    if node.kind.is_some() {
        v.push(format!("{at}: a union carries no `type`"));
    }
    if !top {
        v.push(format!("{at}: name a union in $defs and `$ref` it"));
        return None;
    }
    let members = node.any_of.as_deref().unwrap_or_default();
    if members.len() < 2 {
        v.push(format!("{at}.anyOf: a union has at least two members"));
    }
    let mut names: Vec<&str> = Vec::new();
    for (i, member) in members.iter().enumerate() {
        let member_at = format!("{at}.anyOf[{i}]");
        let target = member.reference.as_deref().and_then(|r| r.strip_prefix(DEFS_PREFIX));
        let Some(name) = target else {
            v.push(format!("{member_at}: a union member is a `{DEFS_PREFIX}<name>` reference"));
            continue;
        };
        only(member, &["$ref"], "a union member", &member_at, v);
        if member.kind.is_some() || member.description.is_some() {
            v.push(format!("{member_at}: a union member carries only its `$ref`"));
        }
        if names.contains(&name) {
            v.push(format!("{member_at}: `{name}` is already a member"));
        }
        names.push(name);
    }
    Some(Ty::Union(names))
}

/// An array of one element schema, optionally bounded in length.
pub(super) fn lower_array<'a>(node: &'a Node, at: &str, v: &mut Vec<String>) -> Option<Ty<'a>> {
    only(node, &["items", "minItems", "maxItems"], "an array", at, v);
    let Some(items) = &node.items else {
        v.push(format!("{at}: an array declares its `items`"));
        return None;
    };
    if node.min_items.zip(node.max_items).is_some_and(|(min, max)| min > max) {
        v.push(format!("{at}: minItems is above maxItems"));
    }
    let item = Box::new(lower(items, &format!("{at}.items"), false, v)?);
    Some(Ty::Array { item, min: node.min_items, max: node.max_items })
}
