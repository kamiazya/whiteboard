//! A markdown-rs tree as the model tree the TypeScript hands the layout: what
//! `fromRemarkRoot` and `mdastRootSchema` make of remark's, written as the
//! canonical text the recorded oracle digests.
//!
//! Kept beside the oracle test rather than in the crate: nothing outside the
//! test reads the model tree yet.

use serde_json::{Map, Value, json};
use whiteboard_markdown::mdast::{AlignKind, Node, ReferenceKind};

/// How deep a converted tree nests before a container is flattened to its text.
const MAX_NESTING_DEPTH: usize = 64;

/// The canonical text of a parsed tree: keys sorted, nothing absent written.
pub(crate) fn canonical(root: &Node) -> String {
    let mut text = String::new();
    write_canonical(&to_model(root), &mut text);
    text
}

/// Written here rather than left to `serde_json`, whose map keeps insertion
/// order the moment any crate in the build asks for preserve-order.
fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
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
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

pub(crate) fn to_model(root: &Node) -> Value {
    let children = root.children().map_or_else(Vec::new, |c| flow_all(c, 1));
    json!({ "type": "root", "children": children })
}

fn flow_all(nodes: &[Node], depth: usize) -> Vec<Value> {
    nodes.iter().map(|n| flow_at(n, depth)).collect()
}

fn phrasing_all(nodes: &[Node], depth: usize) -> Vec<Value> {
    nodes.iter().map(|n| phrasing_at(n, depth)).collect()
}

/// The text of a subtree in document order.
fn flatten_text(node: &Node) -> String {
    let own = match node {
        Node::Text(x) => x.value.as_str(),
        Node::InlineCode(x) => x.value.as_str(),
        Node::InlineMath(x) => x.value.as_str(),
        Node::Html(x) => x.value.as_str(),
        Node::Code(x) => x.value.as_str(),
        Node::Math(x) => x.value.as_str(),
        _ => "",
    };
    let mut text = own.to_string();
    for child in node.children().into_iter().flatten() {
        text.push_str(&flatten_text(child));
    }
    text
}

fn too_deep(node: &Node, depth: usize) -> bool {
    depth >= MAX_NESTING_DEPTH && node.children().is_some()
}

fn text(value: &str) -> Value {
    json!({ "type": "text", "value": value })
}

fn put(object: &mut Map<String, Value>, key: &str, value: Option<&String>) {
    if let Some(value) = value {
        object.insert(key.to_string(), Value::String(value.clone()));
    }
}

fn kind(kind: ReferenceKind) -> &'static str {
    match kind {
        ReferenceKind::Shortcut => "shortcut",
        ReferenceKind::Collapsed => "collapsed",
        ReferenceKind::Full => "full",
    }
}

fn phrasing_at(node: &Node, depth: usize) -> Value {
    if too_deep(node, depth) {
        return text(&flatten_text(node));
    }
    let next = depth + 1;
    match node {
        Node::Text(x) => text(&x.value),
        Node::InlineCode(x) => json!({ "type": "inlineCode", "value": x.value }),
        Node::Break(_) => json!({ "type": "break" }),
        Node::Html(x) => json!({ "type": "html", "value": x.value }),
        Node::InlineMath(x) => json!({ "type": "inlineMath", "value": x.value }),
        Node::Emphasis(x) => {
            json!({ "type": "emphasis", "children": phrasing_all(&x.children, next) })
        }
        Node::Strong(x) => json!({ "type": "strong", "children": phrasing_all(&x.children, next) }),
        Node::Delete(x) => json!({ "type": "delete", "children": phrasing_all(&x.children, next) }),
        Node::Link(_) | Node::Image(_) | Node::LinkReference(_) | Node::ImageReference(_) => {
            media(node, next)
        }
        // The model has no footnote nodes; the marker stays as written.
        Node::FootnoteReference(x) => {
            text(&format!("[^{}]", x.label.as_ref().unwrap_or(&x.identifier)))
        }
        other => text(&flatten_text(other)),
    }
}

/// Links and images, written or by reference.
fn media(node: &Node, next: usize) -> Value {
    let mut o = Map::new();
    match node {
        Node::Link(x) => {
            o.insert("type".into(), "link".into());
            o.insert("url".into(), x.url.clone().into());
            put(&mut o, "title", x.title.as_ref());
            o.insert("children".into(), phrasing_all(&x.children, next).into());
        }
        Node::Image(x) => {
            o.insert("type".into(), "image".into());
            o.insert("url".into(), x.url.clone().into());
            put(&mut o, "title", x.title.as_ref());
            o.insert("alt".into(), x.alt.clone().into());
        }
        Node::LinkReference(x) => {
            reference(&mut o, "linkReference", &x.identifier, x.label.as_ref(), x.reference_kind);
            o.insert("children".into(), phrasing_all(&x.children, next).into());
        }
        Node::ImageReference(x) => {
            reference(&mut o, "imageReference", &x.identifier, x.label.as_ref(), x.reference_kind);
            o.insert("alt".into(), x.alt.clone().into());
        }
        _ => {}
    }
    Value::Object(o)
}

