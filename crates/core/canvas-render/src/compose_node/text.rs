//! The text node: its chrome and its markdown body, laid out at the node's
//! content width, cut to its box, and kept in the content cache.

use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::SceneNode;

use super::{ComposeOptions, Degradation};
use crate::node_box::{
    NodeBoxOptions, chrome_shape, chrome_with_fit, content_width, fit_scene_in_node, label_run,
    place_in_node,
};
use crate::node_content::node_text;
use crate::scene_digest::json::{number, quote};
use crate::theme::asset::markdown_theme;
use crate::theme::markdown::MarkdownTheme;
use crate::typeset::{
    FittedBlocks, SyntaxFills, TypesetOptions, first_line_of_blocks, typeset_mdast_blocks,
};

/// What a body is typeset with besides its width (`mdastOptionsFor`): the
/// markdown theme the active theme's palette colours, and the family and fill
/// the label path resolves, so one theme drives every glyph in a node.
#[derive(Debug, Clone, PartialEq)]
pub struct MdastStyle {
    pub theme: MarkdownTheme,
    pub font_family: String,
    pub text_fill: Option<String>,
    pub syntax: Option<SyntaxFills>,
}

/// The style a node's body takes under the options a composer holds.
#[must_use]
pub fn mdast_style_for(options: &NodeBoxOptions<'_>) -> MdastStyle {
    let label = options.appearance.resolve_label();
    MdastStyle {
        theme: markdown_theme(options.theme, options.appearance.mode()),
        font_family: label.font_family.unwrap_or_else(|| "sans-serif".to_owned()),
        text_fill: label.fill,
        syntax: options.appearance.resolve_syntax().map(|palette| SyntaxFills {
            keyword: Some(palette.keyword),
            string: Some(palette.string),
            number: Some(palette.number),
            comment: Some(palette.comment),
        }),
    }
}

impl MdastStyle {
    /// The typesetter's options for a body `max_width` wide, with the
    /// composer's seams, budget and embed path.
    #[must_use]
    pub fn options<'s>(
        &'s self,
        max_width: f64,
        compose: &'s ComposeOptions<'s>,
    ) -> TypesetOptions<'s> {
        TypesetOptions {
            measure: compose.node_box.measure,
            max_width,
            font_family: &self.font_family,
            theme: &self.theme,
            text_fill: self.text_fill.as_deref(),
            seams: compose.body.inline,
            highlight: compose.body.highlight,
            syntax: self.syntax.as_ref(),
            math: compose.body.math,
            diagram: compose.body.diagram,
            embeds: compose.body.embeds,
            canvas_layout: Some(compose),
            budget: Some(compose.budget),
            embed_path: compose.embed_path,
        }
    }
}

fn push_nullable(key: &mut String, value: Option<&str>) {
    match value {
        Some(value) => quote(key, value),
        None => key.push_str("null"),
    }
}

/// The content cache's key: `JSON.stringify` of everything a body's layout
/// depends on but its position, since the value is origin-relative. The
/// silhouette is part of it (a shaped node lays out against its inscribed box),
/// and so are the label family and the theme's id.
fn cache_key(node: &SpatialNode, text: &str, options: &ComposeOptions<'_>) -> String {
    let nb = &options.node_box;
    let mut key = String::from("[");
    number(&mut key, node.width);
    key.push(',');
    number(&mut key, node.height);
    key.push(',');
    quote(&mut key, text);
    key.push(',');
    push_nullable(&mut key, nb.outlines.of(&node.id));
    key.push(',');
    push_nullable(&mut key, nb.appearance.resolve_label().font_family.as_deref());
    key.push(',');
    push_nullable(&mut key, options.theme_id);
    key.push(']');
    key
}

/// The blocks that fit, but never fewer than one line: a text node has nothing
/// lower-ranked to fall back to, so dropping everything would erase its prose.
fn fit_text_body(
    nodes: &[SceneNode],
    node: &SpatialNode,
    options: &NodeBoxOptions<'_>,
) -> FittedBlocks {
    fit_scene_in_node(nodes, node, options).unwrap_or_else(|| first_line_of_blocks(nodes))
}

/// The body laid out and fitted, or its text as one line when it does not
/// parse. A body this render's budget refused something for is not cached: it
/// is degraded only because THIS render ran out.
fn lay_out_body(
    node: &SpatialNode,
    text: &str,
    max_width: f64,
    key: Option<&str>,
    options: &ComposeOptions<'_>,
) -> FittedBlocks {
    let nb = &options.node_box;
    let refused_before = options.budget.refused();
    let Ok(root) = options.host.parse_body(text) else {
        options.host.degrade(Degradation::BodyParseFailed { node_id: node.id.clone() });
        let line = SceneNode::TextRun(Box::new(label_run(text, nb, max_width)));
        return fit_text_body(&[line], node, nb);
    };
    let style = mdast_style_for(nb);
    let laid = typeset_mdast_blocks(&root, &style.options(max_width, options));
    let body = fit_text_body(&laid.nodes, node, nb);
    if let (Some(cache), Some(key)) = (options.content_cache, key)
        && options.budget.refused() == refused_before
    {
        cache.set(key, &body);
    }
    body
}

pub(super) fn compose_text_node(
    node: &SpatialNode,
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let nb = &options.node_box;
    if options.host.body_suppressed(&node.id) {
        return vec![SceneNode::Shape(Box::new(chrome_shape(node, nb)))];
    }
    let text = node_text(node).unwrap_or_default();
    let max_width = content_width(node, nb);
    let key = options.content_cache.map(|_| cache_key(node, text, options));
    let cached = options.content_cache.zip(key.as_deref()).and_then(|(cache, key)| cache.get(key));
    let body =
        cached.unwrap_or_else(|| lay_out_body(node, text, max_width, key.as_deref(), options));
    // Behind the runs and in the same origin-relative space, so placing the
    // body carries them into the node with it.
    let mut content = options.host.passage_highlights(node, text, &body);
    let chrome = chrome_with_fit(node, nb, body.truncated, body.overflows);
    content.extend(body.nodes);
    let mut drawn = vec![SceneNode::Shape(Box::new(chrome))];
    drawn.extend(place_in_node(node, &content, nb));
    drawn
}
