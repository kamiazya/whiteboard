//! Trimming a laid-out body to a height, ported from `fitBlocksToHeight`,
//! `firstLineOfBlocks` and `markLastRun`.
//!
//! Granularity steps down the way the wrap does: whole blocks first, then the
//! LINES of the block that straddles the edge (a paragraph lays out one run per
//! wrapped line) or the ITEMS of a list. A block's children that are not lines (a
//! quote, a table, a fence) stay whole-block. Whatever is removed marks the last
//! surviving run, so a dropped block, a trimmed list item and a cut line all say
//! the same thing: more was here than you can see.

use whiteboard_scene::{BoundingBox, ListItemNode, SceneNode, TextRunNode};

use crate::scene_walk::SceneWalk;

/// The nodes kept, and what a reader cannot see of the rest.
#[derive(Debug, Clone, PartialEq)]
pub struct FittedBlocks {
    pub nodes: Vec<SceneNode>,
    /// Something a reader cannot see was removed to make the rest fit.
    pub truncated: bool,
    /// The content does not fit the box, whether or not anything was removed:
    /// `truncated`, or a run kept at a width it exceeds because it is one
    /// irreducible code point. The weaker claim, and the one an agent reads.
    pub overflows: bool,
}

fn bbox_of(node: &SceneNode) -> Option<BoundingBox> {
    SceneWalk::Node(node).bbox().copied()
}

/// `Math.max` over the bottoms of what was kept: the largest, or `None`. Every
/// bottom passed the `<=` filter, so none is NaN, and over the rest the total
/// order is `Math.max`'s, `+0` above `-0` included.
fn bottom_of(bottoms: impl Iterator<Item = f64>) -> Option<f64> {
    bottoms.max_by(f64::total_cmp)
}

/// The runs of a block that end within `max_bottom`, or the block cut to them.
fn trim_block(block: &SceneNode, max_bottom: f64) -> Option<SceneNode> {
    match block {
        SceneNode::List(list) => {
            let items: Vec<ListItemNode> = list
                .items
                .iter()
                .filter(|item| item.bbox.y + item.bbox.h <= max_bottom)
                .cloned()
                .collect();
            let bottom = bottom_of(items.iter().map(|i| i.bbox.y + i.bbox.h))?;
            let bbox = BoundingBox { h: bottom - list.bbox.y, ..list.bbox };
            Some(SceneNode::List(whiteboard_scene::ListBlockNode { items, bbox, ..list.clone() }))
        }
        SceneNode::Paragraph(p) => {
            let (runs, bbox) = trim_runs(&p.runs, p.bbox, max_bottom)?;
            Some(SceneNode::Paragraph(whiteboard_scene::ParagraphBlockNode { runs, bbox }))
        }
        SceneNode::Heading(h) => {
            let (runs, bbox) = trim_runs(&h.runs, h.bbox, max_bottom)?;
            Some(SceneNode::Heading(whiteboard_scene::HeadingBlockNode { runs, bbox, ..h.clone() }))
        }
        _ => None,
    }
}

fn trim_runs(
    runs: &[TextRunNode],
    bbox: BoundingBox,
    max_bottom: f64,
) -> Option<(Vec<TextRunNode>, BoundingBox)> {
    let kept: Vec<TextRunNode> =
        runs.iter().filter(|r| r.bbox.y + r.bbox.h <= max_bottom).cloned().collect();
    let bottom = bottom_of(kept.iter().map(|r| r.bbox.y + r.bbox.h))?;
    Some((kept, BoundingBox { h: bottom - bbox.y, ..bbox }))
}

