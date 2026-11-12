//! Inline content laid out as styled runs, ported from `layoutPhrasing`.
//!
//! The TypeScript is one closure over the run list, the line cursor and the
//! inline junction; here they are one struct and each closure a method. Within
//! a line each run's `bbox.x` is the running horizontal cursor, so sibling runs
//! never overlap; a hard break resets it and advances one line. A chunk that
//! already fits stays one run measured once, and a chunk that does not is
//! wrapped at the break opportunities `segments` offers (`wrap.rs`). Inline
//! code, raw HTML and inline math are ATOMIC: never split, since an interior
//! space in them is not a word boundary, and cut to the width instead
//! (`truncate`) unless they are math, which overflows rather than read as a
//! complete formula that is wrong.

use whiteboard_model::mdast::Phrasing;
use whiteboard_scene::{Appearance, BoundingBox, LinkProvenance, RunPaint, TextRunNode};

use crate::inline_junction::{InlineJunction, LineCursor, create_inline_junction, head_character};
use crate::measure::clamp_advance;
use crate::truncate::{FittedText, fit_to_width};

use super::options::{
    Cursor, PhrasingLayout, Style, TypesetOptions, baseline_in, body_font, code_font_size_px,
    finite_positive, measure_run_width, panel_paint,
};
use super::text::{collapse, ends_with_space, slice_utf16, starts_with_space};

/// What an alt-less inline image reads as: a width, not a label. One en-space
/// rather than a word, since it is not text anybody wrote.
const IMAGE_PLACEHOLDER: &str = "\u{2002}";

/// An EM space, one em wide: the box an icon is drawn in is body-sized and
/// centred in the line. The en space of the image placeholder would halve it.
const ICON_PLACEHOLDER: &str = "\u{2003}";

/// The family and size a run is measured AND declared in.
#[derive(Debug, Clone, Copy)]
pub(super) struct Face<'a> {
    pub family: &'a str,
    pub size_px: f64,
}

/// What a run carries beyond its text and style.
#[derive(Debug, Clone, Default)]
pub(super) struct Extra {
    pub link: Option<LinkProvenance>,
    pub code: bool,
    pub backdrop: Option<Appearance>,
    pub backdrop_pad_x_px: Option<f64>,
    pub paints: Option<RunPaint>,
    pub truncated: bool,
    pub overflows: bool,
}

pub(super) struct InlineLayout<'a> {
    pub(super) opts: &'a TypesetOptions<'a>,
    pub(super) cursor: Cursor,
    pub(super) font_size: f64,
    pub(super) line_height: f64,
    pub(super) runs: Vec<TextRunNode>,
    pub(super) line: LineCursor,
    pub(super) junction: InlineJunction,
    pub(super) can_wrap: bool,
}

pub(super) fn count_f64(count: usize) -> f64 {
    f64::from(u32::try_from(count).unwrap_or(u32::MAX))
}

/// `a › b`, how a reference with a `#fragment` reads: the way a breadcrumb does.
fn reference_label(title: &str, fragment: Option<&str>) -> String {
    fragment.map_or_else(|| title.to_owned(), |f| format!("{title} › {f}"))
}

