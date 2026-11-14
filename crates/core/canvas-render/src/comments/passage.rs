//! The annotation layer's projection onto a text node's laid-out text
//! (`layout/passage-highlight.ts`): the passage a thread is about, highlighted
//! behind the words it quotes.
//!
//! The passage is re-found in the RENDERED text rather than mapped from its
//! stored offsets, which index the node's markdown source while the runs hold
//! what it rendered to (markers gone, lines wrapped). A quote survives that
//! the way it survives an edit. A quote spanning a marker (`**plan**` selected
//! with its stars) is not found and draws nothing; the pin still says the
//! conversation exists. Whitespace is compared loosely, because wrapping trims
//! a line's trailing space.
//!
//! Offsets count UTF-16 code units, as the TypeScript's do.

use std::cmp::Ordering;

use whiteboard_det::utf16::is_js_whitespace;
use whiteboard_model::annotation::{AnnotationAnchor, CommentThread};
use whiteboard_model::spatial::SpatialNode;
use whiteboard_model::text_anchor::{
    ContextSide, SCORED_OCCURRENCES_MAX, TextAnchor, TextQuote, resolve_text_anchor,
    scored_occurrence_range, shared_context,
};
use whiteboard_scene::{Appearance, BoundingBox, SceneNode, TextRunNode};

use super::chrome_shape;
use super::loose::{LooseSpan, loose_occurrences, squash};
use crate::compose_node::ComposeOptions;
use crate::measure::{FontDescriptor, Measure, clamp_advance};
use crate::scene_walk::SceneWalk;
use crate::typeset::{FittedBlocks, Style, body_font};

/// A gap wider than this share of a run's height stands for a space the layout
/// encoded as an x offset: a space at 12px is not a space at 48px, and the
/// height is the only size a run carries (`SPACE_GAP_RATIO`).
const SPACE_GAP_RATIO: f64 = 0.15;

const SPACE: u16 = 0x20;

/// A highlight's corner radius.
const PASSAGE_RADIUS_PX: f64 = 2.0;

/// A thread about a passage of one node's text, as the layout needs it.
#[derive(Debug, Clone, Copy)]
pub struct NodePassage<'t> {
    pub thread_id: &'t str,
    pub anchor: &'t TextAnchor,
    pub resolved: bool,
}

/// The paint of an open passage and of a settled one.
#[derive(Debug, Clone, Copy, Default)]
pub struct PassagePaint<'a> {
    pub open: Option<&'a Appearance>,
    pub resolved: Option<&'a Appearance>,
}

/// Every text run under `nodes`, in reading order (`collectTextRuns`).
#[must_use]
pub fn collect_text_runs(nodes: &[SceneNode]) -> Vec<&TextRunNode> {
    fn visit<'a>(node: SceneWalk<'a>, out: &mut Vec<&'a TextRunNode>) {
        out.extend(node.text_run());
        for child in node.children() {
            visit(child, out);
        }
    }
    let mut out = Vec::new();
    for node in nodes {
        visit(SceneWalk::Node(node), &mut out);
    }
    out
}

/// A run, and where its text starts in the rendered string.
struct Piece<'r> {
    run: &'r TextRunNode,
    at: usize,
}

/// The runs read as one string, a space standing in for each one the layout
/// dropped (`renderedTextOf`).
pub struct RenderedText<'r> {
    text: Vec<u16>,
    pieces: Vec<Piece<'r>>,
}

/// Whether the source had whitespace between two adjacent runs: a new line, or
/// a gap on the same line wider than a fraction of the run's height. Runs split
/// at an inline boundary with no gap (`**bold**face`) are one word.
fn separated(previous: &TextRunNode, run: &TextRunNode) -> bool {
    // `!==`: a NaN differs from everything, and -0 equals 0.
    let new_line = run.bbox.y.partial_cmp(&previous.bbox.y) != Some(Ordering::Equal);
    new_line || run.bbox.x - (previous.bbox.x + previous.bbox.w) > run.bbox.h * SPACE_GAP_RATIO
}

/// The runs as the search reads them.
#[must_use]
pub fn rendered_text_of<'r>(runs: &[&'r TextRunNode]) -> RenderedText<'r> {
    let mut rendered = RenderedText { text: Vec::new(), pieces: Vec::new() };
    let mut previous: Option<&TextRunNode> = None;
    for &run in runs {
        let ends_in_space = rendered.text.last().is_some_and(|&unit| is_js_whitespace(unit));
        if previous.is_some_and(|previous| !ends_in_space && separated(previous, run)) {
            rendered.text.push(SPACE);
        }
        rendered.pieces.push(Piece { run, at: rendered.text.len() });
        rendered.text.extend(run.text.encode_utf16());
        previous = Some(run);
    }
    rendered
}

/// The rendered text read outward from `at` one step at a time, a whitespace
/// run read as one space, produced only as far as a comparison asks.
struct Outward<'t> {
    text: &'t [u16],
    at: Option<usize>,
    forward: bool,
    seen: Vec<u16>,
}

