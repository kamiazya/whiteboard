//! A GFM table, ported from `mdast-table.ts`: column widths from the cells'
//! natural widths, scaled into the column when they do not fit, and a row per
//! `tableRow` whose cells hold their runs RELATIVE to the cell (the SVG backend
//! translates a cell by its own `bbox.x`).

use whiteboard_model::mdast::{Phrasing, TableCell, TableRow};
use whiteboard_scene::{
    BoundingBox, SceneNode, TableBlockNode, TableCellSceneNode, TableRowSceneNode,
};

use super::options::{
    Cursor, PhrasingLayout, Style, TypesetOptions, body_line_height_px, js_max, measure_run_width,
    panel_paint,
};
use super::phrasing::{count_f64, layout_phrasing};

/// The text a cell reads as, for sizing: every `value` and every child's, in order.
fn plain_text(children: &[Phrasing]) -> String {
    let mut text = String::new();
    for child in children {
        match child {
            Phrasing::Text { value }
            | Phrasing::InlineCode { value }
            | Phrasing::Html { value }
            | Phrasing::InlineMath { value } => text.push_str(value),
            Phrasing::Emphasis { children }
            | Phrasing::Strong { children }
            | Phrasing::Delete { children }
            | Phrasing::Link { children, .. }
            | Phrasing::LinkReference { children, .. } => text.push_str(&plain_text(children)),
            _ => {}
        }
    }
    text
}

/// Each column as wide as its widest cell set in bold, padding included; scaled
/// into the wrap width when together they are wider.
fn column_widths(rows: &[TableRow], count: usize, opts: &TypesetOptions<'_>) -> Vec<f64> {
    let theme = opts.theme;
    let mut natural = vec![0.0_f64; count];
    let strong = Style { strong: true, ..Style::default() };
    for row in rows {
        for (index, cell) in row.children.iter().enumerate() {
            let text = plain_text(&cell.children);
            let ink = measure_run_width(opts, &text, theme.body_font_size_px, strong);
            if let Some(slot) = natural.get_mut(index) {
                *slot = js_max(*slot, ink + 2.0 * theme.table_cell_padding_x_px);
            }
        }
    }
    let total = natural.iter().fold(0.0, |sum, w| sum + w);
    if !opts.max_width.is_finite() || opts.max_width <= 0.0 || total <= opts.max_width {
        return natural;
    }
    let minimum = 2.0 * theme.table_cell_padding_x_px + theme.body_font_size_px;
    scale_into_width(&natural, opts.max_width, minimum)
}

/// Scales the columns to `max_width`, holding any that would fall under the
/// minimum at it and sharing the rest among the others. Each round floors at
/// least one more column or answers, so a round per column is enough.
fn scale_into_width(natural: &[f64], max_width: f64, minimum: f64) -> Vec<f64> {
    let mut floored = vec![false; natural.len()];
    let mut widths = natural.to_vec();
    for _ in 0..=natural.len() {
        let held = floored.iter().filter(|f| **f).count();
        let flexible = natural
            .iter()
            .zip(&floored)
            .fold(0.0, |sum, (w, held)| if *held { sum } else { sum + w });
        let scale = (max_width - count_f64(held) * minimum) / flexible;
        widths = natural
            .iter()
            .zip(&floored)
            .map(|(w, f)| if *f { minimum } else { w * scale })
            .collect();
        let under: Vec<usize> = widths
            .iter()
            .zip(&floored)
            .enumerate()
            .filter_map(|(i, (w, f))| (!*f && *w < minimum).then_some(i))
            .collect();
        if under.is_empty() {
            break;
        }
        for i in under {
            if let Some(slot) = floored.get_mut(i) {
                *slot = true;
            }
        }
    }
    widths
}

pub(super) fn layout_table(
    rows: &[TableRow],
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    let start_y = cursor.y;
    let count = rows.iter().map(|row| row.children.len()).fold(1, usize::max);
    let widths = column_widths(rows, count, opts);
    let table_width = widths.iter().fold(0.0, |total, w| total + w);
    let laid = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let place = RowPlace { index, count: rows.len(), widths: &widths, table_width };
            layout_row(row, &place, cursor, opts)
        })
        .collect();
    cursor.y += opts.theme.block_gap_px;
    SceneNode::Table(TableBlockNode {
        bbox: BoundingBox {
            x: cursor.x,
            y: start_y,
            w: table_width,
            h: cursor.y - start_y - opts.theme.block_gap_px,
        },
        rows: laid,
    })
}

struct RowPlace<'a> {
    index: usize,
    count: usize,
    widths: &'a [f64],
    table_width: f64,
}

/// One cell's runs, relative to the cell: the padding is the x the first run starts at.
fn layout_cell(
    cell: &TableCell,
    width: f64,
    row_y: f64,
    style: Style,
    opts: &TypesetOptions<'_>,
) -> PhrasingLayout {
    let theme = opts.theme;
    let inner = TypesetOptions { max_width: width - 2.0 * theme.table_cell_padding_x_px, ..*opts };
    let at = Cursor { x: theme.table_cell_padding_x_px, y: row_y + theme.table_cell_padding_y_px };
    let line_height = body_line_height_px(theme);
    layout_phrasing(&cell.children, at, &inner, theme.body_font_size_px, line_height, style)
}

fn layout_row(
    row: &TableRow,
    place: &RowPlace<'_>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> TableRowSceneNode {
    let theme = opts.theme;
    let row_y = cursor.y;
    let header = place.index == 0;
    let style = Style { strong: header, ..Style::default() };
    let mut x = cursor.x;
    let mut laid = Vec::with_capacity(row.children.len());
    for (index, cell) in row.children.iter().enumerate() {
        let width = place.widths.get(index).copied().unwrap_or(0.0);
        laid.push((x, width, layout_cell(cell, width, cursor.y, style, opts)));
        x += width;
    }
    let lines = laid.iter().fold(1, |most, (_, _, p)| most.max(p.line_count));
    let row_height =
        count_f64(lines) * body_line_height_px(theme) + 2.0 * theme.table_cell_padding_y_px;
    let cells = laid
        .into_iter()
        .map(|(cell_x, width, phrased)| TableCellSceneNode {
            bbox: BoundingBox { x: cell_x, y: row_y, w: width, h: row_height },
            runs: phrased.runs,
            appearance: None,
        })
        .collect();
    cursor.y += row_height;
    let last = place.index.saturating_add(1) == place.count;
    TableRowSceneNode {
        bbox: BoundingBox { x: cursor.x, y: row_y, w: place.table_width, h: row_height },
        cells,
        header: header.then_some(true),
        appearance: (!last).then(|| panel_paint(theme, theme.border_opacity)),
    }
}
