//! The line jumps' broad phase, `place` and `SegmentGrid` in canvas-render's
//! `layout/edges/edge-jumps.ts`: a hierarchy of uniform grids, each straight
//! run filed at the level whose cell holds its extent, so it touches a
//! handful of cells whatever its length and wherever on the number line it
//! sits. Two runs that meet share a cell at the coarser of their two levels: a
//! run is also filed, as finer, at every coarser level whose runs it can
//! reach, and looks for runs of coarser levels there.

use std::collections::BTreeMap;

use crate::geometry::Point;
use whiteboard_det::math::{js_max, js_min};

/// Most broad-phase work one scene does, as `MAX_GRID_WORK_PER_SCENE`. A unit
/// is a filed entry read, a level a run is checked against, or a cell it is
/// filed into; past this the search answers no more candidates.
pub const MAX_GRID_WORK_PER_SCENE: usize = 4_000_000;

/// Below this a cell would be subnormal and its pad would vanish.
const MIN_LEVEL: i32 = -30;

/// The level whose cell, `4^512`, overflows to infinity: every finite extent
/// fits by then.
const MAX_LEVEL: i32 = 512;

/// `4^MIN_LEVEL`, the finest cell.
const MIN_CELL: f64 = 1.0 / 1_152_921_504_606_846_976.0;

/// The pad around a run's cells, as a share of the cell.
const PAD_IN_CELLS: f64 = 1.0 / 1_048_576.0;

/// Where cell lines fall, as a share of the cell: a power-of-two cell would
/// otherwise put its lines on round coordinates, where authored points sit.
const PHASE_IN_CELLS: f64 = 0.381_966;

/// A run as the grid files it: its ends, its bounds, and the level (with that
/// level's cell, `4^level` px) that holds its extent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    pub a: Point,
    pub b: Point,
    pub level: i32,
    pub cell: f64,
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

/// The smallest level from [`MIN_LEVEL`] whose cell holds `need`, and that
/// cell. The TypeScript starts from a `log2` guess and corrects it both ways,
/// which lands on the same level whatever the guess.
fn level_for(need: f64) -> (i32, f64) {
    let cells = std::iter::successors(Some(MIN_CELL), |cell| Some(cell * 4.0));
    (MIN_LEVEL..=MAX_LEVEL)
        .zip(cells)
        .find(|&(_, cell)| cell >= need)
        .unwrap_or((MAX_LEVEL, f64::INFINITY))
}

/// Files the run `a`-`b`, or answers `None` for one that can take part in no
/// crossing: a zero extent has no direction and a non-finite one turns its
/// arithmetic NaN.
#[must_use]
pub fn place(a: Point, b: Point) -> Option<Placed> {
    let min_x = js_min(a.x, b.x);
    let max_x = js_max(a.x, b.x);
    let min_y = js_min(a.y, b.y);
    let max_y = js_max(a.y, b.y);
    let extent = js_max(max_x - min_x, max_y - min_y);
    if !(extent > 0.0 && extent < f64::INFINITY) {
        return None;
    }
    let (level, cell) = level_for(extent);
    Some(Placed { a, b, level, cell, min_x, max_x, min_y, max_y })
}

/// `floor((v + delta) / cell)` on the phase-shifted lines, exact however large
/// `v` is: the cell is a power of two, so `v / cell` and `base * cell` are
/// exact, and the rest is worked in the offset from that cell's corner.
fn cell_index(v: f64, delta: f64, cell: f64) -> f64 {
    let base = (v / cell).floor();
    base + ((v - base * cell + cell * PHASE_IN_CELLS + delta) / cell).floor()
}

/// Most cells a run's padded span covers on one axis, at any level. At its
/// own level the span is at most `1 + 2^-19` cells, so the two floors in
/// [`cell_index`] differ by at most 2; past 2^53 adding them to the base can
/// round each to a neighbouring even index, 4 apart at most, which is 5 cells.
/// A coarser level's cell is larger and covers fewer.
const MAX_CELLS_PER_AXIS: u32 = 8;

/// `0, 1, ..` while at most `last`, as the TypeScript's `i <= last` loop
/// counts: nothing when `last` is negative or NaN.
fn steps_to(last: f64) -> impl Iterator<Item = f64> {
    (0..MAX_CELLS_PER_AXIS).map(f64::from).take_while(move |&i| i <= last)
}

/// A cell, as the bits of its column and row index.
pub type CellKey = (u64, u64);

/// The cells of `cell` px that `p`'s LINE passes through, rather than every
/// cell of its bounding box, so a diagonal costs its length and not its area —
/// padded, so rounding at a cell boundary only adds candidates. Each row range
/// is worked relative to the run's own start.
fn cells_of(p: &Placed, cell: f64) -> Vec<CellKey> {
    let Placed { a, b, .. } = *p;
    let pad = cell * PAD_IN_CELLS;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let c0 = cell_index(a.x, js_min(0.0, dx) - pad, cell);
    let c1 = cell_index(a.x, js_max(0.0, dx) + pad, cell);
    let mut keys = Vec::new();
    for i in steps_to(c1 - c0) {
        let cx = c0 + i;
        let mut lo = js_min(0.0, dy);
        let mut hi = js_max(0.0, dy);
        if dx != 0.0 && c1 > c0 {
            // The part of the run inside this column, by its x extent.
            let left = cx * cell - a.x - cell * PHASE_IN_CELLS;
            let x_l = js_max(js_min(0.0, dx), left);
            let x_r = js_min(js_max(0.0, dx), left + cell);
            let o_l = (x_l / dx) * dy;
            let o_r = (x_r / dx) * dy;
            lo = js_max(lo, js_min(o_l, o_r));
            hi = js_min(hi, js_max(o_l, o_r));
        }
        let r0 = cell_index(a.y, lo - pad, cell);
        let r1 = cell_index(a.y, hi + pad, cell);
        keys.extend(steps_to(r1 - r0).map(|k| (cx.to_bits(), (r0 + k).to_bits())));
    }
    keys
}

