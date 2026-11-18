//! What a markdown body SAYS as one line of plain text: the annotation rail's
//! row summary (`apps/web`'s `commentExcerpt`).
//!
//! It walks the parsed tree and not a laid-out one, because layout puts the
//! space between two words in an x offset: `**tighten** this` lays out as the
//! runs `tighten` and `this`, which joined read `tightenthis`.

use whiteboard_model::mdast::{Flow, ListItem, Phrasing, TableRow};

use super::parse_markdown_body;

/// The text of `text`: every value the tree carries, an image's non-empty
/// `alt`, one space after each block (paragraph, heading, list item, quote,
/// code fence, table and its rows, thematic break) and none between inline
/// nodes (`a**b**c` is one word), whitespace runs collapsed and the ends
/// trimmed.
///
/// A text past the parser's bounds answers its own trimmed source: a worse
/// summary than the rendering and a better one than nothing.
#[must_use]
pub fn markdown_excerpt(text: &str) -> String {
    let Ok(root) = parse_markdown_body(text) else {
        return js_trim(text).to_owned();
    };
    let mut out = String::new();
    for block in &root.children {
        flow(block, &mut out);
    }
    collapse(&out)
}

fn flow(node: &Flow, out: &mut String) {
    match node {
        Flow::Paragraph { children } | Flow::Heading { children, .. } => {
            phrasings(children, out);
            out.push(' ');
        }
        Flow::Blockquote { children } => {
            for child in children {
                flow(child, out);
            }
            out.push(' ');
        }
        Flow::List { children, .. } => {
            for item in children {
                list_item(item, out);
            }
        }
        Flow::Code { value, .. } => {
            out.push_str(value);
            out.push(' ');
        }
        // Valued, but not a block the rail separates.
        Flow::Html { value } | Flow::Math { value, .. } => out.push_str(value),
        Flow::ThematicBreak => out.push(' '),
        Flow::Definition { .. } => {}
        Flow::Table { children, .. } => {
            for row in children {
                table_row(row, out);
            }
            out.push(' ');
        }
    }
}

fn list_item(item: &ListItem, out: &mut String) {
    for child in &item.children {
        flow(child, out);
    }
    out.push(' ');
}

fn table_row(row: &TableRow, out: &mut String) {
    // A cell is not a block: its neighbour's text follows it directly.
    for cell in &row.children {
        phrasings(&cell.children, out);
    }
    out.push(' ');
}

fn phrasings(nodes: &[Phrasing], out: &mut String) {
    for node in nodes {
        match node {
            Phrasing::Text { value }
            | Phrasing::InlineCode { value }
            | Phrasing::Html { value }
            | Phrasing::InlineMath { value } => out.push_str(value),
            Phrasing::Emphasis { children }
            | Phrasing::Strong { children }
            | Phrasing::Delete { children }
            | Phrasing::Link { children, .. }
            | Phrasing::LinkReference { children, .. } => phrasings(children, out),
            Phrasing::Image { alt: Some(alt), .. } => out.push_str(alt),
            // The parser produces none of these: the wiki syntax is read in a
            // later pass. An image reference's alt is not carried, as before.
            Phrasing::Break
            | Phrasing::Image { alt: None, .. }
            | Phrasing::ImageReference { .. }
            | Phrasing::WikiLink { .. }
            | Phrasing::Embed { .. } => {}
        }
    }
}

/// `String.prototype.trim`'s and `\s`'s set: Unicode `White_Space` less U+0085,
/// plus the byte order mark.
fn is_js_space(c: char) -> bool {
    c != '\u{85}' && (c.is_whitespace() || c == '\u{feff}')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// Runs of whitespace as one space, the ends trimmed.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending = false;
    for c in text.chars() {
        if is_js_space(c) {
            pending = !out.is_empty();
        } else {
            if pending {
                out.push(' ');
                pending = false;
            }
            out.push(c);
        }
    }
    out
}
