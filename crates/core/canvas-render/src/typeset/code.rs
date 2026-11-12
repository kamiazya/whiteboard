//! A fenced code block, ported from `mdast-code-block.ts`: one run per SOURCE
//! line, each line cut rather than wrapped, tokenised through the host's
//! highlighter when it has one.
//!
//! One run per source line because a single `<text>` carrying the whole fence
//! paints it on one line (SVG collapses the newlines). A line never WRAPS, as
//! its indentation and its identity as one line are the point, so the only way
//! to keep it inside the panel is to cut it, as an atomic inline run is cut.

use whiteboard_scene::{Appearance, BoundingBox, CodeBlockNode, SceneNode, TextRunNode};

use crate::measure::clamp_advance;
use crate::truncate::{FittedText, fit_to_width};

use super::furniture::place_fragment;
use super::options::{
    Cursor, Style, TypesetOptions, baseline_in, body_font, code_font_size_px, code_line_height_px,
    panel_paint,
};
use super::phrasing::count_f64;
use super::seams::{CodeToken, CodeTokenLines};

/// The highlighter's answer, or plain source when it is unusable: absent, no
/// answer, or a line count that disagrees with the source's, which is the
/// authority on how many lines a fence has since the block's height is
/// computed from it.
fn tokenize(
    lang: &str,
    value: &str,
    line_count: usize,
    opts: &TypesetOptions<'_>,
) -> CodeTokenLines {
    let plain = || {
        value
            .split('\n')
            .map(|text| vec![CodeToken { text: text.to_owned(), role: None }])
            .collect()
    };
    match opts.highlight.and_then(|h| h.tokenize(lang, value)) {
        Some(lines) if lines.len() == line_count => lines,
        _ => plain(),
    }
}

/// One token as a run at `at`, filled by its role's colour else the body's.
fn token_run(
    token: &CodeToken,
    fitted: &FittedText<'_>,
    at: BoundingBox,
    baseline: f64,
    opts: &TypesetOptions<'_>,
) -> TextRunNode {
    let role_fill = token.role.and_then(|role| opts.syntax.and_then(|s| s.fill(role)));
    let theme = opts.theme;
    TextRunNode {
        bbox: at,
        baseline: Some(clamp_advance(baseline)),
        text: fitted.text.to_owned(),
        code: true,
        truncated: fitted.truncated,
        overflows: fitted.overflows,
        appearance: Some(Appearance {
            fill: role_fill.or(opts.text_fill).map(str::to_owned),
            font_family: Some(theme.mono_font_family.to_owned()),
            font_size: Some(code_font_size_px(theme)),
            ..Appearance::default()
        }),
        ..empty_run()
    }
}

/// One source line as runs, laid left to right. The line's width budget is
/// shared across its tokens: fitting each against the full width would let a
/// highlighted line run out of a panel a plain line is cut to stay inside.
fn line_runs(
    tokens: &[CodeToken],
    index: usize,
    cursor: Cursor,
    opts: &TypesetOptions<'_>,
    inner_width: f64,
) -> Vec<TextRunNode> {
    let theme = opts.theme;
    let line_height = code_line_height_px(theme);
    let size = code_font_size_px(theme);
    let font = body_font(theme.mono_font_family, size, Style::default());
    let y = cursor.y + theme.code_block_padding_px + count_f64(index) * line_height;
    let mut runs = Vec::new();
    let mut x = 0.0_f64;
    for token in tokens {
        let fitted = fit_to_width(&token.text, &font, opts.measure, inner_width - x);
        if fitted.text.is_empty() {
            break;
        }
        let metrics = opts.measure.measure(fitted.text, &font);
        let width = clamp_advance(metrics.advance_width);
        let at = BoundingBox {
            x: cursor.x + theme.code_block_padding_px + x,
            y,
            w: width,
            h: line_height,
        };
        runs.push(token_run(
            token,
            &fitted,
            at,
            baseline_in(line_height, size, metrics.ascent),
            opts,
        ));
        x += width;
        // Either flag means the line's remaining width is spent: a token kept
        // past the panel leaves the next width negative, which `fit_to_width`
        // reads as "no width to fit against" and answers with the WHOLE token.
        if fitted.truncated || fitted.overflows {
            break;
        }
    }
    runs
}

/// A fenced block. A language whose diagram renderer answers takes over the
/// block entirely; everything else is laid out as source.
pub(super) fn layout_code(
    value: &str,
    lang: Option<&str>,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    let lang = lang.filter(|l| !l.is_empty());
    if let Some(lang) = lang
        && let Some(rendered) = opts.diagram.and_then(|d| d.render_diagram(lang, value))
    {
        return place_fragment(rendered, cursor, opts);
    }
    let theme = opts.theme;
    let line_count = value.split('\n').count();
    let height =
        count_f64(line_count) * code_line_height_px(theme) + 2.0 * theme.code_block_padding_px;
    let inner_width = opts.max_width - 2.0 * theme.code_block_padding_px;
    let lines = tokenize(lang.unwrap_or_default(), value, line_count, opts);
    let runs = lines
        .iter()
        .enumerate()
        .flat_map(|(index, tokens)| line_runs(tokens, index, *cursor, opts, inner_width))
        .collect();
    let block = CodeBlockNode {
        bbox: BoundingBox { x: cursor.x, y: cursor.y, w: opts.max_width, h: height },
        value: value.to_owned(),
        lang: lang.map(str::to_owned),
        runs: Some(runs),
        appearance: Some(panel_paint(theme, theme.panel_opacity)),
        radius: Some(theme.corner_radius_px),
    };
    cursor.y += height + theme.block_gap_px;
    SceneNode::CodeBlock(block)
}

fn empty_run() -> TextRunNode {
    super::blocks::empty_run()
}
