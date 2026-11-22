//! Following a rename: repointing one document's references by a plan of old
//! alias to new target, from its content alone.
//!
//! What gets rewritten must equal what resolves, so the rewriter walks the
//! scanner the reader and the reference index use. A document the new paths
//! would carry past a text ceiling is refused WHOLE, before any edit exists,
//! rather than half-followed.

use crate::nodes::{with_node_file, with_node_text};
use crate::text_limit::{
    Breach, MARKDOWN_MAX_CHARS, NODE_TEXT_MAX_CHARS, ReferenceRewriteTooLarge, grows_past,
};
use crate::{DocumentContent, DocumentEdit};
use std::collections::BTreeMap;
use whiteboard_codec::references::find_next_reference;
use whiteboard_det::utf16;
use whiteboard_model::node_content::{node_file, node_text};
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};

/// `value` with every `[[target]]` or `![[target|label]]` whose target is a key
/// of `replacements` pointed at the mapped alias instead. Only the target
/// slice moves; the bang, brackets and label are kept byte for byte.
#[must_use]
pub fn rewrite_reference_targets(value: &str, replacements: &BTreeMap<String, String>) -> String {
    if replacements.is_empty() {
        return value.to_owned();
    }
    let mut out = String::new();
    let mut copied = 0;
    let mut cursor = 0;
    while let Some(found) = find_next_reference(value, cursor) {
        cursor = found.index.saturating_add(found.full.len());
        let Some(next) = replacements.get(found.target) else { continue };
        // The target starts after `[[`, and after the `!` when present.
        let start = found.index.saturating_add(if found.is_embed { 3 } else { 2 });
        out.push_str(value.get(copied..start).unwrap_or_default());
        out.push_str(next);
        copied = start.saturating_add(found.target.len());
    }
    out.push_str(value.get(copied..).unwrap_or_default());
    out
}

/// The nodes a rewrite changed: a text node's targets, or a file node whose
/// file IS an affected alias. Embed targets are document ids, which survive
/// both kinds of change, so embeds are never rewritten.
fn changed_nodes(canvas: &SpatialCanvas, plan: &BTreeMap<String, String>) -> Vec<SpatialNode> {
    let mut changed = Vec::new();
    for node in &canvas.nodes {
        if let Some(own) = node_text(node) {
            let text = rewrite_reference_targets(own, plan);
            if text != own {
                changed.push(with_node_text(node, &text));
            }
        } else if let Some(target) = node_file(node).and_then(|file| plan.get(file)) {
            changed.push(with_node_file(node, target));
        }
    }
    changed
}

/// Refuses the rewrite when any changed node's text grew past the node ceiling.
fn assert_nodes_fit(
    canvas: &SpatialCanvas,
    changed: &[SpatialNode],
) -> Result<(), ReferenceRewriteTooLarge> {
    for node in changed {
        let Some(after) = node_text(node) else { continue };
        let before = canvas
            .nodes
            .iter()
            .find(|held| held.id == node.id)
            .and_then(node_text)
            .map_or(0, utf16::len);
        let chars = utf16::len(after);
        if grows_past(NODE_TEXT_MAX_CHARS, before, chars) {
            return Err(ReferenceRewriteTooLarge {
                breach: Breach::NodeText { chars, node_id: node.id.clone() },
            });
        }
    }
    Ok(())
}

/// Plans repointing one document's references by `plan`. Answers the edit, or
/// none when nothing changed, so a keeper saves only what moved. Applying and
/// saving are the keeper's.
///
/// # Errors
///
/// [`ReferenceRewriteTooLarge`] when a new path carries the body or a node's
/// text past its ceiling.
pub fn plan_document_reference_rewrite(
    content: &DocumentContent<'_>,
    plan: &BTreeMap<String, String>,
) -> Result<Option<DocumentEdit>, ReferenceRewriteTooLarge> {
    match content {
        DocumentContent::Spatial(canvas) => {
            let changed = changed_nodes(canvas, plan);
            if changed.is_empty() {
                return Ok(None);
            }
            assert_nodes_fit(canvas, &changed)?;
            // Targeted node writes, never a whole-canvas resync: a reader
            // drops records the current schema cannot parse, and writing the
            // whole canvas back would DELETE them.
            Ok(Some(DocumentEdit::SpatialNodes(changed)))
        }
        DocumentContent::Markdown { body } => {
            let next = rewrite_reference_targets(body, plan);
            // Kept although a body naming a planned alias is one the rewrite
            // changes: a keeper that saved an unchanged document would report
            // it as updated.
            if next == *body {
                return Ok(None);
            }
            let chars = utf16::len(&next);
            if grows_past(MARKDOWN_MAX_CHARS, utf16::len(body), chars) {
                return Err(ReferenceRewriteTooLarge { breach: Breach::Body { chars } });
            }
            Ok(Some(DocumentEdit::MarkdownBody(next)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::rewrite_reference_targets;
    use std::collections::BTreeMap;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn only_the_target_slice_moves() {
        let plan = BTreeMap::from([("a".to_owned(), "x/y".to_owned())]);
        assert_eq!(
            rewrite_reference_targets("![[a#h|l]] [[b]] [[a]]é", &plan),
            "![[x/y#h|l]] [[b]] [[x/y]]é"
        );
        assert_eq!(rewrite_reference_targets("[[a]]", &BTreeMap::new()), "[[a]]");
    }
}
