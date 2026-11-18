//! A markdown body's model tree as JSON, an `oracle-surface` test export.
//!
//! The TypeScript parser this tree was once read from is gone; the editor's
//! property tests and the reference tests still need a real parser to say what
//! a text means, and this is the core's. One JSON text whose first element
//! names the outcome: `["ok", tree]`, or `["refused", reason]` for a body past
//! one of the parser's bounds or an alias table that is not an object of
//! strings. A host that wants the references resolved passes the alias table
//! as JSON text; an empty text asks for the parse alone. The tree has the
//! shape `mdastRootSchema` accepts: a field the node does not carry is absent
//! rather than null, except a list item's `checked` and a table's `align`
//! cells, which the model spells null.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_codec::markdown::parse_markdown_body;
use whiteboard_codec::references::resolve_references;
use whiteboard_det::format::js_number_to_string;
use whiteboard_model::mdast::{
    Align, Flow, ListItem, Phrasing, ReferenceType, Root, TableCell, TableRow,
};

/// The parse of `text` as a model tree, resolved against `aliases` when that
/// is not empty.
#[wasm_bindgen]
#[must_use]
pub fn markdown_model(text: &str, aliases: &str) -> String {
    answer(text, aliases).to_string()
}

fn answer(text: &str, aliases: &str) -> Value {
    let table = if aliases.is_empty() {
        None
    } else {
        match serde_json::from_str::<BTreeMap<String, String>>(aliases) {
            Ok(table) => Some(table),
            Err(_) => return json!(["refused", "aliases"]),
        }
    };
    match parse_markdown_body(text) {
        Ok(root) => {
            let tree = table.map_or(root.clone(), |table| resolve_references(&root, &table));
            json!(["ok", root_json(&tree)])
        }
        Err(refusal) => json!(["refused", format!("{refusal:?}")]),
    }
}

fn object(kind: &str, fields: &[(&str, Value)], optional: &[(&str, Option<&String>)]) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), kind.into());
    for (key, value) in fields {
        o.insert((*key).into(), value.clone());
    }
    for (key, value) in optional {
        if let Some(value) = value {
            o.insert((*key).into(), Value::String((*value).clone()));
        }
    }
    Value::Object(o)
}

fn root_json(root: &Root) -> Value {
    json!({ "type": "root", "children": root.children.iter().map(flow).collect::<Vec<_>>() })
}

fn phrasings(children: &[Phrasing]) -> Value {
    Value::Array(children.iter().map(phrasing).collect())
}

fn reference_type(kind: ReferenceType) -> Value {
    match kind {
        ReferenceType::Shortcut => "shortcut",
        ReferenceType::Collapsed => "collapsed",
        ReferenceType::Full => "full",
    }
    .into()
}

fn phrasing(node: &Phrasing) -> Value {
    match node {
        Phrasing::Text { value } => object("text", &[("value", value.as_str().into())], &[]),
        Phrasing::Emphasis { children } => {
            object("emphasis", &[("children", phrasings(children))], &[])
        }
        Phrasing::Strong { children } => {
            object("strong", &[("children", phrasings(children))], &[])
        }
        Phrasing::Delete { children } => {
            object("delete", &[("children", phrasings(children))], &[])
        }
        Phrasing::InlineCode { value } => {
            object("inlineCode", &[("value", value.as_str().into())], &[])
        }
        Phrasing::InlineMath { value } => {
            object("inlineMath", &[("value", value.as_str().into())], &[])
        }
        Phrasing::Html { value } => object("html", &[("value", value.as_str().into())], &[]),
        Phrasing::Break => object("break", &[], &[]),
        Phrasing::Link { .. }
        | Phrasing::Image { .. }
        | Phrasing::LinkReference { .. }
        | Phrasing::ImageReference { .. } => media(node),
        Phrasing::WikiLink { document_id, alias, fragment } => object(
            "wikiLink",
            &[("documentId", document_id.as_str().into())],
            &[("alias", alias.as_ref()), ("fragment", fragment.as_ref())],
        ),
        Phrasing::Embed { document_id, fragment } => object(
            "embed",
            &[("documentId", document_id.as_str().into())],
            &[("fragment", fragment.as_ref())],
        ),
    }
}

/// Links and images, written or by reference.
fn media(node: &Phrasing) -> Value {
    match node {
        Phrasing::Link { url, title, children } => object(
            "link",
            &[("url", url.as_str().into()), ("children", phrasings(children))],
            &[("title", title.as_ref())],
        ),
        Phrasing::Image { url, title, alt } => object(
            "image",
            &[("url", url.as_str().into())],
            &[("title", title.as_ref()), ("alt", alt.as_ref())],
        ),
        Phrasing::LinkReference { identifier, label, reference_type: kind, children } => object(
            "linkReference",
            &[
                ("identifier", identifier.as_str().into()),
                ("referenceType", reference_type(*kind)),
                ("children", phrasings(children)),
            ],
            &[("label", label.as_ref())],
        ),
        Phrasing::ImageReference { identifier, label, reference_type: kind, alt } => object(
            "imageReference",
            &[("identifier", identifier.as_str().into()), ("referenceType", reference_type(*kind))],
            &[("label", label.as_ref()), ("alt", alt.as_ref())],
        ),
        _ => Value::Null,
    }
}

