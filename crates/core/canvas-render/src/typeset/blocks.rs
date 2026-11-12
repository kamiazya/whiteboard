//! The block level: a paragraph, a heading and the figure a lone picture is,
//! ported from `layoutBlock`, `layoutFigure` and `blockWidth`.

use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_scene::{
    Appearance, BoundingBox, HeadingBlockNode, ParagraphBlockNode, RunPaint, Scene, SceneNode,
    TextRunNode,
};

use super::code::layout_code;
use super::furniture::{layout_definition, layout_html, layout_math, layout_rule};
use super::options::{Cursor, TypesetOptions, body_line_height_px, finite_positive};
use super::phrasing::{count_f64, layout_phrasing};

/// A block kind the typesetter does not carry yet. The set shrinks with each
/// slice of the port, and the error goes with the last of it: a partial
/// typesetter that dropped what it could not draw would make every later
/// recording disagree for a reason nobody named.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsupported(pub &'static str);

const IMAGE_PLACEHOLDER: &str = "\u{2002}";

/// A block's declared width. Normally the wrap width, widened to cover an
/// atomic run that could not be split: the box has to describe what is painted,
/// since the scene bounds and everything downstream read this and nothing else.
/// A non-finite wrap width (wrapping disabled) is passed through unchanged.
fn block_width(max_width: f64, ink_width: f64) -> f64 {
    if max_width.is_finite() && ink_width > max_width { ink_width } else { max_width }
}

fn kind_of(flow: &Flow) -> &'static str {
    match flow {
        Flow::Paragraph { .. } => "paragraph",
        Flow::Heading { .. } => "heading",
        Flow::Blockquote { .. } => "blockquote",
        Flow::List { .. } => "list",
        Flow::Code { .. } => "code",
        Flow::Html { .. } => "html",
        Flow::ThematicBreak => "thematicBreak",
        Flow::Definition { .. } => "definition",
        Flow::Table { .. } => "table",
        Flow::Math { .. } => "math",
    }
}

/// The single mdast to scene path, as far as it is ported.
///
/// # Errors
///
/// [`Unsupported`] names the first block kind not yet carried.
pub fn typeset_mdast_blocks(root: &Root, opts: &TypesetOptions<'_>) -> Result<Scene, Unsupported> {
    let mut cursor = Cursor { x: 0.0, y: 0.0 };
    let mut nodes = Vec::with_capacity(root.children.len());
    for block in &root.children {
        nodes.push(layout_block(block, &mut cursor, opts)?);
    }
    Ok(Scene { nodes, legend: None })
}

