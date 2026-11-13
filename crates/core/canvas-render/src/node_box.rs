//! How ONE node's box is drawn, whatever it holds (`layout/node-box.ts`): the
//! chrome shape, the label run, where content sits inside the box and a
//! container's label above it, the content bounds a silhouette inscribes, and
//! the fit that cuts what cannot fit. The text, frame, link and file nodes are
//! all built from these.
//!
//! What the composer resolved about a node before it reaches the box, the
//! silhouette its facets and theme select and where a plugin wants its text, is
//! asked through [`NodeBoxHost`]: those readers live in the plugin and the
//! engine. The shape TABLE is the bundled visual plugin's, as in the SVG backend;
//! a caller-supplied table is not ported.

use whiteboard_det::math::{js_max, js_min};
use whiteboard_facet_engine::engine::{ThemeInk, ThemeTokens};
use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{
    Annotates, AnnotatesKind, Appearance, BoundingBox, ParagraphBlockNode, SceneInk, SceneInkFill,
    SceneInkStyle, SceneNode, ShapeSceneNode, TextRunNode,
};

use crate::measure::{FontDescriptor, FontStyle, Measure};
use crate::node_content::{frame_label, is_frame, is_image_ref, node_file, node_subpath, node_url};
use crate::node_outline::outline_content_box;
use crate::scene_walk::SceneWalk;
use crate::seed::seed_from_id;
use crate::theme::appearance::SpatialAppearanceResolver;
use crate::theme::geometry::SpatialGeometry;
use crate::translate_scene::translate_scene;
use crate::truncate::fit_to_width;
use crate::typeset::{FittedBlocks, fit_blocks_to_height};

/// Where a plugin wants a node's text (`visual.text/v0`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextPlacement {
    Start,
    Center,
}

/// What the composer resolved about a node before its box is drawn.
pub trait NodeBoxHost {
    /// The namespaced silhouette the node resolves to (`nodeOutlines[id]`): its
    /// own facet, else the theme's default shape. None draws the rect.
    fn silhouette(&self, node_id: &str) -> Option<&str>;

    /// Where the contributions place the node's text, the last one that answers
    /// winning; none keeps the default (a shaped node centres, a rect does not).
    fn text_placement(&self, node: &SpatialNode) -> Option<TextPlacement>;
}

/// What the box primitives read of the layout's settled options.
#[derive(Clone, Copy)]
pub struct NodeBoxOptions<'a> {
    pub measure: &'a dyn Measure,
    pub appearance: &'a dyn SpatialAppearanceResolver,
    pub geometry: SpatialGeometry,
    /// Content is cut to the box. Off only when asking how big a box must be,
    /// which also leaves a silhouette's inscribed box out of it.
    pub fit_to_box: bool,
    /// The theme in force for the canvas being laid out; none draws clean.
    pub theme: Option<&'a ThemeTokens>,
    pub host: &'a dyn NodeBoxHost,
}

/// A picture a reference resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceImage {
    pub href: String,
    pub alt: Option<String>,
}

/// One `label: value` row of a facet card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetRow {
    pub label: String,
    pub value: String,
}

/// A card the caller built from the referenced document's facets: a heading
/// and labelled rows, presentation-shaped, so this crate learns nothing of what
/// a facet means.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FacetCard {
    pub title: Option<String>,
    pub rows: Vec<FacetRow>,
}

/// What a file node's reference resolves to (`references/resolved.ts`), the
/// fields the composer reads. A referenced canvas is the host's to embed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResolvedReference {
    pub label: Option<String>,
    pub missing: bool,
    pub image: Option<ReferenceImage>,
    /// A referenced markdown document's parsed body.
    pub markdown: Option<Root>,
    pub facets: Option<FacetCard>,
}

/// Where a label is drawn: above the box, as a container's is, or inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelPlace {
    Above,
    Inside,
}

/// Gap between a container's outside label and its frame's top edge.
const CONTAINER_LABEL_GAP_PX: f64 = 4.0;

const fn node_box(node: &SpatialNode) -> BoundingBox {
    BoundingBox { x: node.x, y: node.y, w: node.width, h: node.height }
}

/// The box a node's content lays out against: the silhouette's inscribed box for
/// a shaped node when content is fitted, the node's own box otherwise.
#[must_use]
pub fn node_content_bounds(node: &SpatialNode, options: &NodeBoxOptions<'_>) -> BoundingBox {
    let bbox = node_box(node);
    if !options.fit_to_box {
        return bbox;
    }
    outline_content_box(options.host.silhouette(&node.id), &bbox)
}

