//! One-tap tidy, ported from `packages/canvas-render/src/tidy*.ts`: deterministic
//! normalization that respects the author's rough topology instead of re-laying
//! the canvas out wholesale.
//!
//! Passes over UNITS (an outermost frame and everything more than half inside
//! its box move as one; every other node is its own unit), applied INSIDE each
//! frame first and then at the level of the frames themselves:
//!
//! - Inside a frame: its members are tidied as a canvas of their own (the same
//!   passes, recursively for nested frames), and the frame then GROWS, never
//!   shrinks, to hold them with `TIDY_MARGIN_PX` on every side, when it is
//!   unlocked and it or one of its members is in scope. Its top-left stays put:
//!   a member hugging that corner is moved in to the margin instead.
//! - Band alignment ([`bands`]), per axis and per anchor a drawer sets.
//! - Row order by edges ([`rows`]), when the caller passes them.
//! - Overlap resolution as a deterministic sequential PLACEMENT ([`overlap`]).
//! - Edge legibility is deliberately NOT tidy's job: once nodes settle, the edge
//!   optimizer re-routes and re-sides edges on the committed render.
//!
//! **The answer is a SETTLED state, and [`tidy_nodes`] checks.** Every rule is
//! local, so idempotence is a property of all of them together and no single one
//! can be held responsible for it. The entry point settles, re-enters, and stops
//! when the state repeats: stopping at a state already SEEN rather than at one
//! that stopped moving, because the passes can CYCLE, and a repeated state is the
//! one re-entry reproduces.
//!
//! The CEILING of 12 settling passes is a measurement: over 40000 boards drawn
//! the way the TypeScript's property drew them, reaching a repeated state took
//! 2 passes on 34885 of them, 3 on 4759, and 7 at the worst; a ceiling of 4
//! shipped, and CI found the board that needs 5.
//!
//! Pure and total: returns ONLY the boxes that actually move (a frame that grew
//! carries its new size); degenerate input never panics. Locked nodes never move
//! and stand as fixed obstacles, and a frame holding one is held by it; out-of-
//! scope units likewise.
//!
//! The TypeScript is the byte-identical oracle (`tests/tidy_oracle.rs`), so every
//! comparison keeps `===`'s reading of a NaN, `Math.round`, `Math.min` and
//! `Math.max`, and every sort is stable over a total order.

mod axis;
mod bands;
mod level;
mod overlap;
mod rows;
mod units;

use std::collections::{BTreeMap, BTreeSet};

use whiteboard_edge_routing::geometry::Rect;

use level::{bits, settle_once};
use units::{Budget, Ctx, Node};

/// One box of the board: what tidy asks of a node beyond its rectangle is
/// whether it is a FRAME.
#[derive(Debug, Clone, PartialEq)]
pub struct TidyNode {
    pub id: String,
    pub frame: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What a caller sets.
#[derive(Debug, Clone, Default)]
pub struct TidyOptions {
    /// Unit roots outside this set stay put (`None` = the whole canvas).
    pub scope: Option<BTreeSet<String>>,
    /// The ids that may not move.
    pub locked: BTreeSet<String>,
    /// The canvas's edges by the node ids their ends name (`None`: a free end).
    /// With them a row is ORDERED as well as aligned: a box whose connections
    /// along its own row all lie to one side swaps with the nearest of them.
    pub edges: Option<Vec<(Option<String>, Option<String>)>>,
}

/// A box that moves; a frame that grew carries its new size.
#[derive(Debug, Clone, PartialEq)]
pub struct TidyMove {
    pub id: String,
    pub x: f64,
    pub y: f64,
    /// Present only on a frame that grew to hold its members: `(width, height)`.
    pub size: Option<(f64, f64)>,
}

/// The most settling passes `tidy_nodes` re-enters for.
const TIDY_MAX_SETTLE_PASSES: usize = 12;

/// The boxes that move, and only those.
#[must_use]
pub fn tidy_nodes(nodes: &[TidyNode], options: &TidyOptions) -> Vec<TidyMove> {
    let clean: Vec<&TidyNode> = nodes
        .iter()
        .filter(|n| [n.x, n.y, n.width, n.height].iter().all(|v| v.is_finite()))
        .collect();
    if clean.len() < 2 {
        return Vec::new();
    }
    let (ctx, board) = board_of(&clean, options);
    let positions = |ns: &[Node]| -> Vec<u64> {
        ns.iter().flat_map(|n| [n.rect.x, n.rect.y, n.rect.w, n.rect.h].map(bits)).collect()
    };
    let mut current = board.clone();
    let mut seen: BTreeSet<Vec<u64>> = BTreeSet::new();
    let mut budget = Budget::new();
    for _ in 0..TIDY_MAX_SETTLE_PASSES {
        seen.insert(positions(&current));
        current = settle_once(&current, &ctx, &mut budget);
        if seen.contains(&positions(&current)) {
            break;
        }
    }
    moves_between(&clean, &board, &current)
}

/// The board as keys and rects, and what the options say of each key.
fn board_of(clean: &[&TidyNode], options: &TidyOptions) -> (Ctx, Vec<Node>) {
    let mut keys: BTreeMap<&str, usize> = BTreeMap::new();
    let mut ids: Vec<&str> = Vec::new();
    let board: Vec<Node> = clean
        .iter()
        .map(|n| {
            let key = *keys.entry(n.id.as_str()).or_insert_with(|| {
                ids.push(n.id.as_str());
                ids.len().saturating_sub(1)
            });
            Node { key, frame: n.frame, rect: Rect { x: n.x, y: n.y, w: n.width, h: n.height } }
        })
        .collect();
    let end = |end: &Option<String>| end.as_deref().and_then(|id| keys.get(id).copied());
    let ctx = Ctx {
        in_scope: ids
            .iter()
            .map(|id| options.scope.as_ref().is_none_or(|scope| scope.contains(*id)))
            .collect(),
        locked: ids.iter().map(|id| options.locked.contains(*id)).collect(),
        edges: options
            .edges
            .as_ref()
            .map(|edges| edges.iter().map(|(from, to)| (end(from), end(to))).collect()),
    };
    (ctx, board)
}

/// Each node whose settled box differs from the one it was given. The settled
/// box of an id repeated on the board is the last one's.
fn moves_between(clean: &[&TidyNode], board: &[Node], settled: &[Node]) -> Vec<TidyMove> {
    let mut last: BTreeMap<usize, Rect> = BTreeMap::new();
    for node in settled {
        last.insert(node.key, node.rect);
    }
    let mut moves = Vec::new();
    for (given, node) in clean.iter().zip(board) {
        let Some(rect) = last.get(&node.key) else { continue };
        let (x, y) =
            (whiteboard_det::math::js_round(rect.x), whiteboard_det::math::js_round(rect.y));
        let (w, h) =
            (whiteboard_det::math::js_round(rect.w), whiteboard_det::math::js_round(rect.h));
        // Every settled rect is finite (`settle_once` keeps a box whose rounding
        // is not), so no position the doc layer would refuse can be emitted.
        let grew = !units::js_eq(w, given.width) || !units::js_eq(h, given.height);
        if units::js_eq(x, given.x) && units::js_eq(y, given.y) && !grew {
            continue;
        }
        moves.push(TidyMove { id: given.id.clone(), x, y, size: grew.then_some((w, h)) });
    }
    moves
}
