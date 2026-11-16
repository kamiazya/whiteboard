//! A markdown DOCUMENT laid out (`layout/markdown-body.ts`'s
//! `layoutMdastBlocks`): the typesetter at the document theme, with a body's
//! `![[canvas]]` drawn by the composer as a whole board, its legend under it,
//! and one nested-layout account shared by the note and every canvas it
//! embeds, so a board inside a note spends from the note's account.
//!
//! The board is laid out as a canvas of its own on the embed's path, in the
//! style and with the seams the note was given and none of the conversation
//! about it: a request for a document carries no comment or proposal layer.
//!
//! A comment's prose is the other body a surface lays out on its own
//! ([`layout_comment_text`], `layoutCommentBody`): the node or compact theme
//! by density, the plain parser, and no seam a document's references answer.

use whiteboard_det::math::js_max;
use whiteboard_model::mdast::Root;
use whiteboard_scene::Scene;

use crate::comments::body::CommentDensity;
use crate::compose_canvas::{LayoutOptions, layout_spatial_canvas};
use crate::legend::block::legend_scene_block;
use crate::legend_geometry::LEGEND_MARGIN_PX;
use crate::measure::Measure;
use crate::scale_scene::fit_scene_into_box;
use crate::theme::appearance::SpatialAppearanceResolver;
use crate::theme::font::SPATIAL_THEME_FONT_FAMILY;
use crate::theme::markdown::MarkdownTheme;
use crate::translate_scene::translate_scene;
use crate::typeset::{
    CanvasMiniature, EmbedBox, InlineSeams, Miniature, NestedLayoutBudget, SyntaxFills,
    TypesetOptions, typeset_mdast_blocks,
};

/// The boards a note embeds, laid out with the note's options and account.
struct Boards<'a> {
    layout: &'a LayoutOptions<'a>,
}

impl CanvasMiniature for Boards<'_> {
    fn miniature(
        &self,
        document_id: &str,
        fragment: Option<&str>,
        space: &EmbedBox,
        path: &[String],
    ) -> Option<Miniature> {
        let canvas = self.layout.host.embedded_canvas(document_id, fragment)?;
        let options = LayoutOptions { embed_path: path, ..*self.layout };
        let laid = layout_spatial_canvas(&canvas, &options);
        fit_with_legend(&laid.scene, space, self.layout.appearance)
    }
}

/// The board fitted into the embed's box with its legend under it, the legend
/// at its own size and the board giving up the height it takes; a board with
/// nothing to key is fitted as it is.
fn fit_with_legend(
    scene: &Scene,
    space: &EmbedBox,
    appearance: &dyn SpatialAppearanceResolver,
) -> Option<Miniature> {
    let legend = scene
        .legend
        .as_ref()
        .and_then(|legend| legend_scene_block(legend, &appearance.resolve_label()));
    let Some(legend) = legend else { return fit_scene_into_box(&scene.nodes, space) };
    let room = legend.h + LEGEND_MARGIN_PX;
    let shrunk = EmbedBox { max_height: js_max(1.0, space.max_height - room), ..*space };
    let board = fit_scene_into_box(&scene.nodes, &shrunk)?;
    let placed = translate_scene(&legend.nodes, space.x, space.y + board.h + LEGEND_MARGIN_PX);
    let mut nodes = board.nodes;
    nodes.extend(placed);
    Some(Miniature { nodes, w: js_max(board.w, legend.w), h: board.h + room })
}

/// A markdown document's blocks laid out `max_width` wide at the document
/// theme: its fences coloured in the syntax palette of `layout`'s appearance,
/// its embeds resolved through `layout`'s body seams, and each embedded
/// board laid out under `layout` on one account opened here.
#[must_use]
pub fn layout_markdown_document(root: &Root, max_width: f64, layout: &LayoutOptions<'_>) -> Scene {
    let budget = NestedLayoutBudget::new();
    let shared = LayoutOptions { budget: Some(&budget), ..*layout };
    let boards = Boards { layout: &shared };
    let theme = MarkdownTheme::document();
    let syntax = layout.appearance.resolve_syntax().map(|palette| SyntaxFills {
        keyword: Some(palette.keyword),
        string: Some(palette.string),
        number: Some(palette.number),
        comment: Some(palette.comment),
    });
    let body = &layout.body;
    let options = TypesetOptions {
        highlight: body.highlight,
        syntax: syntax.as_ref(),
        math: body.math,
        diagram: body.diagram,
        embeds: body.embeds,
        canvas_layout: Some(&boards),
        budget: Some(&budget),
        ..TypesetOptions::new(
            layout.measure,
            max_width,
            SPATIAL_THEME_FONT_FAMILY,
            &theme,
            body.inline,
        )
    };
    typeset_mdast_blocks(root, &options)
}

/// A comment's prose laid out `max_width` wide (`layoutCommentBody`): the
/// node theme for a bubble, the compact one for a panel, in the bundled
/// family, with no fill, highlighter, renderer or embed of its own.
#[must_use]
pub fn layout_comment_text(
    root: &Root,
    max_width: f64,
    density: CommentDensity,
    measure: &dyn Measure,
    seams: &dyn InlineSeams,
) -> Scene {
    let theme = match density {
        CommentDensity::Comfortable => MarkdownTheme::node(),
        CommentDensity::Compact => MarkdownTheme::compact(),
    };
    let options = TypesetOptions::new(measure, max_width, SPATIAL_THEME_FONT_FAMILY, &theme, seams);
    typeset_mdast_blocks(root, &options)
}
