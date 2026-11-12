//! A blockquote and a list with its items, ported from `layoutBlock`'s arms and
//! `layoutListItem`.
//!
//! A list item is the one container whose children are stored RELATIVE to it
//! (the SVG backend translates the subtree by the item's own `bbox.x`), so a
//! marker sits at negative x and everything inside keeps the cursor's own x.
//! A blockquote's children stay absolute: it moves the cursor instead.

use whiteboard_det::format::js_number_to_string;
use whiteboard_model::mdast::{Flow, ListItem};
use whiteboard_scene::{
    Appearance, BlockquoteNode, BoundingBox, ListBlockNode, ListItemNode, SceneNode,
    ShapeSceneNode, TextRunNode,
};

use crate::measure::clamp_advance;

use super::blocks::layout_block;
use super::options::{
    Cursor, Style, TypesetOptions, baseline_in, body_font, body_line_height_px, js_max, panel_paint,
};
use super::phrasing::count_f64;
use super::task_checkbox::checkbox_marker;

pub(super) fn layout_quote(
    children: &[Flow],
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
    depth: usize,
    path: &[String],
) -> SceneNode {
    let theme = opts.theme;
    let (start_x, start_y) = (cursor.x, cursor.y);
    let indent = theme.blockquote_bar_width_px + theme.blockquote_gap_px;
    let indented = TypesetOptions { max_width: opts.max_width - indent, ..*opts };
    cursor.x = start_x + indent;
    let quoted: Vec<SceneNode> =
        children.iter().map(|c| layout_block(c, cursor, &indented, depth, path)).collect();
    cursor.x = start_x;
    // The last quoted block left a trailing gap INSIDE the quote; the bar and
    // the box end at the content, and the gap belongs after.
    let content_end = cursor.y - theme.block_gap_px;
    let height = js_max(content_end - start_y, 0.0);
    let bar = ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: None,
        bbox: BoundingBox { x: start_x, y: start_y, w: theme.blockquote_bar_width_px, h: height },
        comment_chrome: false,
        proposal_chrome: None,
        radius: Some(theme.blockquote_bar_width_px / 2.0),
        shape: None,
        appearance: Some(panel_paint(theme, theme.border_opacity)),
        task_box: None,
        ink: None,
    };
    let mut nodes = vec![SceneNode::Shape(Box::new(bar))];
    nodes.extend(quoted);
    SceneNode::Blockquote(BlockquoteNode {
        bbox: BoundingBox { x: start_x, y: start_y, w: opts.max_width, h: height },
        children: nodes,
        appearance: Some(Appearance {
            fill_opacity: Some(theme.muted_text_opacity),
            ..Appearance::default()
        }),
    })
}

pub(super) fn layout_list(
    ordered: bool,
    start: f64,
    items: &[ListItem],
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
    depth: usize,
    path: &[String],
) -> SceneNode {
    let theme = opts.theme;
    let start_y = cursor.y;
    let mut laid = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let ordinal = ordered.then(|| start + count_f64(index));
        laid.push(layout_item(item, ordinal, cursor, opts, depth.saturating_add(1), path));
    }
    // Each item closed with the tighter intra-list gap; the list as a whole is
    // still followed by a full block gap.
    cursor.y += theme.block_gap_px - theme.list_item_gap_px;
    SceneNode::List(ListBlockNode {
        bbox: BoundingBox {
            x: cursor.x,
            y: start_y,
            w: opts.max_width,
            h: cursor.y - start_y - theme.block_gap_px,
        },
        ordered,
        depth: count_f64(depth),
        items: laid,
    })
}

fn layout_item(
    item: &ListItem,
    ordinal: Option<f64>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
    depth: usize,
    path: &[String],
) -> ListItemNode {
    let theme = opts.theme;
    let start_y = cursor.y;
    let indented = TypesetOptions { max_width: opts.max_width - theme.list_indent_px, ..*opts };
    let mut body = Vec::with_capacity(item.children.len());
    for child in &item.children {
        body.push(layout_block(child, cursor, &indented, depth, path));
    }
    // The gutter: a bullet, an ordinal, or a task item's checkbox instead of
    // one.
    let mut children = match item.checked {
        Some(checked) => checkbox_marker(theme, checked, start_y),
        None => vec![SceneNode::TextRun(Box::new(marker_run(ordinal, start_y, opts)))],
    };
    children.extend(body);
    // Prose blocks each close with a full block gap; inside a list that reads as
    // items drifting apart, so the item's own trailing gap is tightened.
    cursor.y -= theme.block_gap_px - theme.list_item_gap_px;
    let inset = theme.list_indent_px * count_f64(depth);
    ListItemNode {
        bbox: BoundingBox {
            x: inset,
            y: start_y,
            w: opts.max_width - inset,
            h: cursor.y - start_y,
        },
        ordinal,
        checked: item.checked,
        children,
    }
}

/// The bullet or the ordinal, right-aligned against the content edge so `9.`
/// and `10.` line up.
fn marker_run(ordinal: Option<f64>, start_y: f64, opts: &TypesetOptions<'_>) -> TextRunNode {
    let theme = opts.theme;
    let text =
        ordinal.map_or_else(|| "\u{2022}".to_owned(), |n| format!("{}.", js_number_to_string(n)));
    let font = body_font(opts.font_family, theme.body_font_size_px, Style::default());
    let metrics = opts.measure.measure(&text, &font);
    let width = clamp_advance(metrics.advance_width);
    let line_height = body_line_height_px(theme);
    TextRunNode {
        bbox: BoundingBox {
            x: -(width + theme.list_marker_gap_px),
            y: start_y,
            w: width,
            h: line_height,
        },
        baseline: Some(clamp_advance(baseline_in(
            line_height,
            theme.body_font_size_px,
            metrics.ascent,
        ))),
        text,
        appearance: Some(Appearance {
            fill: opts.text_fill.map(str::to_owned),
            font_family: Some(opts.font_family.to_owned()),
            font_size: Some(theme.body_font_size_px),
            ..Appearance::default()
        }),
        ..super::blocks::empty_run()
    }
}