impl<'a> InlineLayout<'a> {
    pub(super) fn body_face(&self) -> Face<'a> {
        Face { family: self.opts.font_family, size_px: self.font_size }
    }

    /// One run at the line cursor. A run with a backdrop occupies its padding IN
    /// FLOW, as CSS horizontal padding does: without it the pill is drawn wider
    /// than the cursor advanced and the next run paints over its right edge.
    pub(super) fn push_run(&mut self, text: &str, extra: &Extra, style: Style, face: Face<'_>) {
        let font = body_font(face.family, face.size_px, style);
        let metrics = self.opts.measure.measure(text, &font);
        let width = clamp_advance(metrics.advance_width);
        let baseline = clamp_advance(baseline_in(self.line_height, face.size_px, metrics.ascent));
        let pad_x = finite_positive(extra.backdrop_pad_x_px).unwrap_or(0.0);
        // Stamped last in the TypeScript so nothing can declare a family or size
        // other than the ones it was measured with.
        let appearance = Appearance {
            fill: self.opts.text_fill.map(str::to_owned),
            font_family: Some(face.family.to_owned()),
            font_size: Some(face.size_px),
            ..Appearance::default()
        };
        self.runs.push(TextRunNode {
            bbox: BoundingBox {
                x: self.cursor.x + self.line.x + pad_x,
                y: self.cursor.y + count_f64(self.line.index) * self.line_height,
                w: width,
                h: self.line_height,
            },
            baseline: Some(baseline),
            text: text.to_owned(),
            emphasis: style.emphasis,
            strong: style.strong,
            code: extra.code,
            deleted: style.deleted,
            link: extra.link.clone(),
            truncated: extra.truncated,
            overflows: extra.overflows,
            appearance: Some(appearance),
            paints: extra.paints.clone(),
            backdrop: extra.backdrop.clone(),
            backdrop_pad_x_px: extra.backdrop_pad_x_px,
            annotates: None,
        });
        self.line.x += width + 2.0 * pad_x;
        self.junction.placed(text, extra.paints.as_ref(), &self.runs, &self.line);
    }

    /// An atomic run is never SPLIT, so cutting it is the only way left to keep
    /// it inside the box, and the run says so.
    fn emit_atomic(
        &mut self,
        text: &str,
        extra: &Extra,
        style: Style,
        cuttable: bool,
        face: Face<'_>,
    ) {
        // A backdrop's padding is part of what the run occupies, so it comes out
        // of the fit budget too.
        let pad_x = finite_positive(extra.backdrop_pad_x_px).unwrap_or(0.0);
        let fitted = if cuttable {
            let font = body_font(face.family, face.size_px, style);
            fit_to_width(
                text,
                &font,
                self.opts.measure,
                self.opts.max_width - self.line.x - 2.0 * pad_x,
            )
        } else {
            FittedText { text, truncated: false, overflows: false }
        };
        let cut =
            Extra { truncated: fitted.truncated, overflows: fitted.overflows, ..extra.clone() };
        self.push_run(fitted.text, &cut, style, face);
    }

    /// One already-collapsed stretch, whole if it fits the line and through the
    /// wrapper if it does not.
    fn place_collapsed(&mut self, collapsed: &str, extra: &Extra, style: Style) {
        let full = measure_run_width(self.opts, collapsed, self.font_size, style);
        if self.can_wrap && self.line.x + full > self.opts.max_width {
            self.wrap_and_push(collapsed, extra, style);
        } else {
            self.push_run(collapsed, extra, style, self.body_face());
        }
    }

    /// One inline node's text. `wrappable` is false for an atomic run;
    /// `truncatable` is false for inline math. `face` is the body's unless a
    /// run changes both family and size (inline code).
    pub(super) fn emit(
        &mut self,
        text: &str,
        extra: &Extra,
        style: Style,
        shape: Shape,
        face: Option<Face<'a>>,
    ) {
        // Decided ONCE per inline node, before anything of it is placed: a break
        // UAX #14 allows on this node's left edge opens a new cluster, one it
        // forbids joins the node to the stretch already on the line.
        let joined = !self.junction.breakable_before(head_character(text, extra.paints.as_ref()));
        if !shape.wrappable {
            if !joined {
                self.junction.allow_break_here(&self.runs, &self.line);
            }
            let face = face.unwrap_or_else(|| self.body_face());
            self.emit_atomic(text, extra, style, self.can_wrap && shape.truncatable, face);
            return;
        }
        // XML strips boundary whitespace and squeezes interior runs of it, so a
        // run's text must already be in that form, with the boundary whitespace
        // carried as CURSOR ADVANCES.
        let collapsed = collapse(text);
        let space = measure_run_width(self.opts, " ", self.font_size, style);
        if starts_with_space(text) && self.line.x > 0.0 {
            self.line.x += space;
        }
        if !joined {
            self.junction.allow_break_here(&self.runs, &self.line);
        }
        if !collapsed.is_empty() {
            self.place_collapsed(&collapsed, extra, style);
        }
        if ends_with_space(text) {
            self.line.x += space;
            self.junction.allow_break_here(&self.runs, &self.line);
        }
    }
}

/// Whether an inline node may be split across lines, and cut to the width.
#[derive(Debug, Clone, Copy)]
pub(super) struct Shape {
    pub wrappable: bool,
    pub truncatable: bool,
}

pub(super) const PROSE: Shape = Shape { wrappable: true, truncatable: true };
pub(super) const ATOMIC: Shape = Shape { wrappable: false, truncatable: true };
pub(super) const UNCUTTABLE: Shape = Shape { wrappable: false, truncatable: false };