fn number(n: f64) -> Value {
    serde_json::from_str(&js_number_to_string(n)).unwrap_or(Value::Null)
}

fn flow(node: &Flow) -> Value {
    match node {
        Flow::Paragraph { children } => {
            object("paragraph", &[("children", phrasings(children))], &[])
        }
        Flow::Heading { depth, children } => {
            object("heading", &[("depth", (*depth).into()), ("children", phrasings(children))], &[])
        }
        Flow::Blockquote { children } => {
            object("blockquote", &[("children", children.iter().map(flow).collect())], &[])
        }
        Flow::List { ordered, start, spread, children } => {
            let mut fields = vec![
                ("spread", Value::Bool(*spread)),
                ("children", children.iter().map(list_item).collect()),
            ];
            if let Some(ordered) = ordered {
                fields.push(("ordered", Value::Bool(*ordered)));
            }
            if let Some(start) = start {
                fields.push(("start", number(*start)));
            }
            object("list", &fields, &[])
        }
        Flow::Code { value, lang, meta } => object(
            "code",
            &[("value", value.as_str().into())],
            &[("lang", lang.as_ref()), ("meta", meta.as_ref())],
        ),
        Flow::Html { value } => object("html", &[("value", value.as_str().into())], &[]),
        Flow::ThematicBreak => object("thematicBreak", &[], &[]),
        Flow::Definition { identifier, label, url, title } => object(
            "definition",
            &[("identifier", identifier.as_str().into()), ("url", url.as_str().into())],
            &[("label", label.as_ref()), ("title", title.as_ref())],
        ),
        Flow::Table { align, children } => object(
            "table",
            &[
                ("align", align.iter().map(|a| alignment(*a)).collect()),
                ("children", children.iter().map(table_row).collect()),
            ],
            &[],
        ),
        Flow::Math { value, meta } => {
            object("math", &[("value", value.as_str().into())], &[("meta", meta.as_ref())])
        }
    }
}

fn alignment(align: Option<Align>) -> Value {
    match align {
        Some(Align::Left) => "left".into(),
        Some(Align::Right) => "right".into(),
        Some(Align::Center) => "center".into(),
        None => Value::Null,
    }
}

fn list_item(item: &ListItem) -> Value {
    object(
        "listItem",
        &[
            ("checked", item.checked.map_or(Value::Null, Value::Bool)),
            ("spread", Value::Bool(item.spread)),
            ("children", item.children.iter().map(flow).collect()),
        ],
        &[],
    )
}

fn table_row(row: &TableRow) -> Value {
    object("tableRow", &[("children", row.children.iter().map(table_cell).collect())], &[])
}

fn table_cell(cell: &TableCell) -> Value {
    object("tableCell", &[("children", phrasings(&cell.children))], &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(text: &str, aliases: &str) -> Value {
        let out: Value = serde_json::from_str(&markdown_model(text, aliases)).unwrap_or_default();
        assert_eq!(out[0], "ok", "{out}");
        out[1].clone()
    }

    #[test]
    fn a_list_keeps_its_nesting_and_its_unchecked_item_as_null() {
        let root = tree("1. a\n   - [ ] b\n", "");
        let list = &root["children"][0];
        assert_eq!(list["type"], "list");
        assert_eq!(list["ordered"], true);
        assert_eq!(list["start"], 1);
        let inner = &list["children"][0]["children"][1];
        assert_eq!(inner["type"], "list");
        assert_eq!(inner["children"][0]["checked"], false);
        assert_eq!(list["children"][0]["checked"], Value::Null);
    }

    #[test]
    fn a_table_carries_its_alignment_and_a_fence_its_language() {
        let root = tree("|a|b|\n|:-|-:|\n|1|2|\n\n```rs x\nfn\n```\n", "");
        assert_eq!(root["children"][0]["align"], json!(["left", "right"]));
        assert_eq!(root["children"][1]["lang"], "rs");
        assert_eq!(root["children"][1]["meta"], "x");
    }

    #[test]
    fn a_reference_is_text_until_an_alias_table_resolves_it() {
        let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let text = format!("[[a/b#d|c]] ![[{id}]]");
        let plain = tree(&text, "");
        assert_eq!(plain["children"][0]["children"][0]["type"], "text");
        let table = format!("{{\"a/b\":\"{id}\"}}");
        let resolved = tree(&text, &table);
        let kids = &resolved["children"][0]["children"];
        assert_eq!(kids[0]["type"], "wikiLink");
        assert_eq!(kids[0]["alias"], "c");
        assert_eq!(kids[0]["fragment"], "d");
        assert_eq!(kids[0]["documentId"], id);
        assert_eq!(kids[2]["type"], "embed");
    }

    #[test]
    fn an_alias_table_that_is_not_strings_is_refused() {
        assert_eq!(answer("x", "[1]"), json!(["refused", "aliases"]));
    }

    #[test]
    fn a_body_past_a_bound_is_refused_by_name() {
        let deep = format!("{}x", "> ".repeat(2000));
        assert_eq!(answer(&deep, "")[0], "refused");
    }
}