fn reference(
    o: &mut Map<String, Value>,
    name: &str,
    id: &str,
    label: Option<&String>,
    k: ReferenceKind,
) {
    o.insert("type".into(), name.into());
    o.insert("identifier".into(), id.into());
    put(o, "label", label);
    o.insert("referenceType".into(), kind(k).into());
}

fn flow_at(node: &Node, depth: usize) -> Value {
    if too_deep(node, depth) {
        return json!({ "type": "paragraph", "children": [text(&flatten_text(node))] });
    }
    let next = depth + 1;
    match node {
        Node::Paragraph(x) => {
            json!({ "type": "paragraph", "children": phrasing_all(&x.children, next) })
        }
        Node::Heading(x) => {
            json!({ "type": "heading", "depth": x.depth, "children": phrasing_all(&x.children, next) })
        }
        Node::Blockquote(x) => {
            json!({ "type": "blockquote", "children": flow_all(&x.children, next) })
        }
        Node::List(_) | Node::Table(_) => container(node, next),
        Node::Code(x) => {
            let mut o = Map::new();
            o.insert("type".into(), "code".into());
            o.insert("value".into(), x.value.clone().into());
            put(&mut o, "lang", x.lang.as_ref());
            put(&mut o, "meta", x.meta.as_ref());
            Value::Object(o)
        }
        Node::Html(x) => json!({ "type": "html", "value": x.value }),
        Node::ThematicBreak(_) => json!({ "type": "thematicBreak" }),
        Node::Definition(x) => {
            let mut o = Map::new();
            o.insert("type".into(), "definition".into());
            o.insert("identifier".into(), x.identifier.clone().into());
            put(&mut o, "label", x.label.as_ref());
            o.insert("url".into(), x.url.clone().into());
            put(&mut o, "title", x.title.as_ref());
            Value::Object(o)
        }
        Node::Math(x) => {
            let mut o = Map::new();
            o.insert("type".into(), "math".into());
            o.insert("value".into(), x.value.clone().into());
            put(&mut o, "meta", x.meta.as_ref());
            Value::Object(o)
        }
        Node::FootnoteDefinition(x) => footnote_definition(x, depth),
        other => json!({ "type": "paragraph", "children": [text(&flatten_text(other))] }),
    }
}

/// Lists and tables: the containers whose children are not flow.
fn container(node: &Node, next: usize) -> Value {
    match node {
        Node::List(x) => {
            let mut o = Map::new();
            o.insert("type".into(), "list".into());
            o.insert("ordered".into(), x.ordered.into());
            if let Some(start) = x.start {
                o.insert("start".into(), start.into());
            }
            o.insert("spread".into(), x.spread.into());
            let items: Vec<Value> = x.children.iter().map(|i| list_item(i, next)).collect();
            o.insert("children".into(), items.into());
            Value::Object(o)
        }
        Node::Table(x) => {
            let align: Vec<Value> = x
                .align
                .iter()
                .map(|a| match a {
                    AlignKind::Left => "left".into(),
                    AlignKind::Right => "right".into(),
                    AlignKind::Center => "center".into(),
                    AlignKind::None => Value::Null,
                })
                .collect();
            let rows: Vec<Value> = x.children.iter().map(|r| table_row(r, next)).collect();
            json!({ "type": "table", "align": align, "children": rows })
        }
        _ => Value::Null,
    }
}

/// A definition has no node of its own in the model: it reads as the
/// paragraph it was written as.
fn footnote_definition(
    node: &whiteboard_markdown::mdast::FootnoteDefinition,
    depth: usize,
) -> Value {
    let marker = format!("[^{}]: ", node.label.as_ref().unwrap_or(&node.identifier));
    let label = text(&marker);
    if let [Node::Paragraph(only)] = node.children.as_slice() {
        let mut children = vec![label];
        children.extend(phrasing_all(&only.children, depth + 2));
        return json!({ "type": "paragraph", "children": children });
    }
    let joined = node.children.iter().map(flatten_text).collect::<Vec<_>>().join(" ");
    json!({ "type": "paragraph", "children": [label, text(&joined)] })
}

fn list_item(node: &Node, depth: usize) -> Value {
    let Node::ListItem(item) = node else { return flow_at(node, depth) };
    let mut o = Map::new();
    o.insert("type".into(), "listItem".into());
    o.insert("checked".into(), item.checked.map_or(Value::Null, Value::Bool));
    o.insert("spread".into(), item.spread.into());
    o.insert("children".into(), flow_all(&item.children, depth + 1).into());
    Value::Object(o)
}

fn table_row(node: &Node, depth: usize) -> Value {
    let cells: Vec<Value> = node
        .children()
        .into_iter()
        .flatten()
        .map(|cell| {
            let inner = cell.children().map_or_else(Vec::new, |c| phrasing_all(c, depth + 2));
            json!({ "type": "tableCell", "children": inner })
        })
        .collect();
    json!({ "type": "tableRow", "children": cells })
}
