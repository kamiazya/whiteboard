//! The legend as document chrome (ADR-0040 decision 6): drawn in the
//! bottom-left corner of an EXPORTED document's viewBox, in the room the
//! envelope reserves under the content, so a reader of an SVG or a PNG sees what
//! the colour means without a panel. The editor draws the same legend as its
//! own overlay and asks this backend to omit it.
//!
//! Sized by an estimate rather than a measurer (the backend has none, and a
//! legend's words are short identifiers) at a fixed 12px sans face, so the panel
//! is a few pixels generous rather than clipping a long value.

use super::vnode::{Attrs, Child, VNode};
use crate::legend_geometry::{
    LEGEND_FONT_PX, LEGEND_GAP_PX, LEGEND_MARGIN_PX, LEGEND_PAD_PX, LEGEND_ROW_PX, LEGEND_SWATCH_H,
    LEGEND_SWATCH_W, LegendRow, legend_panel_size, legend_rows, legend_value_label,
};
use whiteboard_det::format::js_number_to_string;
use whiteboard_scene::{BoundingBox, LegendEntry, LegendKey, LegendKind, SceneLegend};

const FONT: &str = "sans-serif";
const PANEL_FILL: &str = "#ffffff";
const PANEL_STROKE: &str = "#d4d4d4";
const INK: &str = "#303030";
const MUTED: &str = "#8a8a8a";

fn swatch(key: &LegendKey, entry: &LegendEntry, y: f64) -> VNode {
    let stroke = entry.swatch.stroke.as_deref().unwrap_or(INK);
    if key.of == LegendKind::Edges {
        return VNode::leaf(
            "line",
            Attrs::new()
                .num("x1", 0.0)
                .num("y1", y + LEGEND_SWATCH_H / 2.0)
                .num("x2", LEGEND_SWATCH_W)
                .num("y2", y + LEGEND_SWATCH_H / 2.0)
                .str("stroke", stroke)
                .num("stroke-width", 2.0),
        );
    }
    VNode::leaf(
        "rect",
        Attrs::new()
            .num("x", 0.5)
            .num("y", y + 0.5)
            .num("width", LEGEND_SWATCH_W - 1.0)
            .num("height", LEGEND_SWATCH_H - 1.0)
            .num("rx", 2.0)
            .str("fill", entry.swatch.fill.as_deref().unwrap_or("none"))
            .str("stroke", stroke)
            .num("stroke-width", 1.0),
    )
}

fn label(x: f64, y: f64, fill: &str, bold: bool, text: &str) -> Child {
    let attrs = Attrs::new()
        .num("x", x)
        .num("y", y)
        .str("fill", fill)
        .str("font-family", FONT)
        .num("font-size", LEGEND_FONT_PX);
    let attrs = if bold { attrs.str("font-weight", "bold") } else { attrs };
    VNode::el("text", attrs, vec![Child::Text(text.to_string())]).into()
}

fn row_y(row: u32) -> f64 {
    LEGEND_PAD_PX + f64::from(row) * LEGEND_ROW_PX
}

/// A swatch beside its value, one row of an entry.
fn entry_row(key: &LegendKey, entry: &LegendEntry, row: u32) -> [Child; 2] {
    let y = row_y(row);
    let shift = y + (LEGEND_ROW_PX - LEGEND_SWATCH_H) / 2.0;
    let transform =
        format!("translate({} {})", js_number_to_string(LEGEND_PAD_PX), js_number_to_string(shift));
    let x = LEGEND_PAD_PX + LEGEND_SWATCH_W + LEGEND_GAP_PX;
    [
        VNode::el(
            "g",
            Attrs::new().str("transform", &transform),
            vec![swatch(key, entry, 0.0).into()],
        )
        .into(),
        label(x, y + LEGEND_FONT_PX, INK, false, legend_value_label(&entry.value)),
    ]
}

/// The panel: its background, each key with its entries, then the muted notes.
fn panel_children(
    legend: &SceneLegend,
    width: f64,
    height: f64,
    muted: &[LegendRow],
) -> Vec<Child> {
    let mut children: Vec<Child> = vec![
        VNode::leaf(
            "rect",
            Attrs::new()
                .num("x", 0.0)
                .num("y", 0.0)
                .num("width", width)
                .num("height", height)
                .num("rx", 4.0)
                .str("fill", PANEL_FILL)
                .str("stroke", PANEL_STROKE)
                .num("stroke-width", 1.0),
        )
        .into(),
    ];
    let mut row: u32 = 0;
    for key in &legend.keys {
        children.push(label(LEGEND_PAD_PX, row_y(row) + LEGEND_FONT_PX, INK, true, &key.key));
        row = row.saturating_add(1);
        for entry in &key.entries {
            children.extend(entry_row(key, entry, row));
            row = row.saturating_add(1);
        }
    }
    for line in muted {
        children.push(label(LEGEND_PAD_PX, row_y(row) + LEGEND_FONT_PX, MUTED, false, &line.text));
        row = row.saturating_add(1);
    }
    children
}

pub(super) fn render_legend(legend: &SceneLegend, view_box: &BoundingBox) -> Child {
    let lines = legend_rows(legend);
    if lines.is_empty() {
        return Child::none();
    }
    let muted: Vec<LegendRow> = lines.into_iter().filter(|line| line.muted).collect();
    let (width, height) = legend_panel_size(legend);
    let x = view_box.x + LEGEND_MARGIN_PX;
    let y = view_box.y + view_box.h - LEGEND_MARGIN_PX - height;
    VNode::el(
        "g",
        Attrs::new().str("data-wb-legend", "").str(
            "transform",
            &format!("translate({} {})", js_number_to_string(x), js_number_to_string(y)),
        ),
        panel_children(legend, width, height, &muted),
    )
    .into()
}
