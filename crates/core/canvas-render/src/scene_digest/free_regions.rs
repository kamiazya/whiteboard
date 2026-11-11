//! Free regions: the maximal free run of each row of a 20px occupancy grid over
//! the entries' union box.

use whiteboard_det::math::{compare_numbers, js_max, js_min};
use whiteboard_scene::BoundingBox;

use super::{DigestError, Entry};

/// Grid granularity, in px.
const GRID_PX: f64 = 20.0;
/// Upper bound on the grid's cell count; past it no regions are reported,
/// since coordinates are caller-supplied and a matrix of any size could be asked for.
const MAX_CELLS: u32 = 250_000;
/// Upper bound on the regions reported; past it the largest are kept.
const MAX_REGIONS: usize = 1_000;

/// The grid a scan runs on.
struct Grid {
    min_x: f64,
    min_y: f64,
    cols: u32,
    rows: u32,
}

impl Grid {
    /// The grid of that many cells, or `None` past the budget. Every allocation
    /// below is sized from a `Grid`, so this is the one check that bounds them.
    fn new(min_x: f64, min_y: f64, cols: f64, rows: f64) -> Option<Self> {
        let (cols, rows) = (cell_count(cols), cell_count(rows));
        (u64::from(cols).saturating_mul(u64::from(rows)) <= u64::from(MAX_CELLS)).then_some(Self {
            min_x,
            min_y,
            cols,
            rows,
        })
    }
}

enum Plan {
    /// More cells than the budget allows.
    OverBudget,
    /// A height that is not a number: the TypeScript's row loop never runs.
    NoRows,
    Scan(Grid),
}

/// A whole number of cells, known to be in `0..=MAX_CELLS` by the callers.
fn cell_count(v: f64) -> u32 {
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a whole number in 0..=250_000 here, which a u32 holds exactly"
    )]
    let n = v as u32;
    n
}

/// The `Math.min` / `Math.max` of one coordinate over every entry.
fn extent(entries: &[Entry], pick: impl Fn(&BoundingBox) -> f64, fold: fn(f64, f64) -> f64) -> f64 {
    let mut all = entries.iter().map(|e| pick(&e.bbox));
    all.next().map_or(f64::NAN, |first| all.fold(first, fold))
}

fn plan(entries: &[Entry]) -> Result<Plan, DigestError> {
    let min_x = extent(entries, |b| b.x, js_min);
    let min_y = extent(entries, |b| b.y, js_min);
    let max_x = extent(entries, |b| b.x + b.w, js_max);
    let max_y = extent(entries, |b| b.y + b.h, js_max);
    let cols = js_max(1.0, ((max_x - min_x) / GRID_PX).ceil());
    let rows = js_max(1.0, ((max_y - min_y) / GRID_PX).ceil());
    // A NaN height never runs the TypeScript's row loop; a NaN width with a
    // height throws allocating the first row; an infinite size is over budget.
    if rows.is_nan() {
        Ok(Plan::NoRows)
    } else if cols.is_nan() {
        Err(DigestError::InvalidGrid)
    } else {
        Ok(Grid::new(min_x, min_y, cols, rows).map_or(Plan::OverBudget, Plan::Scan))
    }
}

/// A 2D difference array: four marks per entry, one prefix-sum pass for the
/// coverage of every cell.
struct Marks {
    cells: Vec<i64>,
    stride: u32,
}

impl Marks {
    fn new(grid: &Grid) -> Self {
        let stride = grid.cols.saturating_add(1);
        let len = usize::try_from(grid.rows.saturating_add(1).saturating_mul(stride)).unwrap_or(0);
        Self { cells: vec![0; len], stride }
    }

    fn add(&mut self, row: u32, col: u32, by: i64) {
        let at = usize::try_from(row.saturating_mul(self.stride).saturating_add(col));
        if let Some(cell) = at.ok().and_then(|at| self.cells.get_mut(at)) {
            *cell = cell.saturating_add(by);
        }
    }

    fn get(&self, row: u32, col: u32) -> i64 {
        let at = usize::try_from(row.saturating_mul(self.stride).saturating_add(col));
        at.ok().and_then(|at| self.cells.get(at)).copied().unwrap_or(0)
    }
}

