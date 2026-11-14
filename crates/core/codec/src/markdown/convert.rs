//! markdown-rs's tree as the model tree (`from-remark.ts`'s `fromRemarkRoot`):
//! what the model does not hold is dropped (positions) or written as text
//! (a footnote), and a tree nested past [`MAX_NESTING_DEPTH`] is flattened to
//! its text there, since every reader of the model tree recurses.

use whiteboard_markdown::mdast::{
    AlignKind, FootnoteDefinition, Image, ImageReference, Link, LinkReference, Node, ReferenceKind,
};
use whiteboard_model::mdast::{
    Align, Flow, ListItem, Phrasing, ReferenceType, Root, TableCell, TableRow,
};

/// How deep a converted tree may nest before a container is flattened to its
/// text (`MAX_NESTING_DEPTH`): markdown nests one level a character, and no
/// document a person reads nests anywhere near this.
const MAX_NESTING_DEPTH: usize = 64;

pub(super) fn root(tree: &Node) -> Root {
    Root { children: flows(children_of(tree), 1) }
}

fn children_of(node: &Node) -> &[Node] {
    node.children().map(Vec::as_slice).unwrap_or_default()
}

fn flows(nodes: &[Node], depth: usize) -> Vec<Flow> {
    nodes.iter().map(|n| flow_at(n, depth)).collect()
}

fn phrasings(nodes: &[Node], depth: usize) -> Vec<Phrasing> {
    nodes.iter().map(|n| phrasing_at(n, depth)).collect()
}

/// A node's own string (`value`), empty for a node without one.
fn own_value(node: &Node) -> &str {
    match node {
        Node::Text(x) => &x.value,
        Node::InlineCode(x) => &x.value,
        Node::InlineMath(x) => &x.value,
        Node::Html(x) => &x.value,
        Node::Code(x) => &x.value,
        Node::Math(x) => &x.value,
        _ => "",
    }
}

/// A subtree's text in document order, walked with a stack: the subtree being
/// flattened is by definition too deep to recurse over.
fn flatten_text(node: &Node) -> String {
    let mut text = String::new();
    let mut stack = vec![node];
    while let Some(next) = stack.pop() {
        text.push_str(own_value(next));
        stack.extend(children_of(next).iter().rev());
    }
    text
}

fn too_deep(node: &Node, depth: usize) -> bool {
    depth >= MAX_NESTING_DEPTH && node.children().is_some()
}

fn text(value: String) -> Phrasing {
    Phrasing::Text { value }
}

/// A footnote's marker as written: the model has no footnote nodes.
fn footnote_marker(label: Option<&String>, identifier: &str) -> String {
    format!("[^{}]", label.map_or(identifier, String::as_str))
}

fn phrasing_at(node: &Node, depth: usize) -> Phrasing {
    if too_deep(node, depth) {
        return text(flatten_text(node));
    }
    let next = depth.saturating_add(1);
    match node {
        Node::InlineCode(x) => Phrasing::InlineCode { value: x.value.clone() },
        Node::Break(_) => Phrasing::Break,
        Node::Html(x) => Phrasing::Html { value: x.value.clone() },
        Node::InlineMath(x) => Phrasing::InlineMath { value: x.value.clone() },
        Node::Emphasis(x) => Phrasing::Emphasis { children: phrasings(&x.children, next) },
        Node::Strong(x) => Phrasing::Strong { children: phrasings(&x.children, next) },
        Node::Delete(x) => Phrasing::Delete { children: phrasings(&x.children, next) },
        Node::FootnoteReference(x) => text(footnote_marker(x.label.as_ref(), &x.identifier)),
        Node::Link(x) => link(x, next),
        Node::Image(x) => image(x),
        Node::LinkReference(x) => link_reference(x, next),
        Node::ImageReference(x) => image_reference(x),
        // A text, and a kind the model does not hold, read as their own string.
        other => text(own_value(other).to_owned()),
    }
}

const fn reference_type(kind: ReferenceKind) -> ReferenceType {
    match kind {
        ReferenceKind::Shortcut => ReferenceType::Shortcut,
        ReferenceKind::Collapsed => ReferenceType::Collapsed,
        ReferenceKind::Full => ReferenceType::Full,
    }
}

