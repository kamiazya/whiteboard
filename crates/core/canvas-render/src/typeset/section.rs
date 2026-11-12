//! A markdown section by heading, ported from `mdast-section.ts`: the heading
//! whose text is the fragment, case-folded when no heading matches exactly, and
//! everything under it up to the next heading of the same or a shallower depth.

use whiteboard_model::mdast::{Flow, Phrasing, Root};

use super::text::{trim_end, trim_start};

fn plain_text(children: &[Phrasing]) -> String {
    let mut text = String::new();
    for child in children {
        match child {
            Phrasing::Text { value }
            | Phrasing::InlineCode { value }
            | Phrasing::Html { value }
            | Phrasing::InlineMath { value } => text.push_str(value),
            Phrasing::Emphasis { children }
            | Phrasing::Strong { children }
            | Phrasing::Delete { children }
            | Phrasing::Link { children, .. }
            | Phrasing::LinkReference { children, .. } => text.push_str(&plain_text(children)),
            _ => {}
        }
    }
    text
}

/// The part of `root` the fragment names, or `None` when no heading does.
#[must_use]
pub fn select_markdown_section(root: &Root, fragment: &str) -> Option<Root> {
    let wanted = trim_start(trim_end(fragment));
    if wanted.is_empty() {
        return None;
    }
    let texts: Vec<Option<String>> = root
        .children
        .iter()
        .map(|child| match child {
            Flow::Heading { children, .. } => {
                Some(trim_start(trim_end(&plain_text(children))).to_owned())
            }
            _ => None,
        })
        .collect();
    let exact = texts.iter().position(|t| t.as_deref() == Some(wanted));
    let start = exact.or_else(|| {
        let folded = wanted.to_lowercase();
        texts.iter().position(|t| t.as_ref().is_some_and(|t| t.to_lowercase() == folded))
    })?;
    let Some(Flow::Heading { depth, .. }) = root.children.get(start) else { return None };
    let after = root.children.get(start.saturating_add(1)..).unwrap_or_default();
    let length = after
        .iter()
        .position(|c| matches!(c, Flow::Heading { depth: d, .. } if d <= depth))
        .unwrap_or(after.len());
    let end = start.saturating_add(1).saturating_add(length);
    Some(Root { children: root.children.get(start..end).unwrap_or_default().to_vec() })
}
