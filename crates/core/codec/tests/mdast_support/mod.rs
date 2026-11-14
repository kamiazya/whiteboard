//! A model tree as the canonical text the TypeScript recorders digest
//! (`packages/codec/src/test-utils/mdast-oracle/oracle.ts`'s `canonical`):
//! JSON with every object's keys sorted and nothing absent written. The
//! recorded trees are written the same way, so a tree and a recording compare
//! as text and a difference reads as one.

use serde_json::{Map, Value, json};
use whiteboard_det::format::js_number_to_string;
use whiteboard_model::mdast::{
    Align, Flow, ListItem, Phrasing, ReferenceType, Root, TableCell, TableRow,
};

/// The canonical text of a tree.
pub(crate) fn canonical(root: &Root) -> String {
    canonical_json(&root_json(root))
}

/// The canonical text of a recorded tree.
pub(crate) fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// Written by hand rather than left to `serde_json`, whose map keeps insertion
/// order the moment any crate in the build asks for preserve-order.
fn write(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (n, key) in keys.into_iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write(&map[key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
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