/// The inclusive cell span of one axis, or `None` for an empty one. The far
/// edge is exclusive, so a box ending on a grid line stops one cell earlier.
/// The grid is the entries' union, so a span never leaves it and needs no clamp.
fn span(low: f64, high: f64, min: f64) -> Option<(u32, u32)> {
    let first = ((low - min) / GRID_PX).floor();
    let last = ((high - min) / GRID_PX).ceil() - 1.0;
    (first <= last).then(|| (cell_count(first), cell_count(last)))
}

/// Which cells any entry covers, row by row.
fn occupancy(entries: &[Entry], grid: &Grid) -> Vec<Vec<bool>> {
    let mut marks = Marks::new(grid);
    for entry in entries {
        let b = &entry.bbox;
        let cols = span(b.x, b.x + b.w, grid.min_x);
        let rows = span(b.y, b.y + b.h, grid.min_y);
        if let (Some((c0, c1)), Some((r0, r1))) = (cols, rows) {
            marks.add(r0, c0, 1);
            marks.add(r0, c1.saturating_add(1), -1);
            marks.add(r1.saturating_add(1), c0, -1);
            marks.add(r1.saturating_add(1), c1.saturating_add(1), 1);
        }
    }
    let mut above = vec![0_i64; usize::try_from(grid.cols).unwrap_or(0)];
    (0..grid.rows)
        .map(|r| {
            let mut run = 0_i64;
            above
                .iter_mut()
                .zip(0..grid.cols)
                .map(|(total, c)| {
                    run = run.saturating_add(marks.get(r, c));
                    *total = total.saturating_add(run);
                    *total > 0
                })
                .collect()
        })
        .collect()
}

/// The maximal free run of each row, as a box one cell tall. Reading one cell
/// past the last column is what closes a run that reaches the right edge.
fn free_runs(occupied: &[Vec<bool>], grid: &Grid) -> Vec<BoundingBox> {
    let mut regions = Vec::new();
    for (r, row) in (0..grid.rows).zip(occupied) {
        let mut start: Option<u32> = None;
        for c in 0..=grid.cols {
            let free = row.get(usize::try_from(c).unwrap_or(usize::MAX)) == Some(&false);
            match (free, start) {
                (true, None) => start = Some(c),
                (false, Some(from)) => {
                    regions.push(BoundingBox {
                        x: grid.min_x + f64::from(from) * GRID_PX,
                        y: grid.min_y + f64::from(r) * GRID_PX,
                        w: f64::from(c.saturating_sub(from)) * GRID_PX,
                        h: GRID_PX,
                    });
                    start = None;
                }
                _ => {}
            }
        }
    }
    regions
}

/// Row first, then column. Two runs of a row never start at one column, so
/// no two regions tie on both.
fn by_position(a: &BoundingBox, b: &BoundingBox) -> core::cmp::Ordering {
    compare_numbers(a.y, b.y).then_with(|| compare_numbers(a.x, b.x))
}

/// The free regions and whether a guard dropped any: the cell budget, or the
/// region cap, which keeps the largest.
///
/// # Errors
///
/// [`DigestError::InvalidGrid`] for the grid the TypeScript cannot allocate.
pub(super) fn free_regions(entries: &[Entry]) -> Result<(Vec<BoundingBox>, bool), DigestError> {
    if entries.is_empty() {
        return Ok((Vec::new(), false));
    }
    let grid = match plan(entries)? {
        Plan::OverBudget => return Ok((Vec::new(), true)),
        Plan::NoRows => return Ok((Vec::new(), false)),
        Plan::Scan(grid) => grid,
    };
    let mut regions = free_runs(&occupancy(entries, &grid), &grid);
    if regions.len() <= MAX_REGIONS {
        return Ok((regions, false));
    }
    regions.sort_by(|a, b| compare_numbers(b.w * b.h, a.w * a.h).then_with(|| by_position(a, b)));
    regions.truncate(MAX_REGIONS);
    regions.sort_by(by_position);
    Ok((regions, true))
}
