//! What a tidy is about: the boxes, the settings a caller makes, and the UNITS
//! the passes move: an outermost frame and everything more than half inside it
//! move as one, and every other node is its own unit.
//!
//! Membership is geometric (more than half inside), so a frame that grows to
//! hold a straddler can swallow the box past it, and a member the overlap pass
//! pushes out of a frame that cannot grow stops being one. That is a question
//! about units rather than about any pass, and this module answers it.
//!
//! A node is named by its index in the board it is tidied on (its identity)
//! and by a KEY, the first position its id has among the ids: two nodes
//! sharing an id share a key, which is what every TypeScript `Set` and `Map`
//! over ids did.

use whiteboard_det::math::{js_max, js_min};
use whiteboard_edge_routing::edge_rules::fully_contains;
use whiteboard_edge_routing::geometry::Rect;

use crate::order::sorted_by;

pub(super) const TIDY_BAND_PX: f64 = 24.0;
pub(super) const TIDY_GRID_PX: f64 = 8.0;
pub(super) const TIDY_MARGIN_PX: f64 = 32.0;

/// Movable units beyond this stay put, so a tidy stays cheap on a phone.
const TIDY_MAX_UNITS: usize = 300;

/// What a call may spend on the frame walk (see [`Budget`]).
const TIDY_LEVEL_VISITS: usize = 500_000;
const TIDY_NESTING_PAIRS: usize = 16_000_000;

#[derive(Debug, Clone, Copy)]
pub(super) struct Point {
    pub x: f64,
    pub y: f64,
}

/// A box on the board being tidied.
#[derive(Debug, Clone, Copy)]
pub(super) struct Node {
    pub key: usize,
    pub frame: bool,
    pub rect: Rect,
}

/// What a call was asked, by key.
#[derive(Debug)]
pub(super) struct Ctx {
    pub in_scope: Vec<bool>,
    pub locked: Vec<bool>,
    /// The ends of each edge as keys; an end naming nothing on the board, or a
    /// free end, is `None`. Present (even empty) switches row ordering on.
    pub edges: Option<Vec<(Option<usize>, Option<usize>)>>,
}

impl Ctx {
    pub(super) fn is_in_scope(&self, key: usize) -> bool {
        self.in_scope.get(key).copied().unwrap_or(false)
    }

    pub(super) fn is_locked(&self, key: usize) -> bool {
        self.locked.get(key).copied().unwrap_or(false)
    }
}

/// What the passes move. `members` are board indices, the root's included.
#[derive(Debug)]
pub(super) struct Unit {
    pub root: usize,
    pub members: Vec<usize>,
    pub bbox: Rect,
    pub movable: bool,
    pub dx: f64,
    pub dy: f64,
}

/// Membership by MAJORITY, not by containment: a box more than half inside a
/// frame's own box is one of its members.
///
/// A drawer who puts a box across a frame's edge means it to be in the frame,
/// where full containment would eject it and leave a member orphaned outside
/// the group it was drawn in. Majority rather than contact, so a frame does
/// not swallow a neighbour it overlaps by a corner.
pub(super) fn mostly_inside(outer: Rect, inner: Rect) -> bool {
    let area = inner.w * inner.h;
    if area <= 0.0 {
        return fully_contains(outer, inner);
    }
    let w = js_min(outer.x + outer.w, inner.x + inner.w) - js_max(outer.x, inner.x);
    let h = js_min(outer.y + outer.h, inner.y + inner.h) - js_max(outer.y, inner.y);
    // Past the guard above `area` is positive, so `w * h * 2 > area` already
    // implies a positive product, which a negative span on ONE axis fails on
    // its own. What the product cannot rule out is both spans NEGATIVE (two
    // boxes separated on both axes), and one span's sign settles that case.
    w > 0.0 && w * h * 2.0 > area
}

/// JavaScript's `===` on numbers: false for NaN, true for the two zeros.
pub(super) fn js_eq(a: f64, b: f64) -> bool {
    a.partial_cmp(&b) == Some(core::cmp::Ordering::Equal)
}

/// JavaScript's `a >= b`: false when either is NaN.
pub(super) fn js_ge(a: f64, b: f64) -> bool {
    matches!(a.partial_cmp(&b), Some(core::cmp::Ordering::Greater | core::cmp::Ordering::Equal))
}

