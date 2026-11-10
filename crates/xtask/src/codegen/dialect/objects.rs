//! Lowering of objects: their properties, the check and the base they may
//! carry, and the rules that need the whole set of definitions.

use std::collections::{BTreeMap, BTreeSet};

use super::{
    Additional, CheckedDef, Field, Node, Object, Ty, Unknown, described, is_field, is_index,
    lower_form, only, refusal, rust_field,
};

pub(super) fn lower_object<'a>(
    node: &'a Node,
    at: &str,
    top: bool,
    v: &mut Vec<String>,
) -> Option<Ty<'a>> {
    only(
        node,
        &[
            "properties",
            "required",
            "x-wb-order",
            "additionalProperties",
            "x-wb-unknownKeys",
            "x-wb-check",
            "x-wb-extends",
        ],
        "an object",
        at,
        v,
    );
    if !top {
        v.push(format!("{at}: name an object in $defs and `$ref` it"));
        return None;
    }
    let properties = &node.properties.as_ref()?.0;
    if properties.is_empty() {
        v.push(format!("{at}: declares no property"));
    }
    let Some(unknown) = node.unknown_keys else {
        v.push(format!("{at}: x-wb-unknownKeys is missing (refuse, strip or keep)"));
        return None;
    };
    check_additional(node, unknown, at, v);
    let declared: BTreeSet<&str> = properties.keys().map(String::as_str).collect();
    let required = names_of(node.required.as_deref(), &declared, "required", at, v);
    let order = node.order.as_deref().unwrap_or_default();
    let ordered: BTreeSet<&str> = order.iter().map(String::as_str).collect();
    if ordered.len() != order.len() || ordered != declared {
        v.push(format!("{at}.x-wb-order: must list every property exactly once"));
    }
    check_index_order(order, at, v);
    let fields = lower_fields(node, properties, &required, at, v);
    let (check, extends) = (node.check.as_deref(), node.extends.as_deref());
    Some(Ty::Object(Object { fields, unknown, check, extends }))
}

/// `additionalProperties` says what `x-wb-unknownKeys` does: false to refuse,
/// true to strip or keep.
fn check_additional(node: &Node, unknown: Unknown, at: &str, v: &mut Vec<String>) {
    let wants = unknown == Unknown::Refuse;
    if !matches!(node.additional, Some(Additional::Flag(flag)) if flag != wants) {
        v.push(format!(
            "{at}: additionalProperties must be {} for x-wb-unknownKeys {}",
            !wants,
            if wants { "refuse" } else { "strip or keep" }
        ));
    }
}

/// The fields of an object in `x-wb-order`, each checked as a name both
/// languages take and lowered.
fn lower_fields<'a>(
    node: &'a Node,
    properties: &'a BTreeMap<String, Node>,
    required: &BTreeSet<&str>,
    at: &str,
    v: &mut Vec<String>,
) -> Vec<Field<'a>> {
    let order = node.order.as_deref().unwrap_or_default();
    let mut fields: Vec<Field<'a>> = Vec::new();
    for key in order {
        let Some((name, property)) = properties.get_key_value(key) else { continue };
        let field_at = format!("{at}.{name}");
        let rust = field_name(name, &field_at, node.unknown_keys, &fields, v);
        let description = described(property, &field_at, v);
        let ty = lower_form(property, &field_at, false, v);
        let optional = !required.contains(name.as_str());
        let Decorations { default_empty, lenient, published } =
            decorations(property, optional, &field_at, v);
        if let (Some(description), Some(ty)) = (description, ty) {
            if matches!(ty, Ty::Literal(_)) && optional {
                v.push(format!("{field_at}: a constant property is required"));
            }
            fields.push(Field {
                name,
                rust,
                description,
                ty,
                optional,
                default_empty,
                lenient,
                published,
            });
        }
    }
    fields
}

/// The Rust name of a property, reported when both languages cannot take it.
fn field_name(
    name: &str,
    at: &str,
    unknown: Option<Unknown>,
    earlier: &[Field<'_>],
    v: &mut Vec<String>,
) -> String {
    if !is_field(name) {
        v.push(format!("{at}: not a lowercase identifier (snake_case or camelCase)"));
    }
    let rust = rust_field(name);
    if rust.as_deref().is_none_or(|r| matches!(r, "r#crate" | "r#self" | "r#super")) {
        v.push(format!("{at}: not a name both languages take"));
    }
    let rust = rust.unwrap_or_default();
    if earlier.iter().any(|f| f.rust == rust) {
        v.push(format!("{at}: {name} and an earlier property both name `{rust}` in Rust"));
    }
    if unknown == Some(Unknown::Keep) && rust == "extra" {
        v.push(format!("{at}: `extra` holds a keep object's unknown keys"));
    }
    rust
}

/// A property's own keywords beyond its type.
struct Decorations<'a> {
    default_empty: bool,
    lenient: bool,
    published: Option<&'a str>,
}

fn decorations<'a>(
    property: &'a Node,
    optional: bool,
    at: &str,
    v: &mut Vec<String>,
) -> Decorations<'a> {
    let default_empty = property.default.is_some();
    if default_empty && !optional {
        v.push(format!("{at}: a defaulted property is not required"));
    }
    let lenient = match property.lenient {
        None => false,
        Some(true) => true,
        Some(false) => {
            v.push(format!("{at}.x-wb-lenient: is `true` or absent"));
            false
        }
    };
    if lenient && (!optional || default_empty) {
        v.push(format!("{at}: a lenient property is optional and has no default"));
    }
    let published = property.published.as_deref();
    if let Some(Err(e)) = published.map(refusal) {
        v.push(format!("{at}.x-wb-describe: {e}"));
    }
    Decorations { default_empty, lenient, published }
}

