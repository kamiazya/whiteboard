//! Planning the turn of a document's unlinked mentions of another into links,
//! from its content alone. Applying and saving are the keeper's.
//!
//! A markdown body is edited by targeted splices, so a concurrent edit
//! elsewhere in it merges instead of being clobbered. A canvas rewrites TEXT
//! NODES only: a `[[link]]` in a label renders as literal brackets, so labels
//! are mention-detected and never rewritten.

use crate::markup::{ReferenceSubject, document_reference_markup};
use crate::mentions::{Span, UnlinkedNameSpans, unlinked_name_spans};
use crate::nodes::with_node_text;
use crate::text_limit::{
    Breach, MARKDOWN_MAX_CHARS, NODE_TEXT_MAX_CHARS, ReferenceRewriteTooLarge, grows_past,
};
use crate::{DocumentContent, DocumentEdit, Splice};
use whiteboard_det::utf16;
use whiteboard_model::node_content::node_text;
use whiteboard_model::spatial::SpatialCanvas;

/// The document a mention names, as a listing knows it.
#[derive(Debug, Clone, Copy)]
pub struct LinkifyTarget<'a> {
    pub document_id: &'a str,
    pub path: &'a str,
    /// A document with no display name is named nowhere in prose.
    pub name: &'a str,
}

/// What linking would do to one document.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkifyPlan {
    pub linked: usize,
    /// None when there is nothing to link, so a keeper writes and saves nothing.
    pub edit: Option<DocumentEdit>,
}

/// How a mention of `target` is written: its name as the label of a reference
/// the writer spells, so a name the reader could not read inside the brackets
/// falls back to the bare reference, which the renderer labels with that name.
fn link_markup_for(target: &LinkifyTarget<'_>) -> String {
    document_reference_markup(
        &ReferenceSubject { id: target.document_id, path: target.path, name: Some(target.name) },
        Some(target.name),
    )
}

/// The length of `text` once `count` mentions are each replaced by the markup;
/// each link is longer than the name it replaces, but a name longer than its
/// markup is answered too.
fn grown_length(text: &str, count: usize, markup: &str, name: &str) -> usize {
    count
        .saturating_mul(utf16::len(markup))
        .saturating_add(utf16::len(text))
        .saturating_sub(count.saturating_mul(utf16::len(name)))
}

/// `text` with each span replaced by `markup`, in one forward pass, so a node
/// with many mentions costs its length rather than its length per mention.
fn spliced(text: &str, spans: &[Span], markup: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    for span in spans {
        out.push_str(text.get(from..span.byte_index).unwrap_or_default());
        out.push_str(markup);
        from = span.byte_index.saturating_add(span.byte_length);
    }
    out.push_str(text.get(from..).unwrap_or_default());
    out
}

fn plan_body(
    body: &str,
    target: &LinkifyTarget<'_>,
    markup: &str,
) -> Result<LinkifyPlan, ReferenceRewriteTooLarge> {
    let spans = unlinked_name_spans(body, target.name);
    let grown = grown_length(body, spans.len(), markup, target.name);
    if grows_past(MARKDOWN_MAX_CHARS, utf16::len(body), grown) {
        return Err(ReferenceRewriteTooLarge { breach: Breach::Body { chars: grown } });
    }
    if spans.is_empty() {
        return Ok(LinkifyPlan { linked: 0, edit: None });
    }
    let runs = spans
        .iter()
        .rev()
        .map(|span| Splice { index: span.index, remove: span.length, insert: markup.to_owned() })
        .collect();
    Ok(LinkifyPlan { linked: spans.len(), edit: Some(DocumentEdit::MarkdownSplices(runs)) })
}

fn plan_canvas(
    canvas: &SpatialCanvas,
    target: &LinkifyTarget<'_>,
    markup: &str,
) -> Result<LinkifyPlan, ReferenceRewriteTooLarge> {
    let mut linked: usize = 0;
    let mut nodes = Vec::with_capacity(canvas.nodes.len());
    for node in &canvas.nodes {
        let Some(text) = node_text(node) else {
            nodes.push(node.clone());
            continue;
        };
        let spans: Vec<Span> = UnlinkedNameSpans::new(text, target.name).collect();
        if spans.is_empty() {
            nodes.push(node.clone());
            continue;
        }
        // Judged from the span count before anything is built, as the body is.
        let grown = grown_length(text, spans.len(), markup, target.name);
        if grows_past(NODE_TEXT_MAX_CHARS, utf16::len(text), grown) {
            return Err(ReferenceRewriteTooLarge {
                breach: Breach::NodeText { chars: grown, node_id: node.id.clone() },
            });
        }
        linked = linked.saturating_add(spans.len());
        nodes.push(with_node_text(node, &spliced(text, &spans, markup)));
    }
    if linked == 0 {
        return Ok(LinkifyPlan { linked: 0, edit: None });
    }
    // The canvas is planned as a visible diff against the one that was read,
    // so only the rewritten nodes are touched: lines, tags, facets and
    // comments are not this operation's to change.
    let after = SpatialCanvas { nodes, ..canvas.clone() };
    Ok(LinkifyPlan {
        linked,
        edit: Some(DocumentEdit::SpatialCanvas {
            before: Box::new(canvas.clone()),
            after: Box::new(after),
        }),
    })
}

/// Plans turning `content`'s unlinked mentions of `target` into links.
///
/// # Errors
///
/// [`ReferenceRewriteTooLarge`] when linking would carry the body or a node
/// past the ceiling every other write to it is held to, before any plan exists.
pub fn plan_linkify_mentions(
    content: &DocumentContent<'_>,
    target: &LinkifyTarget<'_>,
) -> Result<LinkifyPlan, ReferenceRewriteTooLarge> {
    let markup = link_markup_for(target);
    match content {
        DocumentContent::Markdown { body } => plan_body(body, target, &markup),
        DocumentContent::Spatial(canvas) => plan_canvas(canvas, target, &markup),
    }
}

#[cfg(test)]
mod tests {
    use super::{LinkifyTarget, plan_linkify_mentions};
    use crate::{DocumentContent, DocumentEdit};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn mentions_are_spliced_from_the_end_so_each_is_on_the_original_offsets() {
        let target = LinkifyTarget { document_id: "id", path: "p", name: "Plan" };
        let plan =
            plan_linkify_mentions(&DocumentContent::Markdown { body: "Plan, Plan" }, &target)
                .expect("a plan");
        let Some(DocumentEdit::MarkdownSplices(runs)) = plan.edit else { panic!("splices") };
        assert_eq!(plan.linked, 2);
        assert_eq!(runs.iter().map(|r| r.index).collect::<Vec<_>>(), [6, 0]);
        assert_eq!(runs.first().map(|r| r.insert.as_str()), Some("[[p|Plan]]"));
    }
}
