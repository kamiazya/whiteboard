//! From the parse tree to a [`Value`]: the checks `yaml` makes once a
//! document is composed (duplicate keys), the subset's refusals in the order
//! the TypeScript visit raises them, and `toJS`'s reading of the rest.

use std::collections::{BTreeMap, BTreeSet};

use super::node::{Node, Pair, Props, Style};
use super::schema::{Core, plain_value, resolve_plain};
use super::value::{MAX_DEPTH, Refusal, Value};

pub(super) fn resolve(root: Option<&Node>) -> Result<Value, Refusal> {
    let Some(root) = root else { return Ok(Value::Null) };
    refuse_duplicate_keys(root)?;
    visit(root, 0)?;
    Ok(to_value(root))
}

/// The key a scalar is compared by: `yaml` compares resolved values with
/// `===`, so `1` and `0x1` collide, `0` and `-0` do, and `.nan` never does.
fn key_identity(node: &Node) -> Option<(u8, String)> {
    let Node::Scalar { text, style, .. } = node else { return None };
    if *style != Style::Plain {
        return Some((3, text.clone()));
    }
    match resolve_plain(text) {
        Core::Null => Some((0, String::new())),
        Core::Bool(b) => Some((1, b.to_string())),
        Core::Number { value, .. } if value.is_nan() => None,
        Core::Number { value, .. } => Some((2, (value + 0.0).to_bits().to_string())),
        Core::Text => Some((3, text.clone())),
    }
}

fn refuse_duplicate_keys(node: &Node) -> Result<(), Refusal> {
    match node {
        Node::Map { pairs, .. } => {
            let mut seen = BTreeSet::new();
            for Pair { key, value, .. } in pairs {
                if key_identity(key).is_some_and(|identity| !seen.insert(identity)) {
                    return Err(Refusal::Syntax("a duplicate mapping key"));
                }
                refuse_duplicate_keys(key)?;
                refuse_duplicate_keys(value)?;
            }
            Ok(())
        }
        Node::Seq { items, .. } => items.iter().try_for_each(refuse_duplicate_keys),
        Node::Scalar { .. } | Node::Alias => Ok(()),
    }
}

/// Anchor, then tag, then depth, node by node, keys before values.
fn refuse_props(props: Props) -> Result<(), Refusal> {
    if props.anchored {
        return Err(Refusal::Anchor);
    }
    if props.tagged {
        return Err(Refusal::Subset("a tag"));
    }
    Ok(())
}

fn visit(node: &Node, collections_above: usize) -> Result<(), Refusal> {
    match node {
        Node::Alias => Err(Refusal::Anchor),
        Node::Scalar { props, .. } => refuse_props(*props),
        Node::Seq { items, props, outside } => {
            visit_collection(*props, collections_above)?;
            if let Some(why) = outside {
                return Err(Refusal::Subset(why));
            }
            items.iter().try_for_each(|item| visit(item, collections_above.saturating_add(1)))
        }
        Node::Map { pairs, props } => {
            visit_collection(*props, collections_above)?;
            for Pair { key, value, outside } in pairs {
                if !matches!(key, Node::Scalar { .. } | Node::Alias) {
                    return Err(Refusal::Subset("a collection key"));
                }
                if let Some(why) = outside {
                    return Err(Refusal::Subset(why));
                }
                visit(key, collections_above.saturating_add(1))?;
                visit(value, collections_above.saturating_add(1))?;
            }
            Ok(())
        }
    }
}

fn visit_collection(props: Props, collections_above: usize) -> Result<(), Refusal> {
    refuse_props(props)?;
    if collections_above.saturating_add(1) > MAX_DEPTH {
        return Err(Refusal::Depth);
    }
    Ok(())
}

fn to_value(node: &Node) -> Value {
    match node {
        Node::Scalar { text, style: Style::Plain, .. } => plain_value(text),
        Node::Scalar { text, .. } => Value::String(text.clone()),
        Node::Seq { items, .. } => Value::Seq(items.iter().map(to_value).collect()),
        Node::Map { pairs, .. } => map_value(pairs),
        Node::Alias => Value::Null,
    }
}

/// `toJS`: a key is the string JavaScript makes of its value, and a later
/// pair under the same string replaces the value but keeps the first's place.
fn map_value(pairs: &[Pair]) -> Value {
    let mut entries: Vec<(String, Value)> = Vec::with_capacity(pairs.len());
    let mut places: BTreeMap<String, usize> = BTreeMap::new();
    for Pair { key, value, .. } in pairs {
        let key = js_key(&to_value(key));
        let value = to_value(value);
        if let Some(entry) = places.get(&key).and_then(|&place| entries.get_mut(place)) {
            entry.1 = value;
        } else {
            places.insert(key.clone(), entries.len());
            entries.push((key, value));
        }
    }
    Value::Map(entries)
}

fn js_key(key: &Value) -> String {
    match key {
        Value::Null | Value::Seq(_) | Value::Map(_) => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => whiteboard_det::format::js_number_to_string(*n),
        Value::BigInt(digits) | Value::String(digits) => digits.clone(),
    }
}
