//! A paragraph that is only an embed, laid out as the block it points at,
//! ported from `layoutEmbedBlock` and its neighbours.
//!
//! The target's blocks are laid out in place under an `embedResolved` node whose
//! children stay ABSOLUTE, so no transform wrapper is added. Layout is total by
//! construction: a cycle on the current path, the depth cap, the render's
//! nested-layout account, a target the resolver does not hold and a fragment it
//! does not name each end in a placeholder with the matching reason.

use whiteboard_model::mdast::{Phrasing, Root};
use whiteboard_scene::{
    Appearance, BoundingBox, EmbedPlaceholderNode, EmbedReason, EmbedResolvedNode, SceneNode,
    ShapeSceneNode, TextRunNode,
};

use crate::measure::clamp_advance;

use super::blocks::layout_block;
use super::options::{
    Cursor, Style, TypesetOptions, baseline_in, body_font, body_line_height_px, js_max, panel_paint,
};
use super::phrasing::{count_f64, layout_phrasing, reference_label};
use super::seams::{CanvasSummary, EmbedBox, Embedded, Miniature};
use super::section::select_markdown_section;

/// Root depth is 0; a fourth level degrades to a placeholder.
const DEPTH_CAP: usize = 3;

/// A canvas picture is scaled to the column, and a tall one further, so one embed
/// cannot push the rest of the page below the fold: 4:3 rather than 16:9, since
/// a canvas grows in both directions and a wide cap crops the vertical first.
const CANVAS_MAX_ASPECT: f64 = 3.0 / 4.0;

const LOADING_NOTICE: &str = "Loading\u{2026}";
const EMPTY_CANVAS_NOTICE: &str = "Empty canvas";

/// Where the block starts and what it points at.
struct Target<'a> {
    id: &'a str,
    fragment: Option<&'a str>,
    start_y: f64,
}

fn placeholder(
    reason: EmbedReason,
    title: Option<&str>,
    target: &Target<'_>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    let size = opts.theme.body_font_size_px;
    let node = EmbedPlaceholderNode {
        bbox: BoundingBox { x: 0.0, y: target.start_y, w: opts.max_width, h: size },
        document_id: target.id.to_owned(),
        title: reference_label(title.unwrap_or(target.id), target.fragment),
        reason,
    };
    cursor.y += size + opts.theme.block_gap_px;
    SceneNode::EmbedPlaceholder(node)
}

/// The block drawn for an embed whose sole child is the embed node.
pub(super) fn layout_embed(
    id: &str,
    fragment: Option<&str>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
    path: &[String],
) -> SceneNode {
    let target = Target { id, fragment, start_y: cursor.y };
    let resolved = opts.embeds.and_then(|r| r.resolve_embed(id, fragment));
    let title = resolved.as_ref().and_then(Embedded::title);
    if path.iter().any(|p| p == id) {
        return placeholder(EmbedReason::Cycle, title, &target, cursor, opts);
    }
    if path.len() >= DEPTH_CAP {
        return placeholder(EmbedReason::DepthCap, title, &target, cursor, opts);
    }
    let Some(resolved) = resolved else {
        return if opts.seams.embed_pending(id) {
            layout_pending(&target, cursor, opts)
        } else {
            placeholder(EmbedReason::Unresolvable, None, &target, cursor, opts)
        };
    };
    layout_resolved(&resolved, &target, cursor, opts, path)
}

/// A target that is held: spend the account, then lay out what it is.
fn layout_resolved(
    resolved: &Embedded,
    target: &Target<'_>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
    path: &[String],
) -> SceneNode {
    let charge = match resolved {
        Embedded::Canvas { canvas: Some(canvas), .. } => canvas.elements,
        _ => 0,
    };
    if !opts.budget.is_none_or(|b| b.spend(charge)) {
        return placeholder(EmbedReason::Budget, resolved.title(), target, cursor, opts);
    }
    let mut next = path.to_vec();
    next.push(target.id.to_owned());
    match resolved {
        Embedded::Document { root, title } => {
            layout_document(root, title.as_deref(), target, cursor, opts, &next)
        }
        Embedded::Canvas { canvas, title } => match (opts.canvas_layout, canvas) {
            (Some(_), Some(canvas)) => layout_canvas(target, *canvas, cursor, opts, &next),
            _ => placeholder(EmbedReason::Unresolvable, title.as_deref(), target, cursor, opts),
        },
    }
}

/// A document target, laid out in place: its blocks stay absolute, so no wrapper
/// is added. A fragment narrows it to a section, and one it does not name is
/// unresolvable like a missing document.
fn layout_document(
    root: &Root,
    title: Option<&str>,
    target: &Target<'_>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
    path: &[String],
) -> SceneNode {
    let selected = match target.fragment {
        None => Some(root.clone()),
        Some(f) => select_markdown_section(root, f),
    };
    let Some(selected) = selected else {
        return placeholder(EmbedReason::Unresolvable, title, target, cursor, opts);
    };
    let children: Vec<SceneNode> =
        selected.children.iter().map(|c| layout_block(c, cursor, opts, 0, path)).collect();
    SceneNode::EmbedResolved(EmbedResolvedNode {
        bbox: BoundingBox {
            x: 0.0,
            y: target.start_y,
            w: opts.max_width,
            h: cursor.y - target.start_y,
        },
        document_id: target.id.to_owned(),
        children,
    })
}

