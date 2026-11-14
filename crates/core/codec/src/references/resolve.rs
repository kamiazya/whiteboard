//! A parsed body's references resolved (`resolve.ts`'s `resolveReferences`).

use std::collections::BTreeMap;

use whiteboard_model::checks::canonical_ulid;
use whiteboard_model::mdast::{Flow, ListItem, Phrasing, Root, TableCell, TableRow};

use super::scan::{ReferenceMatch, find_next_reference};

fn text(value: &str) -> Phrasing {
    Phrasing::Text { value: value.to_owned() }
}

/// What a reference names: a canonical ULID names itself, whatever `aliases`
/// holds (a document NAMED like an id is shadowed, the right trade for a shape
/// no one types); anything else is an alias, a workspace path, looked up.
fn document_id(target: &str, aliases: &BTreeMap<String, String>) -> Option<String> {
    if canonical_ulid(target) {
        return Some(target.to_owned());
    }
    aliases.get(target).cloned()
}

/// The fragment rides along unresolved: it names something inside the
/// document, which only a renderer holding it can look up. Only an explicit
/// `|label` becomes the alias, so a bare `[[path]]` shows the target's current
/// name.
fn resolve_target(
    found: &ReferenceMatch<'_>,
    aliases: &BTreeMap<String, String>,
) -> Option<Phrasing> {
    let document_id = document_id(found.target, aliases)?;
    let fragment = found.fragment.map(str::to_owned);
    Some(if found.is_embed {
        Phrasing::Embed { document_id, fragment }
    } else {
        Phrasing::WikiLink { document_id, alias: found.alias.map(str::to_owned), fragment }
    })
}

/// A text's value split on its references, each resolved on its own; one that
/// does not resolve stays as its literal text, in a node of its own.
fn split_text(value: &str, aliases: &BTreeMap<String, String>) -> Vec<Phrasing> {
    let mut result = Vec::new();
    let mut last = 0;
    // Each match moves `last` forward, so the bound is never what ends the loop.
    for _ in 0..value.len() {
        let Some(found) = find_next_reference(value, last) else { break };
        if found.index > last {
            result.push(text(value.get(last..found.index).unwrap_or_default()));
        }
        result.push(resolve_target(&found, aliases).unwrap_or_else(|| text(found.full)));
        last = found.index.saturating_add(found.full.len());
    }
    if let Some(tail) = value.get(last..).filter(|tail| !tail.is_empty()) {
        result.push(text(tail));
    }
    if result.is_empty() { vec![text(value)] } else { result }
}

fn phrasing(node: &Phrasing, aliases: &BTreeMap<String, String>) -> Vec<Phrasing> {
    let walk = |children: &[Phrasing]| phrasings(children, aliases);
    vec![match node {
        Phrasing::Text { value } => return split_text(value, aliases),
        Phrasing::Emphasis { children } => Phrasing::Emphasis { children: walk(children) },
        Phrasing::Strong { children } => Phrasing::Strong { children: walk(children) },
        Phrasing::Delete { children } => Phrasing::Delete { children: walk(children) },
        Phrasing::Link { url, title, children } => {
            Phrasing::Link { url: url.clone(), title: title.clone(), children: walk(children) }
        }
        Phrasing::LinkReference { identifier, label, reference_type, children } => {
            Phrasing::LinkReference {
                identifier: identifier.clone(),
                label: label.clone(),
                reference_type: *reference_type,
                children: walk(children),
            }
        }
        other => other.clone(),
    }]
}

fn phrasings(nodes: &[Phrasing], aliases: &BTreeMap<String, String>) -> Vec<Phrasing> {
    nodes.iter().flat_map(|node| phrasing(node, aliases)).collect()
}

fn flow(node: &Flow, aliases: &BTreeMap<String, String>) -> Flow {
    match node {
        Flow::Paragraph { children } => Flow::Paragraph { children: phrasings(children, aliases) },
        Flow::Heading { depth, children } => {
            Flow::Heading { depth: *depth, children: phrasings(children, aliases) }
        }
        Flow::Blockquote { children } => Flow::Blockquote { children: flows(children, aliases) },
        Flow::List { ordered, start, spread, children } => Flow::List {
            ordered: *ordered,
            start: *start,
            spread: *spread,
            children: children.iter().map(|item| list_item(item, aliases)).collect(),
        },
        Flow::Table { align, children } => Flow::Table {
            align: align.clone(),
            children: children.iter().map(|row| table_row(row, aliases)).collect(),
        },
        other => other.clone(),
    }
}

fn flows(nodes: &[Flow], aliases: &BTreeMap<String, String>) -> Vec<Flow> {
    nodes.iter().map(|node| flow(node, aliases)).collect()
}

fn list_item(item: &ListItem, aliases: &BTreeMap<String, String>) -> ListItem {
    ListItem {
        checked: item.checked,
        spread: item.spread,
        children: flows(&item.children, aliases),
    }
}

fn table_row(row: &TableRow, aliases: &BTreeMap<String, String>) -> TableRow {
    let cell = |c: &TableCell| TableCell { children: phrasings(&c.children, aliases) };
    TableRow { children: row.children.iter().map(cell).collect() }
}

/// `root` with every `[[…]]`/`![[…]]` in its text resolved through `aliases`
/// (`resolveReferences`). A `[[<ULID>]]` resolves with no table; a reference
/// that does not resolve stays literal text, so a link this version cannot
/// honour is visible rather than missing. Code, math, HTML and definitions are
/// not text a reference is read from.
#[must_use]
pub fn resolve_references(root: &Root, aliases: &BTreeMap<String, String>) -> Root {
    Root { children: flows(&root.children, aliases) }
}