pub(super) fn overlaps_with_margin(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.w + TIDY_MARGIN_PX
        && b.x < a.x + a.w + TIDY_MARGIN_PX
        && a.y < b.y + b.h + TIDY_MARGIN_PX
        && b.y < a.y + a.h + TIDY_MARGIN_PX
}

/// Which frames stand OVER which: `h` encloses `g` when more than half of `g`
/// is inside `h` and `h` is the larger, equal areas going to the earlier in
/// document order. A frame is a level's unit root iff none of its enclosers
/// is at that level.
///
/// Majority rather than full containment because a frame drawn across
/// another's edge is drawn IN it. Ordering by area first keeps the relation
/// acyclic, since majority alone is not antisymmetric. Answered once per
/// board, by board index, and handed to every level.
pub(super) fn frame_nesting(nodes: &[Node]) -> Vec<Vec<usize>> {
    let frames: Vec<(usize, Rect, f64)> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.frame)
        .map(|(at, n)| (at, n.rect, n.rect.w * n.rect.h))
        .collect();
    let mut enclosers = vec![Vec::new(); nodes.len()];
    for (g_at, g_rect, g_area) in &frames {
        let list = frames
            .iter()
            .enumerate()
            .filter(|(_, (_, h_rect, _))| {
                fully_contains(*h_rect, *g_rect) || mostly_inside(*h_rect, *g_rect)
            })
            .filter(|(_, (h_at, _, h_area))| {
                // Strict on both, so a frame never encloses itself.
                *h_area > *g_area || (js_eq(*h_area, *g_area) && h_at < g_at)
            })
            .map(|(_, (h_at, _, _))| *h_at)
            .collect();
        if let Some(slot) = enclosers.get_mut(*g_at) {
            *slot = list;
        }
    }
    enclosers
}

/// What `root` claims: every yet-unclaimed node more than half inside it and,
/// since a frame it claims brings what IT holds, more than half inside any
/// frame claimed so far. Marks each claimed; answers them in board order.
fn scoop(root: usize, level: &[usize], nodes: &[Node], claimed: &mut [bool]) -> Vec<usize> {
    let Some(root_node) = nodes.get(root) else { return Vec::new() };
    let mut holders = vec![root_node.rect];
    let mut mine = vec![false; claimed.len()];
    mark(&mut mine, root_node.key);
    mark(claimed, root_node.key);
    // Each pass that goes on claimed a node, so a level's length bounds them.
    for _ in 0..=level.len() {
        let mut grew = false;
        for &m in level {
            let Some(node) = nodes.get(m) else { continue };
            if is_marked(claimed, node.key) {
                continue;
            }
            if !holders.iter().any(|h| mostly_inside(*h, node.rect)) {
                continue;
            }
            mark(claimed, node.key);
            mark(&mut mine, node.key);
            if node.frame {
                holders.push(node.rect);
            }
            grew = true;
        }
        if !grew {
            break;
        }
    }
    level
        .iter()
        .copied()
        .filter(|&m| nodes.get(m).is_some_and(|n| is_marked(&mine, n.key)))
        .collect()
}

fn mark(flags: &mut [bool], key: usize) {
    if let Some(flag) = flags.get_mut(key) {
        *flag = true;
    }
}

fn is_marked(flags: &[bool], key: usize) -> bool {
    flags.get(key).copied().unwrap_or(false)
}