fn link(x: &Link, next: usize) -> Phrasing {
    Phrasing::Link {
        url: x.url.clone(),
        title: x.title.clone(),
        children: phrasings(&x.children, next),
    }
}

fn image(x: &Image) -> Phrasing {
    Phrasing::Image { url: x.url.clone(), title: x.title.clone(), alt: Some(x.alt.clone()) }
}

fn link_reference(x: &LinkReference, next: usize) -> Phrasing {
    Phrasing::LinkReference {
        identifier: x.identifier.clone(),
        label: x.label.clone(),
        reference_type: reference_type(x.reference_kind),
        children: phrasings(&x.children, next),
    }
}

fn image_reference(x: &ImageReference) -> Phrasing {
    Phrasing::ImageReference {
        identifier: x.identifier.clone(),
        label: x.label.clone(),
        reference_type: reference_type(x.reference_kind),
        alt: Some(x.alt.clone()),
    }
}

fn flow_at(node: &Node, depth: usize) -> Flow {
    if too_deep(node, depth) {
        return Flow::Paragraph { children: vec![text(flatten_text(node))] };
    }
    let next = depth.saturating_add(1);
    match node {
        Node::Paragraph(x) => Flow::Paragraph { children: phrasings(&x.children, next) },
        Node::Heading(x) => {
            Flow::Heading { depth: x.depth, children: phrasings(&x.children, next) }
        }
        Node::Blockquote(x) => Flow::Blockquote { children: flows(&x.children, next) },
        Node::List(x) => Flow::List {
            ordered: Some(x.ordered),
            start: x.start.map(f64::from),
            spread: x.spread,
            children: x.children.iter().filter_map(|item| list_item(item, next)).collect(),
        },
        Node::Code(x) => {
            Flow::Code { value: x.value.clone(), lang: x.lang.clone(), meta: x.meta.clone() }
        }
        Node::Html(x) => Flow::Html { value: x.value.clone() },
        Node::ThematicBreak(_) => Flow::ThematicBreak,
        Node::Definition(x) => Flow::Definition {
            identifier: x.identifier.clone(),
            label: x.label.clone(),
            url: x.url.clone(),
            title: x.title.clone(),
        },
        Node::Table(x) => Flow::Table {
            align: x.align.iter().map(|a| align(*a)).collect(),
            children: x.children.iter().map(|row| table_row(row, next)).collect(),
        },
        Node::Math(x) => Flow::Math { value: x.value.clone(), meta: x.meta.clone() },
        Node::FootnoteDefinition(x) => footnote_definition(x, depth),
        other => Flow::Paragraph { children: vec![text(own_value(other).to_owned())] },
    }
}

const fn align(kind: AlignKind) -> Option<Align> {
    match kind {
        AlignKind::Left => Some(Align::Left),
        AlignKind::Right => Some(Align::Right),
        AlignKind::Center => Some(Align::Center),
        AlignKind::None => None,
    }
}

/// A footnote definition reads as the paragraph it was written as: its marker,
/// then one paragraph's own phrasing, or several blocks' text joined by spaces.
fn footnote_definition(node: &FootnoteDefinition, depth: usize) -> Flow {
    let marker = format!("{}: ", footnote_marker(node.label.as_ref(), &node.identifier));
    let mut children = vec![text(marker)];
    if let [Node::Paragraph(only)] = node.children.as_slice() {
        children.extend(phrasings(&only.children, depth.saturating_add(2)));
    } else {
        let blocks: Vec<String> = node.children.iter().map(flatten_text).collect();
        children.push(text(blocks.join(" ")));
    }
    Flow::Paragraph { children }
}

fn list_item(node: &Node, depth: usize) -> Option<ListItem> {
    let Node::ListItem(item) = node else { return None };
    Some(ListItem {
        checked: item.checked,
        spread: item.spread,
        children: flows(&item.children, depth.saturating_add(1)),
    })
}

fn table_row(node: &Node, depth: usize) -> TableRow {
    let cell =
        |c: &Node| TableCell { children: phrasings(children_of(c), depth.saturating_add(2)) };
    TableRow { children: children_of(node).iter().map(cell).collect() }
}