/// `required` as a set of declared names; a name repeated or not declared is
/// reported.
fn names_of<'a>(
    list: Option<&'a [String]>,
    declared: &BTreeSet<&str>,
    what: &str,
    at: &str,
    v: &mut Vec<String>,
) -> BTreeSet<&'a str> {
    let set: BTreeSet<&str> = list.unwrap_or_default().iter().map(String::as_str).collect();
    if set.len() != list.map_or(0, <[String]>::len) {
        v.push(format!("{at}.{what}: lists a property twice"));
    }
    for name in &set {
        if !declared.contains(name) {
            v.push(format!("{at}.{what}: `{name}` is not a property"));
        }
    }
    set
}

/// Every extension adds to a plain object that checks nothing and extends
/// nothing, and refuses unknown keys itself: Zod's `extend` keeps what the base
/// does, and a refined or already-extended base cannot be extended again.
pub(super) fn check_extensions(defs: &[CheckedDef<'_>], v: &mut Vec<String>) {
    for def in defs {
        let Ty::Object(object) = &def.ty else { continue };
        let Some(base_name) = object.extends else { continue };
        let at = format!("$defs.{}", def.name);
        if object.unknown != Unknown::Refuse {
            v.push(format!("{at}: an extension must refuse unknown keys"));
        }
        let Some(base) = defs.iter().find(|d| d.name == base_name) else { continue };
        let Ty::Object(base_object) = &base.ty else {
            v.push(format!("{at}: `{base_name}` is not an object"));
            continue;
        };
        for (what, wrong) in [
            ("extends another", base_object.extends.is_some()),
            ("carries a check", base_object.check.is_some()),
            ("must strip unknown keys", base_object.unknown != Unknown::Strip),
        ] {
            if wrong {
                v.push(format!("{at}: `{base_name}` {what}"));
            }
        }
        for field in &object.fields {
            if base_object.fields.iter().any(|b| b.rust == field.rust) {
                v.push(format!("{at}.{}: repeats a property of `{base_name}`", field.name));
            }
        }
    }
}

/// Every member of a discriminated union is an object that writes the
/// discriminator as a constant of its own, and no two write the same one.
pub(super) fn check_unions(defs: &[CheckedDef<'_>], v: &mut Vec<String>) {
    for def in defs {
        let Ty::Union { members, discriminator: Some(property) } = &def.ty else { continue };
        let at = format!("$defs.{}", def.name);
        let mut seen: Vec<(&str, &str)> = Vec::new();
        for member in members {
            let Some(found) = defs.iter().find(|d| d.name == *member) else { continue };
            let Ty::Object(object) = &found.ty else {
                v.push(format!("{at}: `{member}` is not an object"));
                continue;
            };
            let value = object.fields.iter().find_map(|f| match f.ty {
                Ty::Literal(value) if f.name == *property => Some(value),
                _ => None,
            });
            let Some(value) = value else {
                v.push(format!("{at}: `{member}` has no constant property `{property}`"));
                continue;
            };
            if let Some((_, earlier)) = seen.iter().find(|(seen_value, _)| *seen_value == value) {
                v.push(format!(
                    "{at}: `{member}` and `{earlier}` both write `{property}` as `{value}`"
                ));
            }
            seen.push((value, member));
        }
    }
}

/// Array-index keys come first in ascending order: JavaScript enumerates them
/// so, and a contract that wrote another order would have the Zod half and the
/// Rust struct disagree about which field follows which.
fn check_index_order(order: &[String], at: &str, v: &mut Vec<String>) {
    let indexes: Vec<&String> = order.iter().filter(|n| is_index(n)).collect();
    let leading = order.iter().take_while(|n| is_index(n)).count();
    // A canonical index is ordered as a number by its length, then its digits.
    let ascending = indexes.windows(2).all(|w| (w[0].len(), w[0]) < (w[1].len(), w[1]));
    if leading != indexes.len() || !ascending {
        v.push(format!(
            "{at}.x-wb-order: a numeric key comes before every other, in ascending order, \
             as JavaScript enumerates them"
        ));
    }
}

/// A property that defaults to `{}` names an object that accepts it: every
/// property optional and none defaulted, nothing to check and nothing
/// inherited. Zod returns a default without parsing it, so a defaulted
/// property inside would be filled in by the Rust half and absent from the
/// Zod one.
pub(super) fn check_ref_defaults(defs: &[CheckedDef<'_>], v: &mut Vec<String>) {
    for def in defs {
        let Ty::Object(object) = &def.ty else { continue };
        for field in object.fields.iter().filter(|f| f.default_empty) {
            let Ty::Ref(target) = field.ty else { continue };
            let accepts = defs.iter().find(|d| d.name == target).is_some_and(|d| {
                matches!(&d.ty, Ty::Object(t)
                    if t.check.is_none() && t.extends.is_none() && t.fields.iter().all(|f| f.optional && !f.default_empty))
            });
            if !accepts {
                v.push(format!(
                    "$defs.{}.{}: a default `{{}}` names an object whose properties are all \
                     optional and none defaulted; `{target}` is not one",
                    def.name, field.name
                ));
            }
        }
    }
}