/// Outermost-rooted single-scoop units: a frame is a unit root iff no other
/// frame at this level encloses it; each root claims every yet-unclaimed node
/// more than half inside its box, or inside a frame it has claimed, in ONE
/// scoop, so nested frames and their members can never be double-assigned.
/// Everything else is a singleton unit, and units keep the document order of
/// their roots.
pub(super) fn build_units(
    level: &[usize],
    nodes: &[Node],
    ctx: &Ctx,
    enclosers: &[Vec<usize>],
) -> Vec<Unit> {
    let mut at_level = vec![false; nodes.len()];
    for &i in level {
        mark(&mut at_level, i);
    }
    let is_root = |g: usize| {
        !enclosers.get(g).is_some_and(|list| list.iter().any(|&h| is_marked(&at_level, h)))
    };
    let mut claimed = vec![false; ctx.in_scope.len()];
    let mut units: Vec<Unit> = Vec::new();
    let mut movable_count = 0_usize;
    let mut push_unit = |root: usize, members: Vec<usize>, bbox: Rect| {
        let key = nodes.get(root).map_or(0, |n| n.key);
        // A frame holding a locked member is held by it: moving the unit would
        // carry the frame away from a member that cannot follow.
        let movable = ctx.is_in_scope(key)
            && !ctx.is_locked(key)
            && !members.iter().any(|&m| nodes.get(m).is_some_and(|n| ctx.is_locked(n.key)))
            && movable_count < TIDY_MAX_UNITS;
        if movable {
            movable_count = movable_count.saturating_add(1);
        }
        units.push(Unit { root, members, bbox, movable, dx: 0.0, dy: 0.0 });
    };
    for &i in level {
        let Some(node) = nodes.get(i) else { continue };
        if is_marked(&claimed, node.key) {
            continue;
        }
        if node.frame && is_root(i) {
            push_unit(i, scoop(i, level, nodes, &mut claimed), node.rect);
        }
    }
    for &i in level {
        let Some(node) = nodes.get(i) else { continue };
        if is_marked(&claimed, node.key) {
            continue;
        }
        mark(&mut claimed, node.key);
        push_unit(i, vec![i], node.rect);
    }
    order_by_root(units, level, nodes, ctx.in_scope.len())
}

/// Units participate in document order of their root: group roots were emitted
/// before later singletons. An id repeated on the level takes its last place.
fn order_by_root(units: Vec<Unit>, level: &[usize], nodes: &[Node], keys: usize) -> Vec<Unit> {
    let mut place = vec![0_usize; keys];
    for (at, &i) in level.iter().enumerate() {
        if let Some(slot) = nodes.get(i).and_then(|n| place.get_mut(n.key)) {
            *slot = at;
        }
    }
    let of = |u: &Unit| nodes.get(u.root).and_then(|n| place.get(n.key)).copied().unwrap_or(0);
    sorted_by(units, |a, b| of(a).cmp(&of(b)))
}

/// What one call may spend on the parts of the frame walk whose cost grows
/// faster than the board: asking every frame whether it stands over every other
/// (`nesting`, once per settling pass), and opening a level per frame, each
/// doing work in proportion to the nodes it holds (`levels`).
///
/// Neither is bounded by the node cap alone: 2000 frames each strictly inside
/// the next have a level per frame, every one holding every frame inside it.
/// Past the budget the walk keeps what it has not reached as it was drawn: a
/// frame it cannot afford to open is not tidied inside nor grown, and its
/// members travel with it; a settling pass it cannot afford is not run. Below
/// the budget nothing changes: every check refuses only work the account cannot
/// cover.
#[derive(Debug)]
pub(super) struct Budget {
    nesting: usize,
    levels: usize,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum Account {
    Nesting,
    Levels,
}

impl Budget {
    pub(super) fn new() -> Self {
        Self { nesting: TIDY_NESTING_PAIRS, levels: TIDY_LEVEL_VISITS }
    }

    /// Takes `work` from one account, or nothing when it cannot cover all of
    /// it, so no check spends part and refuses the rest.
    pub(super) fn spend(&mut self, account: Account, work: usize) -> bool {
        let left = match account {
            Account::Nesting => &mut self.nesting,
            Account::Levels => &mut self.levels,
        };
        if work > *left {
            return false;
        }
        *left = left.saturating_sub(work);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{Account, Budget};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn an_account_refuses_work_it_cannot_cover_whole_and_keeps_what_it_had() {
        let mut budget = Budget::new();
        assert!(budget.spend(Account::Levels, 500_000));
        assert!(!budget.spend(Account::Levels, 1));
        assert!(budget.spend(Account::Levels, 0));
        assert!(!budget.spend(Account::Nesting, 16_000_001));
        assert!(budget.spend(Account::Nesting, 15_000_000));
        assert!(!budget.spend(Account::Nesting, 1_000_001));
        assert!(budget.spend(Account::Nesting, 1_000_000));
    }

    #[test]
    fn the_accounts_are_separate() {
        let mut budget = Budget::new();
        assert!(budget.spend(Account::Nesting, 16_000_000));
        assert!(budget.spend(Account::Levels, 500_000));
    }
}