impl Outward<'_> {
    fn blank(&self, at: usize) -> bool {
        self.text.get(at).is_some_and(|&unit| is_js_whitespace(unit))
    }

    /// Where the read after the one at `at` starts: the next unit, past the
    /// rest of the whitespace run when the one read was whitespace.
    fn after(&self, at: usize, space: bool) -> Option<usize> {
        if self.forward {
            let next = at.checked_add(1)?;
            let end = self.text.len();
            Some(if space { (next..end).find(|&i| !self.blank(i)).unwrap_or(end) } else { next })
        } else {
            let next = at.checked_sub(1)?;
            if space { (0..=next).rev().find(|&i| !self.blank(i)) } else { Some(next) }
        }
    }

    fn read(&mut self, k: usize) -> Option<u16> {
        while self.seen.len() <= k {
            let at = self.at?;
            let unit = *self.text.get(at)?;
            let space = is_js_whitespace(unit);
            self.seen.push(if space { SPACE } else { unit });
            self.at = self.after(at, space);
        }
        self.seen.get(k).copied()
    }
}

/// The node's markdown source and the anchor's stored offsets into it.
#[derive(Debug, Clone, Copy)]
pub struct PassageSource<'s> {
    pub text: &'s [u16],
    pub start: usize,
    pub end: usize,
}

/// Which of the quote's loose occurrences in the SOURCE the model resolves the
/// anchor to, if any does, and how many there are.
struct SourceOccurrence {
    index: Option<usize>,
    count: usize,
}

/// `None` when the source no longer holds the quote at all (`sourceOccurrence`).
fn source_occurrence(source: &PassageSource<'_>, quote: &TextQuote) -> Option<SourceOccurrence> {
    let anchor =
        TextAnchor { node_id: None, quote: quote.clone(), start: source.start, end: source.end };
    let placed = resolve_text_anchor(source.text, &anchor)?;
    let exact: Vec<u16> = quote.exact.encode_utf16().collect();
    // A loose occurrence starts at the quote's first non-blank character.
    let lead = exact.iter().take_while(|&&unit| is_js_whitespace(unit)).count();
    let starts = loose_occurrences(source.text, &exact);
    let first = placed.start.saturating_add(lead);
    let index = starts.iter().position(|span| span.start == first);
    Some(SourceOccurrence { index, count: starts.len() })
}

/// Where the quote sits in the rendered text (`findPassage`): the
/// same-numbered occurrence as the one the model resolves in the source, while
/// rendering kept every occurrence (one inside an HTML comment it does not);
/// otherwise the best-scored by remembered context among those nearest that
/// number scaled to the rendered count, a tie going to the first.
///
/// The TypeScript also answers without a source; no caller asks it to.
fn find_passage(
    rendered: &[u16],
    quote: &TextQuote,
    source: &PassageSource<'_>,
) -> Option<LooseSpan> {
    let exact: Vec<u16> = quote.exact.encode_utf16().collect();
    let matches = loose_occurrences(rendered, &exact);
    let last = matches.len().checked_sub(1)?;
    let in_source = source_occurrence(source, quote)?;
    let same = in_source.index.and_then(|index| matches.get(index));
    if let Some(&same) = same.filter(|_| in_source.count == matches.len()) {
        return Some(same);
    }
    // `Math.round(index * count / sourceCount)` in integers, the half rounding
    // up; a source count of zero leaves `around` at the start.
    let numbered = in_source.index.unwrap_or(0);
    let twice = numbered.saturating_mul(matches.len()).saturating_mul(2);
    let scaled =
        twice.saturating_add(in_source.count).checked_div(in_source.count.saturating_mul(2));
    let around = scaled.and_then(|s| matches.get(last.min(s))).map_or(0, |span| span.start);
    let starts: Vec<usize> = matches.iter().map(|span| span.start).collect();
    let range = scored_occurrence_range(&starts, around, SCORED_OCCURRENCES_MAX);
    best_scored(rendered, matches.get(range.from..range.to).unwrap_or_default(), quote)
}

/// The match sharing the most of the quote's remembered context, the first of
/// equals (`bestScored`).
fn best_scored(rendered: &[u16], matches: &[LooseSpan], quote: &TextQuote) -> Option<LooseSpan> {
    let squashed = |context: Option<&String>| {
        squash(&context.map(|c| c.encode_utf16().collect::<Vec<_>>()).unwrap_or_default())
    };
    let prefix = squashed(quote.prefix.as_ref());
    let suffix = squashed(quote.suffix.as_ref());
    let mut best: Option<(LooseSpan, usize)> = None;
    for &span in matches {
        let mut before = Outward {
            text: rendered,
            at: span.start.checked_sub(1),
            forward: false,
            seen: Vec::new(),
        };
        let mut after =
            Outward { text: rendered, at: Some(span.end), forward: true, seen: Vec::new() };
        let score = shared_context(&prefix, ContextSide::Before, |k| before.read(k))
            .saturating_add(shared_context(&suffix, ContextSide::After, |k| after.read(k)));
        if best.is_none_or(|(_, top)| score > top) {
            best = Some((span, score));
        }
    }
    best.map(|(span, _)| span)
}

