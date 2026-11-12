//! `markdown-theme.ts`: the typography and chrome a markdown body is laid out
//! with, calibrated to GitHub's rendered-markdown surface because that is the
//! reading experience people already have for this content.
//!
//! DATA, not a resolver: nothing here varies per node. Every colour is ONE
//! neutral at three opacities rather than a light and a dark palette, because
//! markdown body runs carry no fill and inherit it from whichever ancestor sets
//! one; alpha over the inherited surface reads on white and on near-black alike.

#[derive(Debug, Clone, PartialEq)]
pub struct MarkdownTheme {
    /// Body text size (px); every non-heading run is laid out at this size.
    pub body_font_size_px: f64,
    /// Multiplier from font size to line box height, CSS `line-height` style.
    pub body_line_height: f64,
    /// Headings pack tighter than prose, as they do on GitHub.
    pub heading_line_height: f64,
    /// Sizes of `h1` to `h6`, in that order.
    pub heading_font_size_px: [f64; 6],
    /// Gap below every block.
    pub block_gap_px: f64,
    /// EXTRA space above a heading, on top of the preceding block's gap: a
    /// heading belongs to what follows it.
    pub heading_space_above_px: f64,
    /// Left indent per list level.
    pub list_indent_px: f64,
    /// Gap between a list marker's RIGHT edge and its content; the marker is
    /// right-aligned against the content edge, so `9.` and `10.` line up.
    pub list_marker_gap_px: f64,
    /// Gap between list items, replacing the full block gap.
    pub list_item_gap_px: f64,
    /// One system mono stack for every theme: a theme's own mono family would
    /// need a face on every surface.
    pub mono_font_family: &'static str,
    /// Code renders at 85% of body size, GitHub's ratio for both forms.
    pub code_font_scale: f64,
    pub code_line_height: f64,
    /// Padding inside a fenced block's background box.
    pub code_block_padding_px: f64,
    /// Horizontal padding painted around an inline code run's backdrop.
    pub inline_code_padding_x_px: f64,
    pub blockquote_bar_width_px: f64,
    /// Distance from the bar to the quoted content.
    pub blockquote_gap_px: f64,
    pub table_cell_padding_x_px: f64,
    pub table_cell_padding_y_px: f64,
    pub thematic_break_height_px: f64,
    pub border_width_px: f64,
    pub corner_radius_px: f64,
    /// The one neutral every piece of chrome is drawn in. A themed canvas
    /// supplies its own (the palette's `markdownChrome`).
    pub chrome_color: String,
    /// Filled panel behind code (block and inline).
    pub panel_opacity: f64,
    /// Rules, borders, and the blockquote bar.
    pub border_opacity: f64,
    /// Applied to the INHERITED text fill for de-emphasised runs.
    pub muted_text_opacity: f64,
}

const MONO: &str =
    "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace";

impl MarkdownTheme {
    /// Compressed for a node rather than a page: a 32px h1 takes a third of a
    /// 280px box before a word of content lands. h4-h6 never drop BELOW body
    /// size; rank below h3 comes from weight.
    #[must_use]
    pub fn node() -> Self {
        Self {
            body_font_size_px: 16.0,
            body_line_height: 1.55,
            heading_line_height: 1.25,
            heading_font_size_px: [24.0, 20.0, 17.0, 16.0, 16.0, 16.0],
            block_gap_px: 12.0,
            heading_space_above_px: 18.0,
            list_indent_px: 22.0,
            list_marker_gap_px: 8.0,
            list_item_gap_px: 4.0,
            mono_font_family: MONO,
            code_font_scale: 0.85,
            code_line_height: 1.45,
            code_block_padding_px: 16.0,
            inline_code_padding_x_px: 5.0,
            blockquote_bar_width_px: 4.0,
            blockquote_gap_px: 16.0,
            table_cell_padding_x_px: 13.0,
            table_cell_padding_y_px: 6.0,
            thematic_break_height_px: 1.0,
            border_width_px: 1.0,
            corner_radius_px: 6.0,
            chrome_color: "#818b98".to_owned(),
            panel_opacity: 0.12,
            border_opacity: 0.35,
            muted_text_opacity: 0.7,
        }
    }

    /// The same theme at DOCUMENT scale, for a surface that is a page rather
    /// than an object (the markdown editor's preview pane). Not a scale factor
    /// over the node theme: the ratios are not uniform.
    #[must_use]
    pub fn document() -> Self {
        Self {
            heading_font_size_px: [30.0, 24.0, 19.0, 16.0, 16.0, 16.0],
            body_line_height: 1.6,
            block_gap_px: 16.0,
            heading_space_above_px: 24.0,
            list_indent_px: 28.0,
            ..Self::node()
        }
    }

    /// The same object typography at PANEL density, for a surface that reads a
    /// comment beside the document. It is not a smaller document theme and must
    /// never become one: what varies is how much room the surface has.
    #[must_use]
    pub fn compact() -> Self {
        Self {
            body_font_size_px: 14.0,
            heading_font_size_px: [19.0, 17.0, 15.0, 14.0, 14.0, 14.0],
            block_gap_px: 10.0,
            heading_space_above_px: 14.0,
            list_indent_px: 18.0,
            code_block_padding_px: 12.0,
            blockquote_gap_px: 12.0,
            table_cell_padding_x_px: 10.0,
            ..Self::node()
        }
    }
}