/// Whether any run anywhere under `nodes` satisfies `predicate`.
fn some_run(nodes: &[SceneWalk<'_>], predicate: &impl Fn(&TextRunNode) -> bool) -> bool {
    nodes.iter().any(|node| match node.text_run() {
        Some(run) => predicate(run),
        None => some_run(&node.children(), predicate),
    })
}

/// Marks the LAST run in paint order, the one thing a reader can see next to
/// whatever was removed. Only the spine down to that run is rebuilt, so every box
/// stays as laid out. A table is not descended: its runs sit under rows and
/// cells, which this walk does not read, so a body ending in one is left unmarked
/// and the mark goes to the last block that has a run it can reach.
fn mark_last_run(nodes: &[SceneNode]) -> Option<Vec<SceneNode>> {
    for (index, node) in nodes.iter().enumerate().rev() {
        let Some(marked) = marked_node(node) else { continue };
        let mut copy = nodes.to_vec();
        if let Some(slot) = copy.get_mut(index) {
            *slot = marked;
        }
        return Some(copy);
    }
    None
}

fn marked_node(node: &SceneNode) -> Option<SceneNode> {
    match node {
        SceneNode::TextRun(run) => {
            Some(SceneNode::TextRun(Box::new(TextRunNode { truncated: true, ..(**run).clone() })))
        }
        SceneNode::Paragraph(p) => {
            Some(SceneNode::Paragraph(whiteboard_scene::ParagraphBlockNode {
                runs: mark_runs(&p.runs)?,
                ..p.clone()
            }))
        }
        SceneNode::Heading(h) => Some(SceneNode::Heading(whiteboard_scene::HeadingBlockNode {
            runs: mark_runs(&h.runs)?,
            ..h.clone()
        })),
        SceneNode::CodeBlock(c) => Some(SceneNode::CodeBlock(whiteboard_scene::CodeBlockNode {
            runs: Some(mark_runs(c.runs.as_deref().unwrap_or_default())?),
            ..c.clone()
        })),
        SceneNode::Blockquote(q) => Some(SceneNode::Blockquote(whiteboard_scene::BlockquoteNode {
            children: mark_last_run(&q.children)?,
            ..q.clone()
        })),
        SceneNode::EmbedResolved(e) => {
            Some(SceneNode::EmbedResolved(whiteboard_scene::EmbedResolvedNode {
                children: mark_last_run(&e.children)?,
                ..e.clone()
            }))
        }
        SceneNode::Group(g) => Some(SceneNode::Group(whiteboard_scene::GroupSceneNode {
            children: mark_last_run(&g.children)?,
            ..g.clone()
        })),
        SceneNode::List(l) => Some(SceneNode::List(whiteboard_scene::ListBlockNode {
            items: mark_items(&l.items)?,
            ..l.clone()
        })),
        _ => None,
    }
}

/// A run list marks its last run, which is always reachable when it is not empty.
fn mark_runs(runs: &[TextRunNode]) -> Option<Vec<TextRunNode>> {
    let last = runs.len().checked_sub(1)?;
    let mut copy = runs.to_vec();
    if let Some(slot) = copy.get_mut(last) {
        slot.truncated = true;
    }
    Some(copy)
}

fn mark_items(items: &[ListItemNode]) -> Option<Vec<ListItemNode>> {
    for (index, item) in items.iter().enumerate().rev() {
        let Some(children) = mark_last_run(&item.children) else { continue };
        let mut copy = items.to_vec();
        if let Some(slot) = copy.get_mut(index) {
            *slot = ListItemNode { children, ..item.clone() };
        }
        return Some(copy);
    }
    None
}

fn signals(kept: &[SceneNode], cut: bool) -> (bool, bool) {
    let walks: Vec<SceneWalk<'_>> = kept.iter().map(SceneWalk::Node).collect();
    let cut_run = some_run(&walks, &|r| r.truncated);
    let over_run = some_run(&walks, &|r| r.truncated || r.overflows);
    (cut || cut_run, cut || over_run)
}

/// Trims laid-out blocks to what fits `max_height`, and says whether anything was
/// removed. A run cut sideways is content a reader cannot see, exactly like a
/// dropped block, and is counted here so every caller of this seam reports it.
#[must_use]
pub fn fit_blocks_to_height(nodes: &[SceneNode], max_height: f64) -> FittedBlocks {
    let mut kept: Vec<SceneNode> = Vec::new();
    let mut cut = false;
    for entry in nodes {
        // An edge is the one variant with no box; the typesetter never emits one.
        let Some(bbox) = bbox_of(entry) else { continue };
        if bbox.y + bbox.h <= max_height {
            kept.push(entry.clone());
            continue;
        }
        // The first block that does not fit is the last one considered: blocks are
        // laid out with strictly increasing bottoms, so everything after it
        // starts lower still.
        kept.extend(trim_block(entry, max_height));
        cut = true;
        break;
    }
    if kept.len() < nodes.len() {
        cut = true;
    }
    let kept = if cut { mark_last_run(&kept).unwrap_or(kept) } else { kept };
    let (truncated, overflows) = signals(&kept, cut);
    FittedBlocks { nodes: kept, truncated, overflows }
}

/// The smallest non-empty rendering of `nodes`: the first block cut to its FIRST
/// LINE. It has to be a line, so that "a text node never renders empty" does not
/// quietly mean "renders its whole first block, however tall".
#[must_use]
pub fn first_line_of_blocks(nodes: &[SceneNode]) -> FittedBlocks {
    let Some(first) = nodes.first().filter(|n| bbox_of(n).is_some()) else {
        return FittedBlocks { nodes: Vec::new(), truncated: false, overflows: false };
    };
    let (block, dropped) = first_line_of_block(first);
    let cut = nodes.len() > 1 || dropped;
    let kept = if cut {
        mark_last_run(std::slice::from_ref(&block)).unwrap_or_else(|| vec![block])
    } else {
        vec![block]
    };
    let walks: Vec<SceneWalk<'_>> = kept.iter().map(SceneWalk::Node).collect();
    let over = some_run(&walks, &|r| r.overflows);
    FittedBlocks { nodes: kept, truncated: cut, overflows: cut || over }
}

fn first_line_of_block(block: &SceneNode) -> (SceneNode, bool) {
    match block {
        SceneNode::List(list) => {
            let Some(first) = list.items.first() else { return (block.clone(), false) };
            let bbox = BoundingBox { h: first.bbox.y + first.bbox.h - list.bbox.y, ..list.bbox };
            let cut = whiteboard_scene::ListBlockNode {
                items: vec![first.clone()],
                bbox,
                ..list.clone()
            };
            (SceneNode::List(cut), list.items.len() > 1)
        }
        SceneNode::Paragraph(p) => match first_line(&p.runs, p.bbox) {
            Some((runs, bbox, dropped)) => {
                (SceneNode::Paragraph(whiteboard_scene::ParagraphBlockNode { runs, bbox }), dropped)
            }
            None => (block.clone(), false),
        },
        SceneNode::Heading(h) => match first_line(&h.runs, h.bbox) {
            Some((runs, bbox, dropped)) => (
                SceneNode::Heading(whiteboard_scene::HeadingBlockNode { runs, bbox, ..h.clone() }),
                dropped,
            ),
            None => (block.clone(), false),
        },
        _ => (block.clone(), false),
    }
}

/// The runs sharing the first run's `y` are one wrapped line, which can be several
/// runs when styling changes mid-line.
fn first_line(
    runs: &[TextRunNode],
    bbox: BoundingBox,
) -> Option<(Vec<TextRunNode>, BoundingBox, bool)> {
    let head = runs.first()?;
    let line: Vec<TextRunNode> =
        runs.iter().filter(|r| same_line(r.bbox.y, head.bbox.y)).cloned().collect();
    let height = head.bbox.y + head.bbox.h - bbox.y;
    let dropped = line.len() < runs.len();
    Some((line, BoundingBox { h: height, ..bbox }, dropped))
}

/// `a === b`: a line is the runs at exactly the first run's `y`, and a NaN is at no line.
fn same_line(a: f64, b: f64) -> bool {
    a.partial_cmp(&b) == Some(std::cmp::Ordering::Equal)
}
