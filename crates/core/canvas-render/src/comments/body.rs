//! A comment bubble's body (`layout/comment-body.ts` and the resolved collapse
//! in `layout/comments.ts`): the opening message typeset as markdown at the
//! node theme's metrics, wrapped at the bubble's width, and for a settled
//! thread cut to its first line, repainted with the resolved overlay's text and
//! followed by a small "Resolved" label.
//!
//! The metrics are the NODE theme's whatever theme the canvas wears: a
//! comment's prose is not a per-surface choice, so a bubble cannot pick up a
//! document's typography by reflex. The family and fill are still the label's,
//! as for a node's body.

use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_scene::{Appearance, BoundingBox, SceneNode, TextRunNode};

use crate::compose_node::{ComposeOptions, Degradation, MdastStyle, mdast_style_for};
use crate::measure::{FontDescriptor, FontStyle};
use crate::scene_extent::content_extent;
use crate::theme::markdown::MarkdownTheme;
use crate::typeset::{first_line_of_blocks, typeset_mdast_blocks};

/// The width a comment's prose wraps to: narrow, since a bubble that grows
/// with its text covers what it is about.
pub const COMMENT_TEXT_MAX_WIDTH_PX: f64 = 200.0;

const RESOLVED_LABEL: &str = "Resolved";
const RESOLVED_LABEL_FONT_PX: f64 = 11.0;
const RESOLVED_LABEL_GAP_PX: f64 = 2.0;

/// The literal text as the one paragraph a body that will not parse is drawn as.
fn literal_root(text: &str) -> Root {
    Root {
        children: vec![Flow::Paragraph {
            children: vec![Phrasing::Text { value: text.to_owned() }],
        }],
    }
}

/// A comment's markdown laid out at the origin, `max_width` wide
/// (`layoutCommentBody`). A body the host cannot parse is reported against the
/// comment's id and drawn as its literal text, so the comment stays on screen.
#[must_use]
pub fn layout_comment_body(
    id: &str,
    text: &str,
    max_width: f64,
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let host = options.layout.host;
    let root = host.parse_markdown(text).unwrap_or_else(|_| {
        host.degrade(Degradation::BodyParseFailed { node_id: id.to_owned() });
        literal_root(text)
    });
    let style = MdastStyle { theme: MarkdownTheme::node(), ..mdast_style_for(&options.node_box) };
    typeset_mdast_blocks(&root, &style.options(max_width, options)).nodes
}

fn paint_run(run: &mut TextRunNode, fill: &str) {
    let appearance = run.appearance.take().unwrap_or_default();
    run.appearance = Some(Appearance { fill: Some(fill.to_owned()), ..appearance });
}

/// Repaints every run under `nodes` with `fill` (`paintRuns`): a run itself,
/// the runs of a paragraph, heading or fence, and whatever a list item, quote,
/// resolved embed or group holds. A table's cells keep their own paint, as the
/// TypeScript's walk over `runs`, `children` and `items` leaves them.
pub(crate) fn paint_runs(nodes: &mut [SceneNode], fill: &str) {
    for node in nodes {
        match node {
            SceneNode::TextRun(run) => paint_run(run, fill),
            SceneNode::Paragraph(block) => block.runs.iter_mut().for_each(|r| paint_run(r, fill)),
            SceneNode::Heading(block) => block.runs.iter_mut().for_each(|r| paint_run(r, fill)),
            SceneNode::CodeBlock(block) => {
                block.runs.iter_mut().flatten().for_each(|r| paint_run(r, fill));
            }
            SceneNode::List(list) => {
                list.items.iter_mut().for_each(|item| paint_runs(&mut item.children, fill));
            }
            SceneNode::Blockquote(quote) => paint_runs(&mut quote.children, fill),
            SceneNode::EmbedResolved(embed) => paint_runs(&mut embed.children, fill),
            SceneNode::Group(group) => paint_runs(&mut group.children, fill),
            _ => {}
        }
    }
}

/// What a settled thread's bubble holds (`collapseResolvedBody`): its body cut
/// to the first line, then "Resolved" under it, both painted by the overlay's
/// `text` and by nothing else.
#[must_use]
pub fn collapse_resolved_body(
    nodes: &[SceneNode],
    text: Option<&Appearance>,
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let mut body = first_line_of_blocks(nodes).nodes;
    if let Some(fill) = text.and_then(|t| t.fill.as_deref()) {
        paint_runs(&mut body, fill);
    }
    let bottom = content_extent(&body).bottom;
    let font = FontDescriptor {
        family: text.and_then(|t| t.font_family.clone()).unwrap_or_else(|| "sans-serif".to_owned()),
        fallback_chain: Vec::new(),
        weight: 400.0,
        style: FontStyle::Normal,
        size_px: RESOLVED_LABEL_FONT_PX,
    };
    let metrics = options.node_box.measure.measure(RESOLVED_LABEL, &font);
    let y = bottom + RESOLVED_LABEL_GAP_PX;
    body.push(SceneNode::TextRun(Box::new(TextRunNode {
        bbox: BoundingBox {
            x: 0.0,
            y,
            w: metrics.advance_width,
            h: metrics.ascent + metrics.descent,
        },
        baseline: Some(metrics.ascent),
        text: RESOLVED_LABEL.to_owned(),
        appearance: text
            .map(|t| Appearance { font_size: Some(RESOLVED_LABEL_FONT_PX), ..t.clone() }),
        ..crate::typeset::empty_run()
    })));
    body
}

#[cfg(test)]
mod tests {
    use super::paint_runs;
    use whiteboard_scene::{Appearance, BoundingBox, EmbedResolvedNode, GroupSceneNode, SceneNode};

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn run(fill: Option<&str>) -> SceneNode {
        SceneNode::TextRun(Box::new(whiteboard_scene::TextRunNode {
            appearance: fill
                .map(|f| Appearance { fill: Some(f.to_owned()), ..Appearance::default() }),
            ..crate::typeset::empty_run()
        }))
    }

    fn fills(node: &SceneNode) -> Vec<Option<String>> {
        let children = match node {
            SceneNode::Group(group) => &group.children,
            SceneNode::EmbedResolved(embed) => &embed.children,
            other => return vec![Some(format!("{other:?}"))],
        };
        children
            .iter()
            .map(|child| match child {
                SceneNode::TextRun(r) => r.appearance.as_ref().and_then(|a| a.fill.clone()),
                _ => None,
            })
            .collect()
    }

    /// A body cut from a resolved embed or a group (which no comment in the
    /// recording draws) is repainted through to its runs, as `paintRuns` walks
    /// any `children`; a run with no paint of its own gains the fill alone.
    #[test]
    fn a_group_and_a_resolved_embed_are_repainted_through_to_their_runs() {
        let bbox = BoundingBox { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
        let mut nodes = vec![
            SceneNode::Group(GroupSceneNode {
                bbox,
                label: None,
                children: vec![run(Some("#000")), run(None)],
            }),
            SceneNode::EmbedResolved(EmbedResolvedNode {
                bbox,
                document_id: "d".to_owned(),
                children: vec![run(None)],
            }),
        ];
        paint_runs(&mut nodes, "#abc");
        let want = Some("#abc".to_owned());
        assert_eq!(
            nodes.iter().map(fills).collect::<Vec<_>>(),
            [vec![want.clone(), want.clone()], vec![want]]
        );
    }
}