/// The bounds of every run one level files natively.
#[derive(Debug, Clone, Copy)]
struct Bounds {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

/// True unless `p` lies clear of `bounds` by more than a sliver of `cell`.
fn reaches(p: &Placed, bounds: &Bounds, cell: f64) -> bool {
    let gap = cell * PAD_IN_CELLS;
    !(bounds.min_x - p.max_x > gap
        || p.min_x - bounds.max_x > gap
        || bounds.min_y - p.max_y > gap
        || p.min_y - bounds.max_y > gap)
}

type Cells = BTreeMap<CellKey, Vec<usize>>;

struct Level {
    id: i32,
    cell: f64,
    bounds: Bounds,
    /// Runs filed at this level, by cell.
    native: Cells,
    /// Runs of finer levels, filed here too so this level's own find them.
    finer: Cells,
}

/// One level a run takes part in, with its cells there.
#[derive(Debug, Clone, PartialEq)]
pub struct Reach {
    index: usize,
    /// The level's id: its cell is `4^level` px.
    pub level: i32,
    /// Whether it is the run's own level, rather than a coarser one it reaches.
    pub own: bool,
    pub keys: Vec<CellKey>,
}

/// The broad phase over one scene's runs. Levels are fixed before any run is
/// filed, so a coarser run that comes later still finds a finer one that came
/// earlier.
pub struct SegmentGrid {
    /// Every level in use, finest first.
    levels: Vec<Level>,
    filed: usize,
    work: usize,
}

impl SegmentGrid {
    #[must_use]
    pub fn new<'a>(all: impl IntoIterator<Item = &'a Placed>) -> Self {
        let mut by_id: BTreeMap<i32, Level> = BTreeMap::new();
        for p in all {
            let level = by_id.entry(p.level).or_insert_with(|| Level {
                id: p.level,
                cell: p.cell,
                bounds: Bounds { min_x: p.min_x, max_x: p.max_x, min_y: p.min_y, max_y: p.max_y },
                native: Cells::new(),
                finer: Cells::new(),
            });
            let bounds = &mut level.bounds;
            bounds.min_x = js_min(bounds.min_x, p.min_x);
            bounds.max_x = js_max(bounds.max_x, p.max_x);
            bounds.min_y = js_min(bounds.min_y, p.min_y);
            bounds.max_y = js_max(bounds.max_y, p.max_y);
        }
        Self { levels: by_id.into_values().collect(), filed: 0, work: 0 }
    }

    /// Broad-phase work so far, against [`MAX_GRID_WORK_PER_SCENE`].
    #[must_use]
    pub const fn work(&self) -> usize {
        self.work
    }

    /// The levels `p` takes part in, own first, each with its cells there.
    pub fn reach(&mut self, p: &Placed) -> Vec<Reach> {
        let mut reached = Vec::new();
        for (index, level) in self.levels.iter().enumerate() {
            if level.id < p.level {
                continue;
            }
            // Past the budget `candidates` answers None, so nothing more is needed.
            if self.work > MAX_GRID_WORK_PER_SCENE {
                break;
            }
            self.work = self.work.saturating_add(1);
            let own = level.id == p.level;
            if !own && !reaches(p, &level.bounds, level.cell) {
                continue;
            }
            let keys = cells_of(p, level.cell);
            self.work = self.work.saturating_add(keys.len());
            reached.push(Reach { index, level: level.id, own, keys });
        }
        reached
    }

    fn take_filed(work: &mut usize, cells: &Cells, keys: &[CellKey], found: &mut Vec<usize>) {
        for filed in keys.iter().filter_map(|key| cells.get(key)) {
            *work = work.saturating_add(filed.len());
            found.extend_from_slice(filed);
        }
    }

    /// The filing index of every run filed so far that can meet the one
    /// `reached` describes, once each and in filing order; `None` once the
    /// scene's work budget is spent, checked per run so none is searched in
    /// part.
    pub fn candidates(&mut self, reached: &[Reach]) -> Option<Vec<usize>> {
        let mut found = Vec::new();
        for r in reached {
            let Some(level) = self.levels.get(r.index) else { continue };
            Self::take_filed(&mut self.work, &level.native, &r.keys, &mut found);
            // Finer runs are found at their coarser partner's own level only.
            if r.own {
                Self::take_filed(&mut self.work, &level.finer, &r.keys, &mut found);
            }
        }
        if self.work > MAX_GRID_WORK_PER_SCENE {
            return None;
        }
        found.sort_by(usize::cmp);
        found.dedup();
        Some(found)
    }

    /// Files the run `reached` describes; answers its filing index.
    pub fn add(&mut self, reached: &[Reach]) -> usize {
        let index = self.filed;
        self.filed = self.filed.saturating_add(1);
        for r in reached {
            let Some(level) = self.levels.get_mut(r.index) else { continue };
            let cells = if r.own { &mut level.native } else { &mut level.finer };
            for key in &r.keys {
                cells.entry(*key).or_default().push(index);
            }
        }
        index
    }
}