/// A muted line of chrome under an embed's name, never a link.
fn notice(text: &str, x: f64, y: f64, opts: &TypesetOptions<'_>) -> TextRunNode {
    let theme = opts.theme;
    let line_height = body_line_height_px(theme);
    let font = body_font(opts.font_family, theme.body_font_size_px, Style::default());
    let metrics = opts.measure.measure(text, &font);
    TextRunNode {
        bbox: BoundingBox { x, y, w: clamp_advance(metrics.advance_width), h: line_height },
        baseline: Some(clamp_advance(baseline_in(
            line_height,
            theme.body_font_size_px,
            metrics.ascent,
        ))),
        text: text.to_owned(),
        appearance: Some(Appearance {
            fill: Some(theme.chrome_color.clone()),
            font_family: Some(opts.font_family.to_owned()),
            font_size: Some(theme.body_font_size_px),
            ..Appearance::default()
        }),
        ..super::blocks::empty_run()
    }
}

/// The embed's name as a link along the top of its panel, and how tall that is.
fn title_runs(
    target: &Target<'_>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> (Vec<TextRunNode>, f64) {
    let start_x = cursor.x;
    let pad = opts.theme.code_block_padding_px;
    cursor.x = start_x + pad;
    cursor.y = target.start_y + pad;
    let embed = Phrasing::Embed {
        document_id: target.id.to_owned(),
        fragment: target.fragment.map(str::to_owned),
    };
    let line_height = body_line_height_px(opts.theme);
    let laid = layout_phrasing(
        &[embed],
        *cursor,
        opts,
        opts.theme.body_font_size_px,
        line_height,
        Style::default(),
    );
    cursor.x = start_x;
    (laid.runs, count_f64(laid.line_count) * line_height)
}

fn frame(start_x: f64, start_y: f64, height: f64, opts: &TypesetOptions<'_>) -> SceneNode {
    let theme = opts.theme;
    SceneNode::Shape(Box::new(ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: None,
        bbox: BoundingBox { x: start_x, y: start_y, w: opts.max_width, h: height },
        comment_chrome: false,
        proposal_chrome: None,
        radius: Some(theme.corner_radius_px),
        shape: None,
        appearance: Some(panel_paint(theme, theme.panel_opacity)),
        task_box: None,
        ink: None,
    }))
}

/// The panel for a target asked for and not yet answered: its linked name and a
/// muted loading line, so a slow load reads as in progress. The frame is the one
/// a resolved canvas uses, so the swap to content does not shift the layout.
fn layout_pending(
    target: &Target<'_>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    let theme = opts.theme;
    let start_x = cursor.x;
    let pad = theme.code_block_padding_px;
    let (runs, title_height) = title_runs(target, cursor, opts);
    let line_height = body_line_height_px(theme);
    let loading = notice(LOADING_NOTICE, start_x + pad, target.start_y + pad + title_height, opts);
    let height = pad + title_height + line_height + pad;
    let mut children = vec![frame(start_x, target.start_y, height, opts)];
    children.extend(runs.into_iter().map(|r| SceneNode::TextRun(Box::new(r))));
    children.push(SceneNode::TextRun(Box::new(loading)));
    cursor.y = target.start_y + height + theme.block_gap_px;
    SceneNode::EmbedResolved(EmbedResolvedNode {
        bbox: BoundingBox { x: start_x, y: target.start_y, w: opts.max_width, h: height },
        document_id: target.id.to_owned(),
        children,
    })
}

/// A canvas target: a panel in the code block's chrome, its name along the top and
/// the host's picture fitted underneath. The frame is drawn under `embedResolved`
/// so every reader of the scene sees one block for one embed.
fn layout_canvas(
    target: &Target<'_>,
    canvas: CanvasSummary,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
    path: &[String],
) -> SceneNode {
    let theme = opts.theme;
    let start_x = cursor.x;
    let pad = theme.code_block_padding_px;
    let (runs, title_height) = title_runs(target, cursor, opts);
    let inner = js_max(0.0, opts.max_width - 2.0 * pad);
    let space = EmbedBox {
        x: start_x + pad,
        y: target.start_y + pad + title_height + pad,
        max_width: inner,
        max_height: inner * CANVAS_MAX_ASPECT,
    };
    let picture = opts
        .canvas_layout
        .and_then(|layout| layout.miniature(target.id, target.fragment, &space, path));
    let title_bottom = target.start_y + pad + title_height;
    let (body, bottom) = canvas_body(canvas, picture, &space, title_bottom, opts);
    let height = bottom + pad - target.start_y;
    let mut children = vec![frame(start_x, target.start_y, height, opts)];
    children.extend(runs.into_iter().map(|r| SceneNode::TextRun(Box::new(r))));
    children.extend(body);
    cursor.y = target.start_y + height + theme.block_gap_px;
    SceneNode::EmbedResolved(EmbedResolvedNode {
        bbox: BoundingBox { x: start_x, y: target.start_y, w: opts.max_width, h: height },
        document_id: target.id.to_owned(),
        children,
    })
}

/// What a canvas panel holds under its name, and where that ends. A canvas with
/// nothing on it says so: a bare panel under a link reads as a preview that
/// failed to draw. One that could not be fitted leaves the panel at the title.
fn canvas_body(
    canvas: CanvasSummary,
    picture: Option<Miniature>,
    space: &EmbedBox,
    title_bottom: f64,
    opts: &TypesetOptions<'_>,
) -> (Vec<SceneNode>, f64) {
    if canvas.empty {
        let line = notice(EMPTY_CANVAS_NOTICE, space.x, title_bottom, opts);
        let bottom = title_bottom + line.bbox.h;
        return (vec![SceneNode::TextRun(Box::new(line))], bottom);
    }
    match picture {
        None => (Vec::new(), title_bottom),
        Some(picture) => (picture.nodes, space.y + picture.h),
    }
}