/// A node's content bounds and the padding kept inside them, per axis. A
/// silhouette's inscribed box already stands back from the node's edge, and that
/// gap IS the margin the stroke needs, so the padding only tops it up.
struct ContentArea {
    bounds: BoundingBox,
    pad_x: f64,
    pad_y: f64,
}

impl ContentArea {
    fn of(node: &SpatialNode, options: &NodeBoxOptions<'_>) -> Self {
        let bounds = node_content_bounds(node, options);
        let padding = options.geometry.padding_px;
        let pad = |node_at: f64, node_size: f64, at: f64, size: f64| {
            let inset = js_min(at - node_at, node_at + node_size - (at + size));
            js_max(0.0, padding - js_max(0.0, inset))
        };
        Self {
            pad_x: pad(node.x, node.width, bounds.x, bounds.w),
            pad_y: pad(node.y, node.height, bounds.y, bounds.h),
            bounds,
        }
    }

    fn inner_w(&self) -> f64 {
        self.bounds.w - 2.0 * self.pad_x
    }

    fn inner_h(&self) -> f64 {
        self.bounds.h - 2.0 * self.pad_y
    }
}

/// The width a node's content wraps at, never under the geometry's floor.
#[must_use]
pub fn content_width(node: &SpatialNode, options: &NodeBoxOptions<'_>) -> f64 {
    let width = ContentArea::of(node, options).inner_w();
    let floor = options.geometry.min_content_width_px;
    if width.is_finite() && width > floor { width } else { floor }
}

/// The ink a DOCUMENT node or edge carries under a sketch theme, seeded from its
/// id. Comment and proposal chrome are built elsewhere and stay crisp.
#[must_use]
pub fn sketch_ink_for(id: &str, options: &NodeBoxOptions<'_>, hatch: bool) -> Option<SceneInk> {
    options.theme.filter(|tokens| tokens.ink == ThemeInk::Sketch)?;
    Some(SceneInk {
        style: SceneInkStyle::Sketch,
        seed: seed_from_id(id),
        fill: hatch.then_some(SceneInkFill::Hatch),
    })
}

/// The node's chrome: its box, the silhouette it resolved to, and its paint. A
/// coloured node is hatched over its tint under a pencil; a frame keeps its
/// colour on the line.
#[must_use]
pub fn chrome_shape(node: &SpatialNode, options: &NodeBoxOptions<'_>) -> ShapeSceneNode {
    let resolved = options.appearance.resolve_node(node);
    let hatch = node.color.is_some() && !is_frame(node);
    ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: Some(node.id.clone()),
        bbox: node_box(node),
        comment_chrome: false,
        proposal_chrome: None,
        radius: resolved.radius,
        shape: options.host.silhouette(&node.id).map(str::to_owned),
        appearance: resolved.appearance,
        task_box: None,
        ink: sketch_ink_for(&node.id, options, hatch),
    }
}

/// The chrome carrying whether the content fits and whether anything was cut:
/// a node's content is a sibling of its chrome in the flat scene, so the chrome
/// is where a digest can read it.
#[must_use]
pub fn chrome_with_fit(
    node: &SpatialNode,
    options: &NodeBoxOptions<'_>,
    truncated: bool,
    overflows: bool,
) -> ShapeSceneNode {
    ShapeSceneNode { truncated, overflows, ..chrome_shape(node, options) }
}

/// A one-line label at the content origin, cut to `max_width`: one line is what
/// makes it a label, so cutting is the only way to keep it in the box. Its box is
/// its true top-left with the baseline given explicitly.
#[must_use]
pub fn label_run(text: &str, options: &NodeBoxOptions<'_>, max_width: f64) -> TextRunNode {
    let appearance = options.appearance.resolve_label();
    let size_px = options.geometry.label_font_size_px;
    let font = FontDescriptor {
        family: appearance.font_family.clone().unwrap_or_else(|| "sans-serif".to_owned()),
        fallback_chain: Vec::new(),
        weight: 400.0,
        style: FontStyle::Normal,
        size_px,
    };
    let fitted = fit_to_width(text, &font, options.measure, max_width);
    let metrics = options.measure.measure(fitted.text, &font);
    TextRunNode {
        bbox: BoundingBox {
            x: 0.0,
            y: 0.0,
            w: metrics.advance_width,
            h: metrics.ascent + metrics.descent,
        },
        text: fitted.text.to_owned(),
        truncated: fitted.truncated,
        overflows: fitted.overflows,
        appearance: Some(Appearance { font_size: Some(size_px), ..appearance }),
        baseline: Some(metrics.ascent),
        ..crate::typeset::empty_run()
    }
}

/// `Math.max(0, ...values)`.
fn max_from_zero(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(0.0, js_max)
}

fn paragraph_with_runs(entry: &SceneNode) -> Option<&ParagraphBlockNode> {
    match entry {
        SceneNode::Paragraph(p) if !p.runs.is_empty() => Some(p),
        _ => None,
    }
}

