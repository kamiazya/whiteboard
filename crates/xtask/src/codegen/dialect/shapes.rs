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
        if !is_word(value) {
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
    let members = node.any_of.as_deref().unwrap_or_default();
    let members = union_members(node, members, "anyOf", at, top, v)?;
    Some(Ty::Union { members, discriminator: None })
}

/// A union chosen by a property: `oneOf` over `$ref`s to objects, and the
/// `discriminator` naming the property whose constant value picks the member.
pub(super) fn lower_discriminated<'a>(
    node: &'a Node,
    at: &str,
    top: bool,
    v: &mut Vec<String>,
) -> Option<Ty<'a>> {
    only(node, &["oneOf", "discriminator"], "a discriminated union", at, v);
    let members = node.one_of.as_deref().unwrap_or_default();
    let members = union_members(node, members, "oneOf", at, top, v)?;
    let Some(discriminator) = &node.discriminator else {
        v.push(format!("{at}: a oneOf needs its discriminator"));
        return None;
    };
    Some(Ty::Union { members, discriminator: Some(&discriminator.property) })
}

/// The definitions a union names, in order; none when it is not a definition.
fn union_members<'a>(
    node: &'a Node,
    members: &'a [Node],
    keyword: &str,
    at: &str,
    top: bool,
    v: &mut Vec<String>,
) -> Option<Vec<&'a str>> {
    if node.kind.is_some() {
        v.push(format!("{at}: a union carries no `type`"));
    }
    if !top {
        v.push(format!("{at}: name a union in $defs and `$ref` it"));
        return None;
    }
    if members.len() < 2 {
        v.push(format!("{at}.{keyword}: a union has at least two members"));
    }
    let mut names: Vec<&str> = Vec::new();
    for (i, member) in members.iter().enumerate() {
        let member_at = format!("{at}.{keyword}[{i}]");
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
    Some(names)
}

/// A string that is always one value, written as lowercase letters and digits
/// so a Rust constant can spell it and an enum could name it. On a property it
/// is the type's constant; as a definition it is a `String` alias a union may
/// name as a member.
pub(super) fn lower_const<'a>(node: &'a Node, at: &str, v: &mut Vec<String>) -> Ty<'a> {
    only(node, &["const"], "a constant", at, v);
    let value = node.constant.as_deref().unwrap_or_default();
    if !is_word(value) {
        v.push(format!("{at}.const: `{value}` is not lowercase letters and digits"));
    }
    Ty::Literal(value)
}

fn is_word(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// An array of one element schema, optionally bounded in length.
pub(super) fn lower_array<'a>(node: &'a Node, at: &str, v: &mut Vec<String>) -> Option<Ty<'a>> {
    only(
        node,
        &["items", "minItems", "maxItems", "x-wb-maxItemsMessage", "default"],
        "an array",
        at,
        v,
    );
    if matches!(node.default, Some(super::super::parse::Empty::Record)) {
        v.push(format!("{at}: an array's default is `[]`"));
    }
    if let Some(message) = &node.max_items_message {
        if node.max_items.is_none() {
            v.push(format!("{at}: x-wb-maxItemsMessage needs a maxItems to speak for"));
        }
        if let Err(e) = super::refusal(message) {
            v.push(format!("{at}.x-wb-maxItemsMessage: {e}"));
        }
    }
    let Some(items) = &node.items else {
        v.push(format!("{at}: an array declares its `items`"));
        return None;
    };
    if node.min_items.zip(node.max_items).is_some_and(|(min, max)| min > max) {
        v.push(format!("{at}: minItems is above maxItems"));
    }
    let item = Box::new(lower(items, &format!("{at}.items"), false, v)?);
    Some(Ty::Array {
        item,
        min: node.min_items,
        max: node.max_items,
        max_message: node.max_items_message.as_deref(),
    })
}
