//! What a caller hands the typesetter and what a laid-out stretch of inline
//! content answers, ported from `mdast-layout-options.ts`.

use whiteboard_scene::{Appearance, TextRunNode};

use crate::measure::{FontDescriptor, FontStyle, Measure, clamp_advance};
use crate::theme::markdown::MarkdownTheme;

use super::seams::{
    CanvasMiniature, CodeTokenizer, DiagramRenderer, EmbedResolver, InlineSeams, MathRenderer,
    NestedLayoutBudget, SyntaxFills,
};

#[derive(Clone, Copy)]
pub struct TypesetOptions<'a> {
    pub measure: &'a dyn Measure,
    /// The wrap width. Not finite, or not positive, means wrapping is off.
    pub max_width: f64,
    /// The family every run is measured with AND declares: one field for both
    /// roles, so the two cannot drift.
    pub font_family: &'a str,
    pub theme: &'a MarkdownTheme,
    /// The fill every run is painted with; absent, runs inherit one.
    pub text_fill: Option<&'a str>,
    pub seams: &'a dyn InlineSeams,
    /// Absent, a fence is drawn as plain source.
    pub highlight: Option<&'a dyn CodeTokenizer>,
    pub syntax: Option<&'a SyntaxFills>,
    /// Absent, display math is drawn as its escaped source.
    pub math: Option<&'a dyn MathRenderer>,
    pub diagram: Option<&'a dyn DiagramRenderer>,
    /// Absent, a paragraph that is only an embed is set as inline prose.
    pub embeds: Option<&'a dyn EmbedResolver>,
    /// Absent, a canvas embed is unresolvable.
    pub canvas_layout: Option<&'a dyn CanvasMiniature>,
    /// The account embeds spend from; absent, the typesetter opens a fresh one.
    pub budget: Option<&'a NestedLayoutBudget>,
}

impl<'a> TypesetOptions<'a> {
    /// The required fields, every optional seam absent.
    #[must_use]
    pub fn new(
        measure: &'a dyn Measure,
        max_width: f64,
        font_family: &'a str,
        theme: &'a MarkdownTheme,
        seams: &'a dyn InlineSeams,
    ) -> Self {
        Self {
            measure,
            max_width,
            font_family,
            theme,
            text_fill: None,
            seams,
            highlight: None,
            syntax: None,
            math: None,
            diagram: None,
            embeds: None,
            canvas_layout: None,
            budget: None,
        }
    }
}

/// `Math.min`: a NaN on either side is the answer, where `f64::min` would
/// answer the other.
pub(super) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// `Math.max`: a NaN on either side is the answer, where `f64::max` would
/// answer the other.
pub(super) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

pub(super) fn code_line_height_px(theme: &MarkdownTheme) -> f64 {
    code_font_size_px(theme) * theme.code_line_height
}

/// A run's weight and slant, and whether it is struck through.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Style {
    pub emphasis: bool,
    pub strong: bool,
    pub deleted: bool,
}

/// The font a run is measured in. Bold glyphs are wider, so a strong run
/// measured at 400 would wrap where the painted 700 text does not.
pub(super) fn body_font(family: &str, size_px: f64, style: Style) -> FontDescriptor {
    FontDescriptor {
        family: family.to_owned(),
        fallback_chain: Vec::new(),
        weight: if style.strong { 700.0 } else { 400.0 },
        style: if style.emphasis { FontStyle::Italic } else { FontStyle::Normal },
        size_px,
    }
}

pub(super) fn measure_run_width(
    options: &TypesetOptions<'_>,
    text: &str,
    size_px: f64,
    style: Style,
) -> f64 {
    let font = body_font(options.font_family, size_px, style);
    clamp_advance(options.measure.advance_width(text, &font))
}

/// A size or an advance a layout may use: finite and above zero.
pub(super) fn finite_positive(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v > 0.0)
}

pub(super) fn body_line_height_px(theme: &MarkdownTheme) -> f64 {
    theme.body_font_size_px * theme.body_line_height
}

pub(super) fn code_font_size_px(theme: &MarkdownTheme) -> f64 {
    theme.body_font_size_px * theme.code_font_scale
}

/// Where a line's glyphs sit inside a line box taller than the font: the extra
/// height splits evenly above and below, as CSS half-leading does.
pub(super) fn baseline_in(line_height_px: f64, font_size_px: f64, ascent: f64) -> f64 {
    (line_height_px - font_size_px) / 2.0 + ascent
}

/// A chrome neutral at an opacity: the surface behind inline code, the rail,
/// the rules.
pub(super) fn panel_paint(theme: &MarkdownTheme, opacity: f64) -> Appearance {
    Appearance {
        fill: Some(theme.chrome_color.clone()),
        fill_opacity: Some(opacity),
        ..Appearance::default()
    }
}

/// The left origin and top of the block being laid out.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Cursor {
    pub x: f64,
    pub y: f64,
}

/// One block's inline content, laid out.
pub(super) struct PhrasingLayout {
    pub runs: Vec<TextRunNode>,
    /// Lines produced (at least one); a hard break starts a new line.
    pub line_count: usize,
    /// How far right the runs actually paint: an atomic run can exceed the wrap
    /// width, and a block that declares the wrap width regardless would lie to
    /// every reader of its bounds.
    pub ink_width: f64,
}