fn run_right(run: &TextRunNode) -> f64 {
    run.bbox.x + run.bbox.w
}

/// Right edge of what is drawn: a paragraph's box spans the wrap width, its
/// runs do not; an edge has no box and counts as nothing.
fn ink_right(entry: &SceneNode) -> f64 {
    if let Some(paragraph) = paragraph_with_runs(entry) {
        return paragraph.runs.iter().map(run_right).fold(f64::NEG_INFINITY, js_max);
    }
    SceneWalk::Node(entry).bbox().map_or(0.0, |b| b.x + b.w)
}

/// Bottom of what is drawn; an edge counts as nothing.
fn bottom(entry: &SceneNode) -> f64 {
    SceneWalk::Node(entry).bbox().map_or(0.0, |b| b.y + b.h)
}

/// A paragraph whose runs sit off its left edge, its box shrunk to them.
fn tighten_to_ink(mut paragraph: ParagraphBlockNode) -> ParagraphBlockNode {
    let left = paragraph.runs.iter().map(|run| run.bbox.x).fold(f64::INFINITY, js_min);
    let right = paragraph.runs.iter().map(run_right).fold(f64::NEG_INFINITY, js_max);
    paragraph.bbox.x = left;
    paragraph.bbox.w = right - left;
    paragraph
}

/// A `Map` key for a number: NaN is itself and the two zeros are one key.
fn map_key(n: f64) -> u64 {
    if n.is_nan() {
        f64::NAN.to_bits()
    } else if n == 0.0 {
        0
    } else {
        n.to_bits()
    }
}

/// Each line of a paragraph moved so its ink is centred in `width`. A line is
/// the runs that share a top, in the order its first run appears.
fn centre_lines(paragraph: &ParagraphBlockNode, width: f64) -> ParagraphBlockNode {
    let mut lines: Vec<Vec<TextRunNode>> = Vec::new();
    let mut by_top: std::collections::BTreeMap<u64, usize> = std::collections::BTreeMap::new();
    for run in &paragraph.runs {
        let next = lines.len();
        let index = *by_top.entry(map_key(run.bbox.y)).or_insert(next);
        match lines.get_mut(index) {
            Some(line) => line.push(run.clone()),
            None => lines.push(vec![run.clone()]),
        }
    }
    let mut runs = Vec::with_capacity(paragraph.runs.len());
    for mut line in lines {
        let left = line.iter().map(|run| run.bbox.x).fold(f64::INFINITY, js_min);
        let right = line.iter().map(run_right).fold(f64::NEG_INFINITY, js_max);
        let used = right - left;
        let shift = if used < width { (width - used) / 2.0 - left } else { 0.0 };
        for run in &mut line {
            run.bbox.x += shift;
        }
        runs.extend(line);
    }
    tighten_to_ink(ParagraphBlockNode { bbox: paragraph.bbox, runs })
}

/// How far down a shaped node's content moves to sit centred vertically.
fn vertical_centre_offset(content: &[SceneNode], node: &SpatialNode, area: &ContentArea) -> f64 {
    let ContentArea { bounds, pad_y, .. } = area;
    let inner_h = area.inner_h();
    let content_h = max_from_zero(content.iter().map(bottom));
    if content_h < inner_h {
        return (inner_h - content_h) / 2.0;
    }
    if content_h > node.height {
        return 0.0;
    }
    // Taller than the padded inscribed box yet inside the node (a cylinder's caps
    // leave little between them): centre on the inscribed box, kept in the node.
    let top = bounds.y + (bounds.h - content_h) / 2.0;
    let clamped = js_min(js_max(top, node.y), node.y + node.height - content_h);
    clamped - (bounds.y + pad_y)
}

/// A wrapped paragraph centred line by line, everything else moved by `dx`.
fn centre_content(content: &[SceneNode], width: f64, dx: f64) -> Vec<SceneNode> {
    content
        .iter()
        .flat_map(|entry| match paragraph_with_runs(entry) {
            Some(paragraph) => vec![SceneNode::Paragraph(centre_lines(paragraph, width))],
            None => translate_scene(std::slice::from_ref(entry), dx, 0.0),
        })
        .collect()
}