/// The font a run was measured in, when its paint says one (`runFontOf`).
fn run_font_of(run: &TextRunNode) -> Option<FontDescriptor> {
    let appearance = run.appearance.as_ref()?;
    let family = appearance.font_family.as_deref()?;
    let size_px = appearance.font_size?;
    Some(body_font(
        family,
        size_px,
        Style { emphasis: run.emphasis, strong: run.strong, deleted: false },
    ))
}

fn measured(measure: &dyn Measure, units: &[u16], font: &FontDescriptor) -> f64 {
    clamp_advance(measure.advance_width(&String::from_utf16_lossy(units), font))
}

/// The boxes behind the words of one passage, one per run it crosses
/// (`passageBoxes`), measured the way each run itself was.
#[must_use]
pub fn passage_boxes(
    rendered: &RenderedText<'_>,
    quote: &TextQuote,
    measure: &dyn Measure,
    source: &PassageSource<'_>,
) -> Vec<BoundingBox> {
    let Some(range) = find_passage(&rendered.text, quote, source) else { return Vec::new() };
    // From the last piece starting at or before the passage, so a passage
    // visits only the runs it may cross.
    let first = rendered.pieces.partition_point(|piece| piece.at <= range.start).saturating_sub(1);
    let mut boxes = Vec::new();
    for Piece { run, at } in rendered.pieces.iter().skip(first) {
        if *at >= range.end {
            break;
        }
        let text: Vec<u16> = run.text.encode_utf16().collect();
        let from = range.start.max(*at).saturating_sub(*at);
        let to = range.end.min(at.saturating_add(text.len())).saturating_sub(*at);
        if to <= from {
            continue;
        }
        let (Some(head), Some(passage)) = (text.get(..from), text.get(from..to)) else { continue };
        let Some(font) = run_font_of(run) else { continue };
        let lead = measured(measure, head, &font);
        let width = measured(measure, passage, &font);
        if width > 0.0 {
            let bbox = &run.bbox;
            boxes.push(BoundingBox { x: bbox.x + lead, y: bbox.y, w: width, h: bbox.h });
        }
    }
    boxes
}

/// The highlight shapes for every passage of one node, in the runs' own
/// origin-relative space (`composePassageHighlights`), marked comment chrome
/// and named `<thread>/passage-<n>`. `source` is the node's markdown, which
/// the anchors' stored offsets index.
#[must_use]
pub fn compose_passage_highlights(
    passages: &[NodePassage<'_>],
    runs: &[&TextRunNode],
    measure: &dyn Measure,
    paint: PassagePaint<'_>,
    source: &[u16],
) -> Vec<SceneNode> {
    let rendered = rendered_text_of(runs);
    let mut out = Vec::new();
    for passage in passages {
        let look = if passage.resolved { paint.resolved } else { paint.open };
        let anchor = passage.anchor;
        let source = PassageSource { text: source, start: anchor.start, end: anchor.end };
        let boxes = passage_boxes(&rendered, &anchor.quote, measure, &source);
        out.extend(boxes.into_iter().enumerate().map(|(index, bbox)| {
            let id = format!("{}/passage-{index}", passage.thread_id);
            chrome_shape(id, bbox, PASSAGE_RADIUS_PX, look.cloned())
        }));
    }
    out
}

/// The passages of `node` the layer draws: every thread quoting its text, a
/// settled one only when settled threads are shown.
fn passages_of<'t>(
    threads: &'t [CommentThread],
    node: &SpatialNode,
    show_resolved: bool,
) -> Vec<NodePassage<'t>> {
    threads
        .iter()
        .filter(|thread| !thread.resolved || show_resolved)
        .filter_map(|thread| match &thread.anchor {
            AnnotationAnchor::Text(anchor)
                if anchor.node_id.as_deref() == Some(node.id.as_str()) =>
            {
                Some(NodePassage { thread_id: &thread.id, anchor, resolved: thread.resolved })
            }
            _ => None,
        })
        .collect()
}

/// A text node's passage highlights, behind its laid-out body and in the
/// body's own coordinates; a settled passage is muted like its pin.
#[must_use]
pub fn passage_highlights(
    node: &SpatialNode,
    text: &str,
    body: &FittedBlocks,
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let comments = &options.layout.comments;
    let passages = passages_of(comments.threads, node, comments.show_resolved);
    if passages.is_empty() {
        return Vec::new();
    }
    let chrome = options.node_box.appearance.resolve_comment();
    let paint = PassagePaint {
        open: chrome.as_ref().and_then(|c| c.chrome.passage.as_ref()),
        resolved: chrome.as_ref().and_then(|c| c.resolved_overlay.passage.as_ref()),
    };
    let source: Vec<u16> = text.encode_utf16().collect();
    let runs = collect_text_runs(&body.nodes);
    compose_passage_highlights(&passages, &runs, options.layout.measure, paint, &source)
}