fn layout_block(
    block: &Flow,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> Result<SceneNode, Unsupported> {
    match block {
        Flow::Heading { depth, children } => Ok(layout_heading(*depth, children, cursor, opts)),
        Flow::Paragraph { children } => {
            // A paragraph that IS an embed lays the target's body out as a block.
            if matches!(children.as_slice(), [Phrasing::Embed { .. }]) {
                return Err(Unsupported("embed"));
            }
            Ok(layout_paragraph(children, cursor, opts))
        }
        Flow::Code { value, lang, .. } => Ok(layout_code(value, lang.as_deref(), cursor, opts)),
        Flow::Html { value } => Ok(layout_html(value, cursor, opts)),
        Flow::ThematicBreak => Ok(layout_rule(cursor, opts)),
        Flow::Definition { identifier, .. } => Ok(layout_definition(identifier, cursor)),
        Flow::Math { value, .. } => Ok(layout_math(value, cursor, opts)),
        other => Err(Unsupported(kind_of(other))),
    }
}

fn layout_heading(
    depth: u8,
    children: &[Phrasing],
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    let theme = opts.theme;
    // A heading belongs to what FOLLOWS it, so it takes more air above than
    // below. Not applied to a leading heading, which would start the body with a
    // blank band.
    if cursor.y > 0.0 {
        cursor.y += theme.heading_space_above_px;
    }
    let sizes = &theme.heading_font_size_px;
    let font_size = usize::from(depth)
        .checked_sub(1)
        .and_then(|at| sizes.get(at))
        .or(sizes.last())
        .copied()
        .unwrap_or(theme.body_font_size_px);
    let line_height = font_size * theme.heading_line_height;
    let laid = layout_phrasing(children, *cursor, opts, font_size, line_height);
    let height = count_f64(laid.line_count) * line_height;
    let heading = HeadingBlockNode {
        bbox: BoundingBox {
            x: cursor.x,
            y: cursor.y,
            w: block_width(opts.max_width, laid.ink_width),
            h: height,
        },
        level: depth,
        runs: laid.runs,
    };
    cursor.y += height + theme.block_gap_px;
    SceneNode::Heading(heading)
}

fn layout_paragraph(
    children: &[Phrasing],
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    if let Some(figure) = layout_figure(children, cursor, opts) {
        return SceneNode::Paragraph(figure);
    }
    let theme = opts.theme;
    let line_height = body_line_height_px(theme);
    let laid = layout_phrasing(children, *cursor, opts, theme.body_font_size_px, line_height);
    let height = count_f64(laid.line_count) * line_height;
    let paragraph = ParagraphBlockNode {
        bbox: BoundingBox {
            x: cursor.x,
            y: cursor.y,
            w: block_width(opts.max_width, laid.ink_width),
            h: height,
        },
        runs: laid.runs,
    };
    cursor.y += height + theme.block_gap_px;
    SceneNode::Paragraph(paragraph)
}

/// A paragraph whose only content is one picture of KNOWN natural size: a
/// figure, drawn at that size and scaled down to the column with its aspect
/// kept. Still a paragraph holding one image run, so the painter and the
/// outline read it as they read an inline one; only the run's box is the
/// picture's rather than a line's. `None` when the paragraph is anything else.
fn layout_figure(
    children: &[Phrasing],
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> Option<ParagraphBlockNode> {
    let mut content = children
        .iter()
        .filter(|child| !matches!(child, Phrasing::Text { value } if super::text::trim_end(super::text::trim_start(value)).is_empty()));
    let (Some(Phrasing::Image { url, alt, .. }), None) = (content.next(), content.next()) else {
        return None;
    };
    let image = opts.seams.image_reference(url)?;
    let (width, height) = (finite_positive(image.width)?, finite_positive(image.height)?);
    let column =
        if opts.max_width.is_finite() && opts.max_width > 0.0 { opts.max_width } else { width };
    let scale = (column / width).min(1.0);
    let bbox = BoundingBox { x: cursor.x, y: cursor.y, w: width * scale, h: height * scale };
    let alt = alt.as_deref().filter(|a| !a.is_empty());
    let run = TextRunNode {
        bbox,
        baseline: Some(bbox.h),
        text: alt.unwrap_or(IMAGE_PLACEHOLDER).to_owned(),
        paints: Some(RunPaint::Image { src: image.href }),
        appearance: Some(Appearance {
            fill: opts.text_fill.map(str::to_owned),
            font_family: Some(opts.font_family.to_owned()),
            font_size: Some(opts.theme.body_font_size_px),
            ..Appearance::default()
        }),
        ..empty_run()
    };
    cursor.y += bbox.h + opts.theme.block_gap_px;
    Some(ParagraphBlockNode { bbox, runs: vec![run] })
}

pub(super) fn empty_run() -> TextRunNode {
    TextRunNode {
        bbox: BoundingBox { x: 0.0, y: 0.0, w: 0.0, h: 0.0 },
        text: String::new(),
        emphasis: false,
        strong: false,
        code: false,
        deleted: false,
        link: None,
        truncated: false,
        overflows: false,
        appearance: None,
        paints: None,
        backdrop: None,
        backdrop_pad_x_px: None,
        annotates: None,
        baseline: None,
    }
}
