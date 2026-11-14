//! The file node: what its reference resolves to, drawn as the first
//! representation in rank order that has something to show (the picture, the
//! canvas, the document's body, the facet card), and its label when none does.
//! Each rank answers none for "nothing to show here", which is the common case
//! rather than an error, so nothing is reported.

use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{BoundingBox, ImageSceneNode, SceneNode};

use super::{ComposeOptions, chrome, mdast_style_for};
use crate::node_box::{
    FacetCard, LabelPlace, ResolvedReference, chrome_with_fit, content_box_height, content_width,
    fit_scene_in_node, js_trim, label_of, label_runs, place_in_node,
};
use crate::typeset::{FittedBlocks, typeset_mdast_blocks};
use whiteboard_model::node_content::node_file;

/// A body typeset at the node's content width and cut to its box. A box with no
/// room is refused before anything is measured; a box that is not fitted has
/// nothing to be degenerate against.
#[must_use]
pub fn fit_body_in_node(
    node: &SpatialNode,
    root: &Root,
    options: &ComposeOptions<'_>,
) -> Option<FittedBlocks> {
    let nb = &options.node_box;
    if nb.fit_to_box && content_box_height(node, nb).is_none() {
        return None;
    }
    let style = mdast_style_for(nb);
    let laid = typeset_mdast_blocks(root, &style.options(content_width(node, nb), options));
    fit_scene_in_node(&laid.nodes, node, nb)
}

fn fitted_chrome(
    node: &SpatialNode,
    options: &ComposeOptions<'_>,
    body: &FittedBlocks,
) -> SceneNode {
    let shape = chrome_with_fit(node, &options.node_box, body.truncated, body.overflows);
    SceneNode::Shape(Box::new(shape))
}

/// The picture filling the padded box, its aspect kept by the backend, and no
/// label: the name would lie over the picture, and its alt text travels on it.
fn file_image(
    node: &SpatialNode,
    resolved: Option<&ResolvedReference>,
    options: &ComposeOptions<'_>,
) -> Option<Vec<SceneNode>> {
    let image = resolved?.image.as_ref()?;
    let padding = options.node_box.geometry.padding_px;
    let w = node.width - 2.0 * padding;
    let h = node.height - 2.0 * padding;
    if !(w > 0.0 && h > 0.0) {
        return None;
    }
    let picture = SceneNode::Image(ImageSceneNode {
        bbox: BoundingBox { x: node.x + padding, y: node.y + padding, w, h },
        href: image.href.clone(),
        alt: image.alt.clone(),
        fit: None,
    });
    Some(vec![chrome(node, &options.node_box), picture])
}

/// The referenced canvas in miniature, its name above the frame.
fn file_embed(
    node: &SpatialNode,
    resolved: Option<&ResolvedReference>,
    options: &ComposeOptions<'_>,
) -> Option<Vec<SceneNode>> {
    let embed = super::embed::compose_file_embed(node, resolved, options)?;
    let nb = &options.node_box;
    let mut drawn = vec![chrome(node, nb)];
    drawn.extend(label_runs(node, label_of(node, resolved).as_deref(), LabelPlace::Above, nb));
    drawn.push(embed);
    Some(drawn)
}

/// The referenced document's own body inside the node, its name above the
/// frame as the canvas embed's is: both turn the node into a container showing
/// another document, so they read alike.
fn file_markdown(
    node: &SpatialNode,
    resolved: Option<&ResolvedReference>,
    options: &ComposeOptions<'_>,
) -> Option<Vec<SceneNode>> {
    let root = resolved?.markdown.as_ref()?;
    let body = fit_body_in_node(node, root, options)?;
    let nb = &options.node_box;
    let mut drawn = vec![fitted_chrome(node, options, &body)];
    drawn.extend(label_runs(node, label_of(node, resolved).as_deref(), LabelPlace::Above, nb));
    drawn.extend(place_in_node(node, &body.nodes, nb));
    Some(drawn)
}

fn text(value: String) -> Phrasing {
    Phrasing::Text { value }
}

/// The card as a body: a bare heading, then a `label: value` paragraph per row.
/// Headings and paragraphs only, so nothing in it carries its own transform.
/// None when neither the title nor any row has more than whitespace.
fn card_body(card: &FacetCard) -> Option<Root> {
    let title = card.title.as_deref().filter(|title| !js_trim(title).is_empty());
    let mut children: Vec<Flow> = title
        .map(|title| Flow::Heading { depth: 3, children: vec![text(title.to_owned())] })
        .into_iter()
        .collect();
    children.extend(
        card.rows
            .iter()
            .filter(|row| !js_trim(&row.label).is_empty() || !js_trim(&row.value).is_empty())
            .map(|row| Flow::Paragraph {
                children: vec![
                    Phrasing::Strong { children: vec![text(row.label.clone())] },
                    text(format!(": {}", row.value)),
                ],
            }),
    );
    (!children.is_empty()).then_some(Root { children })
}

/// The facet card laid out as a body, through the one typesetter every body
/// takes.
fn file_facets(
    node: &SpatialNode,
    resolved: Option<&ResolvedReference>,
    options: &ComposeOptions<'_>,
) -> Option<Vec<SceneNode>> {
    let root = card_body(resolved?.facets.as_ref()?)?;
    let body = fit_body_in_node(node, &root, options)?;
    let mut drawn = vec![fitted_chrome(node, options, &body)];
    drawn.extend(place_in_node(node, &body.nodes, &options.node_box));
    Some(drawn)
}

/// A file node: its reference resolved once, then each representation in rank
/// order until one draws; none drawing leaves the chrome and the label inside.
pub(super) fn compose_file_node(
    node: &SpatialNode,
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let resolved = node_file(node).and_then(|file| options.layout.host.resolve_reference(file));
    let resolved = resolved.as_ref();
    file_image(node, resolved, options)
        .or_else(|| file_embed(node, resolved, options))
        .or_else(|| file_markdown(node, resolved, options))
        .or_else(|| file_facets(node, resolved, options))
        .unwrap_or_else(|| {
            let nb = &options.node_box;
            let mut drawn = vec![chrome(node, nb)];
            drawn.extend(label_runs(
                node,
                label_of(node, resolved).as_deref(),
                LabelPlace::Inside,
                nb,
            ));
            drawn
        })
}
