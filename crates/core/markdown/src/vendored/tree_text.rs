//! Small readings of a built tree that the compiler asks for: what an image's
//! alt text counts, what a link may hold, and the edges of code text.

use crate::vendored::mdast::Node;
use alloc::{string::String, vec::Vec};

/// The text of a node with an image's alt text counted, as an image's own alt is made.
pub(crate) fn text_with_alt(node: &Node) -> String {
    match node {
        Node::Image(x) => x.alt.clone(),
        Node::ImageReference(x) => x.alt.clone(),
        other => match other.children() {
            Some(children) => children.iter().map(text_with_alt).collect(),
            None => other.to_string(),
        },
    }
}

/// What a link may hold: a link inside one (a GFM literal autolink the
/// tokenizer found in its text) is its text, as `CommonMark` has it.
pub(crate) fn unlink(children: Vec<Node>) -> Vec<Node> {
    let mut out = Vec::with_capacity(children.len());
    for mut child in children {
        if let Node::Link(inner) = child {
            out.extend(unlink(inner.children));
            continue;
        }
        if let Some(grand) = child.children_mut() {
            *grand = unlink(core::mem::take(grand));
        }
        out.push(child);
    }
    out
}

/// How many bytes of whitespace open `value` as one unit: a space or one line ending.
pub(crate) fn edge_start(value: &str) -> usize {
    if value.starts_with("\r\n") { 2 } else { usize::from(value.starts_with([' ', '\n', '\r'])) }
}

/// How many bytes of whitespace close `value` as one unit.
pub(crate) fn edge_end(value: &str) -> usize {
    if value.ends_with("\r\n") { 2 } else { usize::from(value.ends_with([' ', '\n', '\r'])) }
}