/// Content laid out at the origin, placed in the node's padded content bounds.
/// A shaped node centres content that fits, a plain rect does not, and a text
/// placement the contributions answer overrides that either way.
#[must_use]
pub fn place_in_node(
    node: &SpatialNode,
    content: &[SceneNode],
    options: &NodeBoxOptions<'_>,
) -> Vec<SceneNode> {
    let area = ContentArea::of(node, options);
    let centres = match options.host.text_placement(node) {
        None => options.host.silhouette(&node.id).is_some(),
        Some(placement) => placement == TextPlacement::Center,
    };
    let mut dy = 0.0;
    let placed = if options.fit_to_box && centres {
        let inner_w = area.inner_w();
        let ink_w = max_from_zero(content.iter().map(ink_right));
        let dx = if ink_w < inner_w { (inner_w - ink_w) / 2.0 } else { 0.0 };
        dy = vertical_centre_offset(content, node, &area);
        centre_content(content, inner_w, dx)
    } else {
        content.to_vec()
    };
    let ContentArea { bounds, pad_x, pad_y } = area;
    translate_scene(&placed, bounds.x + pad_x, bounds.y + pad_y + dy)
}

/// A container's label placed OUTSIDE its frame, above the top-left corner (the
/// JSON Canvas convention), each run marked as the label of the node.
#[must_use]
pub fn place_above_node(node: &SpatialNode, content: &[SceneNode]) -> Vec<SceneNode> {
    let lowest = max_from_zero(content.iter().map(bottom));
    let mut placed = translate_scene(content, node.x, node.y - CONTAINER_LABEL_GAP_PX - lowest);
    for entry in &mut placed {
        if let SceneNode::TextRun(run) = entry {
            run.annotates = Some(Annotates { kind: AnnotatesKind::Node, id: node.id.clone() });
        }
    }
    placed
}

/// `String.prototype.trim`: ECMAScript's `WhiteSpace` and `LineTerminator`,
/// which is not Unicode's `White_Space` (U+FEFF is trimmed, U+0085 is not).
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

const fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// What an image node is called when its picture is not drawn: its alt text, or
/// "Image", since the reference is a storage id that names nothing a reader knows.
fn image_label(resolved: Option<&ResolvedReference>) -> String {
    let alt = resolved.and_then(|r| r.image.as_ref()?.alt.as_deref());
    match alt.map(js_trim) {
        Some(alt) if !alt.is_empty() => alt.to_owned(),
        _ => "Image".to_owned(),
    }
}

/// The readable label of a non-text node, or none. A file's reference is an
/// opaque id, so its resolved name stands in, and its subpath follows only a
/// target that was found.
#[must_use]
pub fn label_of(node: &SpatialNode, resolved: Option<&ResolvedReference>) -> Option<String> {
    if let Some(file) = node_file(node) {
        if resolved.is_some_and(|r| r.missing) {
            return Some("Missing reference".to_owned());
        }
        let base = match resolved.and_then(|r| r.label.clone()) {
            Some(label) => label,
            None if is_image_ref(file) => image_label(resolved),
            None => file.to_owned(),
        };
        // An empty subpath appends nothing, which is the TypeScript's falsy test.
        return Some(base + node_subpath(node).unwrap_or_default());
    }
    if let Some(url) = node_url(node) {
        return Some(url.to_owned());
    }
    frame_label(node).filter(|label| !label.is_empty()).map(str::to_owned)
}

/// The padded content box's height, when the box has room in both directions.
pub(crate) fn content_box_height(node: &SpatialNode, options: &NodeBoxOptions<'_>) -> Option<f64> {
    let area = ContentArea::of(node, options);
    let h = area.inner_h();
    (area.inner_w() > 0.0 && h > 0.0).then_some(h)
}

/// The top prefix of laid-out content that fits the node's padded content box:
/// the one place a box's HEIGHT is enforced. None for a degenerate box, or when
/// nothing fits, so a caller degrades to its own lower-ranked rendering.
#[must_use]
pub fn fit_scene_in_node(
    content: &[SceneNode],
    node: &SpatialNode,
    options: &NodeBoxOptions<'_>,
) -> Option<FittedBlocks> {
    if !options.fit_to_box {
        return Some(FittedBlocks { nodes: content.to_vec(), truncated: false, overflows: false });
    }
    let fitted = fit_blocks_to_height(content, content_box_height(node, options)?);
    (!fitted.nodes.is_empty()).then_some(fitted)
}

/// A node's label drawn above the box or inside it; nothing when it has none.
#[must_use]
pub fn label_runs(
    node: &SpatialNode,
    label: Option<&str>,
    place: LabelPlace,
    options: &NodeBoxOptions<'_>,
) -> Vec<SceneNode> {
    let Some(label) = label else { return Vec::new() };
    match place {
        LabelPlace::Above => {
            let run = label_run(label, options, node.width);
            place_above_node(node, &[SceneNode::TextRun(Box::new(run))])
        }
        LabelPlace::Inside => {
            let run = label_run(label, options, content_width(node, options));
            place_in_node(node, &[SceneNode::TextRun(Box::new(run))], options)
        }
    }
}
