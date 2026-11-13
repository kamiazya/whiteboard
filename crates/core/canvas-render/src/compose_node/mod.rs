//! How ONE node is drawn and filled (`layout/compose-node.ts`): the text body,
//! the frame with its background, the link card, the lock badge, and
//! [`compose_node`], which chooses between them by the node's kind.
//!
//! What the composer knows and this crate does not is asked through
//! [`ComposeHost`]: the body parser with its reference resolution, a reference's
//! resolution, the comment layer's passage highlights, and a file node's
//! representations. Each is a seam rather than a port because the code that
//! answers it lives in another layer (the markdown parser, the keeper) or has
//! not been ported yet; the replay answers it from the recording.

mod frame;
mod text;

use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::{BackgroundStyle, SpatialNode};
use whiteboard_scene::{Appearance, BoundingBox, IconSceneNode, SceneNode};

use crate::node_box::{
    LabelPlace, NodeBoxOptions, ResolvedReference, chrome_shape, label_of, label_runs,
};
use crate::node_content::{NodeKind, node_kind};
use crate::typeset::{
    CanvasMiniature, CodeTokenizer, DiagramRenderer, EmbedResolver, FittedBlocks, InlineSeams,
    MathRenderer, NestedLayoutBudget,
};

pub use text::{MdastStyle, mdast_style_for};

/// What a composer reports instead of failing: the scene still holds something
/// for the node, only less than it asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Degradation {
    /// The body did not parse, so it is drawn as one literal line.
    BodyParseFailed { node_id: String },
    /// Nothing claims the node's resource; the chrome is drawn alone.
    UnknownNodeKind { node_id: String, media_type: String },
    /// Tiling needs the picture's own size, which layout never has; it is
    /// drawn to cover the frame instead.
    UnsupportedBackgroundStyle { node_id: String, style: BackgroundStyle },
}

/// A body the host's parser could not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseFailed;

/// What the composer asks of the layer it runs in.
pub trait ComposeHost {
    /// A text node's markdown parsed (`parseBody`), its `[[alias]]` references
    /// resolved to documents (`resolveReferences`).
    fn parse_body(&self, text: &str) -> Result<Root, ParseFailed>;

    /// What a reference resolves to (`referenceFor`); a resolver that fails
    /// answers `None`.
    fn resolve_reference(&self, reference: &str) -> Option<ResolvedReference>;

    /// The comment layer's highlights behind a text node's laid-out body, in
    /// the body's own coordinates.
    fn passage_highlights(
        &self,
        node: &SpatialNode,
        text: &str,
        body: &FittedBlocks,
    ) -> Vec<SceneNode>;

    /// A file node drawn as its best representation (`composeFileNode`).
    fn compose_file_node(&self, node: &SpatialNode, options: &ComposeOptions<'_>)
    -> Vec<SceneNode>;

    /// The editor overlay owns this node's text, so only its chrome is drawn.
    fn body_suppressed(&self, node_id: &str) -> bool;

    fn locked(&self, node_id: &str) -> bool;

    /// The frame holds nothing, so it is tinted to read as a region.
    fn empty_frame(&self, node_id: &str) -> bool;

    fn degrade(&self, event: Degradation);
}

/// Laid-out bodies kept across renders (`SpatialContentCache`). A value is
/// origin-relative, so a node that only moved is answered from it.
pub trait ContentCache {
    fn get(&self, key: &str) -> Option<FittedBlocks>;
    fn set(&self, key: &str, body: &FittedBlocks);
}

/// The typesetter's seams a body is laid out with, forwarded as they are: a
/// body is a body, whichever surface lays it out.
#[derive(Clone, Copy)]
pub struct BodySeams<'a> {
    pub inline: &'a dyn InlineSeams,
    pub highlight: Option<&'a dyn CodeTokenizer>,
    pub math: Option<&'a dyn MathRenderer>,
    pub diagram: Option<&'a dyn DiagramRenderer>,
    pub embeds: Option<&'a dyn EmbedResolver>,
    pub canvas_layout: Option<&'a dyn CanvasMiniature>,
}

/// What the composer hands each node.
#[derive(Clone, Copy)]
pub struct ComposeOptions<'a> {
    pub node_box: NodeBoxOptions<'a>,
    /// The id of the theme in force, which the cache key carries: a family
    /// alone does not tell two themes apart.
    pub theme_id: Option<&'a str>,
    pub host: &'a dyn ComposeHost,
    pub content_cache: Option<&'a dyn ContentCache>,
    pub body: BodySeams<'a>,
    pub budget: &'a NestedLayoutBudget,
    /// The documents being laid out around this canvas, outermost first.
    pub embed_path: &'a [String],
    /// How deep in embeds this canvas is; the top-level canvas is 0.
    pub embed_depth: usize,
}

/// Side of the padlock, and its inset from the node's top-right corner.
const LOCK_BADGE_PX: f64 = 12.0;
const LOCK_BADGE_INSET_PX: f64 = 4.0;

/// The padlock in the corner of a locked node's box, painted with the node's
/// own stroke. Top-level canvas only: inside a miniature it would mark
/// something the reader cannot lock from there.
fn lock_badge(node: &SpatialNode, options: &ComposeOptions<'_>) -> Option<SceneNode> {
    if options.embed_depth > 0 || !options.host.locked(&node.id) {
        return None;
    }
    let resolved = options.node_box.appearance.resolve_node(node);
    let stroke = resolved.appearance.and_then(|appearance| appearance.stroke);
    Some(SceneNode::Icon(IconSceneNode {
        bbox: BoundingBox {
            x: node.x + node.width - LOCK_BADGE_INSET_PX - LOCK_BADGE_PX,
            y: node.y + LOCK_BADGE_INSET_PX,
            w: LOCK_BADGE_PX,
            h: LOCK_BADGE_PX,
        },
        icon: "lock".to_owned(),
        appearance: stroke
            .map(|stroke| Appearance { stroke: Some(stroke), ..Appearance::default() }),
    }))
}

fn chrome(node: &SpatialNode, options: &NodeBoxOptions<'_>) -> SceneNode {
    SceneNode::Shape(Box::new(chrome_shape(node, options)))
}

fn compose_link_node(node: &SpatialNode, options: &NodeBoxOptions<'_>) -> Vec<SceneNode> {
    let mut drawn = vec![chrome(node, options)];
    drawn.extend(label_runs(node, label_of(node, None).as_deref(), LabelPlace::Inside, options));
    drawn
}

/// What the node's kind draws. A resource nothing claims is drawn as its chrome
/// alone, and reported with its media type.
fn compose_node_content(node: &SpatialNode, options: &ComposeOptions<'_>) -> Vec<SceneNode> {
    match node_kind(node) {
        Some(NodeKind::Text) => text::compose_text_node(node, options),
        Some(NodeKind::Frame) => frame::compose_frame_node(node, options),
        Some(NodeKind::Link) => compose_link_node(node, &options.node_box),
        Some(NodeKind::File) => options.host.compose_file_node(node, options),
        None => {
            options.host.degrade(Degradation::UnknownNodeKind {
                node_id: node.id.clone(),
                media_type: node
                    .resource
                    .as_ref()
                    .map_or_else(|| "none".to_owned(), |r| r.mime_type.clone()),
            });
            vec![chrome(node, &options.node_box)]
        }
    }
}

/// One node: what its kind draws, then the lock badge.
#[must_use]
pub fn compose_node(node: &SpatialNode, options: &ComposeOptions<'_>) -> Vec<SceneNode> {
    let mut drawn = compose_node_content(node, options);
    drawn.extend(lock_badge(node, options));
    drawn
}