impl InlineLayout<'_> {
    /// One text node's string, with both shortcode vocabularies applied.
    ///
    /// They cannot be applied the same way. An emoji is a CHARACTER, substituted
    /// into the string; an icon is drawn geometry, so it takes a run of its own
    /// carrying `paints`. Icons are split out FIRST, off offsets taken from the
    /// raw string, and the emoji expansion runs within each surviving segment:
    /// expanding first would move every offset after the first emoji.
    fn emit_with_icons(&mut self, value: &str, style: Style) {
        let units: Vec<u16> = value.encode_utf16().collect();
        let mut at = 0_usize;
        for range in self.opts.seams.icon_ranges(value) {
            let whole = range.from >= at
                && range.to > range.from
                && slice_utf16(&units, range.from, range.to).is_some();
            if !whole {
                continue;
            }
            if range.from > at {
                self.emit_expanded(&slice_utf16(&units, at, range.from).unwrap_or_default(), style);
            }
            let paints = RunPaint::Icon { name: range.name };
            let extra = Extra { paints: Some(paints), ..Extra::default() };
            self.emit(ICON_PLACEHOLDER, &extra, style, ATOMIC, None);
            at = range.to;
        }
        if at == 0 {
            self.emit_expanded(value, style);
        } else if at < units.len() {
            self.emit_expanded(&slice_utf16(&units, at, units.len()).unwrap_or_default(), style);
        }
    }

    fn emit_expanded(&mut self, text: &str, style: Style) {
        let expanded = self.opts.seams.expand_emoji(text);
        self.emit(&expanded, &Extra::default(), style, PROSE, None);
    }

    /// An image stays a RUN, with `text` as the alt. An alt-LESS one takes a
    /// placeholder atomically (the wrappable path collapses a whitespace
    /// placeholder away, and the run with it); one WITH an alt stays wrappable,
    /// because an alt is prose. One with nowhere to load from reads as its alt
    /// and paints nothing.
    fn emit_image(&mut self, url: &str, alt: Option<&String>, style: Style) {
        let alt = alt.map(String::as_str).filter(|a| !a.is_empty());
        let Some(src) = self.image_src(url) else {
            if let Some(alt) = alt {
                self.emit(alt, &Extra::default(), style, PROSE, None);
            }
            return;
        };
        let extra = Extra { paints: Some(RunPaint::Image { src }), ..Extra::default() };
        let shape = if alt.is_some() { PROSE } else { ATOMIC };
        self.emit(alt.unwrap_or(IMAGE_PLACEHOLDER), &extra, style, shape, None);
    }

    /// Where a picture loads from: what the host resolves the reference to, else
    /// the written URL when its scheme is one every painter reads as a URL. A
    /// bare or relative path is not: resvg reads it from the host it runs on.
    pub(super) fn image_src(&self, url: &str) -> Option<String> {
        if let Some(image) = self.opts.seams.image_reference(url) {
            return Some(image.href);
        }
        let head = |n: usize| url.as_bytes().get(..n);
        let scheme = head(5).is_some_and(|h| h.eq_ignore_ascii_case(b"http:"))
            || head(6).is_some_and(|h| h.eq_ignore_ascii_case(b"https:"))
            || head(5).is_some_and(|h| h.eq_ignore_ascii_case(b"data:"));
        scheme.then(|| url.to_owned())
    }

    /// A wiki link's label is the alias when written, else the resolved title.
    fn emit_wiki_link(
        &mut self,
        document_id: &str,
        alias: Option<&String>,
        fragment: Option<&String>,
        style: Style,
    ) {
        let label = alias.cloned().unwrap_or_else(|| {
            let title = self.opts.seams.document_title(document_id);
            reference_label(title.as_deref().unwrap_or(document_id), fragment.map(String::as_str))
        });
        let link = LinkProvenance::WikiLink {
            document_id: document_id.to_owned(),
            alias: alias.filter(|a| !a.is_empty()).cloned(),
            fragment: fragment.filter(|f| !f.is_empty()).cloned(),
        };
        self.emit(&label, &Extra { link: Some(link), ..Extra::default() }, style, PROSE, None);
    }

    /// Inline — mixed into prose — an embed stays a link run; the resolved name
    /// is a better label than the raw id when known.
    fn emit_embed(&mut self, document_id: &str, fragment: Option<&String>, style: Style) {
        let seams = self.opts.seams;
        let name = seams.embed_name(document_id).or_else(|| {
            if seams.embed_pending(document_id) { seams.document_title(document_id) } else { None }
        });
        let label =
            reference_label(name.as_deref().unwrap_or(document_id), fragment.map(String::as_str));
        let link = LinkProvenance::Embed {
            document_id: document_id.to_owned(),
            fragment: fragment.filter(|f| !f.is_empty()).cloned(),
        };
        self.emit(&label, &Extra { link: Some(link), ..Extra::default() }, style, PROSE, None);
    }

    /// Walk `nodes`, then stamp `link` provenance onto every run they produced,
    /// over any a nested link already set.
    fn walk_linked(&mut self, nodes: &[Phrasing], style: Style, link: &LinkProvenance) {
        let start = self.runs.len();
        self.walk(nodes, style);
        for run in self.runs.iter_mut().skip(start) {
            run.link = Some(link.clone());
        }
    }

    fn emit_inline_code(&mut self, value: &str, style: Style) {
        let theme = self.opts.theme;
        let extra = Extra {
            code: true,
            backdrop: Some(panel_paint(theme, theme.panel_opacity)),
            backdrop_pad_x_px: Some(theme.inline_code_padding_x_px),
            ..Extra::default()
        };
        let face = Face { family: theme.mono_font_family, size_px: code_font_size_px(theme) };
        self.emit(value, &extra, style, ATOMIC, Some(face));
    }

    pub(super) fn walk(&mut self, nodes: &[Phrasing], style: Style) {
        for node in nodes {
            self.walk_node(node, style);
        }
    }

    fn walk_node(&mut self, node: &Phrasing, style: Style) {
        match node {
            Phrasing::Text { value } => self.emit_with_icons(value, style),
            Phrasing::InlineCode { value } => self.emit_inline_code(value, style),
            Phrasing::Break => self.junction.start_line(&self.runs, &mut self.line),
            Phrasing::Html { value } => self.emit(value, &Extra::default(), style, ATOMIC, None),
            Phrasing::Emphasis { children } => {
                self.walk(children, Style { emphasis: true, ..style });
            }
            Phrasing::Strong { children } => self.walk(children, Style { strong: true, ..style }),
            Phrasing::Delete { children } => self.walk(children, Style { deleted: true, ..style }),
            Phrasing::Link { url, title, children } => {
                let title = title.as_ref().filter(|t| !t.is_empty()).cloned();
                let link = LinkProvenance::Link { href: url.clone(), title };
                self.walk_linked(children, style, &link);
            }
            Phrasing::LinkReference { identifier, children, .. } => {
                let link = LinkProvenance::Link { href: format!("#{identifier}"), title: None };
                if children.is_empty() {
                    let extra = Extra { link: Some(link), ..Extra::default() };
                    self.emit(identifier, &extra, style, PROSE, None);
                } else {
                    self.walk_linked(children, style, &link);
                }
            }
            Phrasing::Image { url, alt, .. } => self.emit_image(url, alt.as_ref(), style),
            Phrasing::ImageReference { identifier, alt, .. } => {
                let text = alt.as_ref().unwrap_or(identifier);
                self.emit(text, &Extra::default(), style, PROSE, None);
            }
            // Drawn as TeX source, never typeset: the math renderer serves display math only.
            Phrasing::InlineMath { value } => {
                self.emit(value, &Extra::default(), style, UNCUTTABLE, None);
            }
            Phrasing::WikiLink { document_id, alias, fragment } => {
                self.emit_wiki_link(document_id, alias.as_ref(), fragment.as_ref(), style);
            }
            Phrasing::Embed { document_id, fragment } => {
                self.emit_embed(document_id, fragment.as_ref(), style);
            }
        }
    }
}

/// Lays `children` out from the block's top-left corner.
pub(super) fn layout_phrasing(
    children: &[Phrasing],
    cursor: Cursor,
    opts: &TypesetOptions<'_>,
    font_size: f64,
    line_height: f64,
) -> PhrasingLayout {
    let mut layout = InlineLayout {
        opts,
        cursor,
        font_size,
        line_height,
        runs: Vec::new(),
        line: LineCursor { x: 0.0, index: 0 },
        junction: create_inline_junction(line_height),
        can_wrap: opts.max_width.is_finite() && opts.max_width > 0.0,
    };
    layout.walk(children, Style::default());
    let ink_width =
        layout.runs.iter().fold(0.0, |widest: f64, run| widest.max(run.bbox.x + run.bbox.w));
    PhrasingLayout { runs: layout.runs, line_count: layout.line.index.saturating_add(1), ink_width }
}
