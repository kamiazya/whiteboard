//! The coordinate vocabulary every tidy pass is written in.
//!
//! Each rule is stated once and run twice, so each would otherwise branch on
//! the axis at every read of a position, every write of one, and every pick of
//! an origin or a floor, each branch being the one place a rule can be written
//! asymmetrically by accident.

use whiteboard_det::math::js_round;
use whiteboard_edge_routing::geometry::Rect;

use super::units::{TIDY_GRID_PX, Unit, js_eq};

/// The grid is laid from an ORIGIN, which inside a frame is the frame's own
/// corner rather than the board's zero: a frame is snapped to the board's grid
/// like anything else, and a member placed against the board's grid before that
/// move would be carried the same distance off it. Laid from the frame's
/// corner, a member's position is a fact about the frame, and moving the frame
/// carries it and its grid together.
pub(super) fn round_to_grid(v: f64, origin: f64) -> f64 {
    origin + js_round((v - origin) / TIDY_GRID_PX) * TIDY_GRID_PX
}

pub(super) fn ceil_to_grid(v: f64, origin: f64) -> f64 {
    origin + ((v - origin) / TIDY_GRID_PX).ceil() * TIDY_GRID_PX
}

/// Whether `value` sits on one of `anchors`, to the half pixel parity allows.
pub(super) fn on_some_anchor(value: f64, anchors: &[f64]) -> bool {
    anchors.iter().any(|anchor| (anchor - value).abs() <= 0.5)
}

/// An axis as a THING rather than a string each site re-reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Axis {
    X,
    Y,
}

pub(super) const AXES: [Axis; 2] = [Axis::X, Axis::Y];

impl Axis {
    /// The near edge: a rect's own x or y.
    pub(super) fn near(self, r: &Rect) -> f64 {
        self.pick(r.x, r.y)
    }

    /// The extent along this axis: a rect's w or h.
    pub(super) fn size(self, r: &Rect) -> f64 {
        self.pick(r.w, r.h)
    }

    /// The anchor at `fraction` of the extent: 0 near, 0.5 centre, 1 far.
    pub(super) fn at(self, r: &Rect, fraction: f64) -> f64 {
        self.near(r) + self.size(r) * fraction
    }

    /// This axis's component of anything shaped like a pair: an origin, a
    /// floor, the outside anchors.
    pub(super) fn pick<T>(self, x: T, y: T) -> T {
        match self {
            Axis::X => x,
            Axis::Y => y,
        }
    }

    /// `r` as it would be `delta` along this axis, without moving `r`.
    pub(super) fn moved(self, r: &Rect, delta: f64) -> Rect {
        match self {
            Axis::X => Rect { x: r.x + delta, ..*r },
            Axis::Y => Rect { y: r.y + delta, ..*r },
        }
    }

    /// Moves a unit, keeping its box and its accumulated delta in step.
    pub(super) fn shift(self, unit: &mut Unit, delta: f64) {
        if js_eq(delta, 0.0) {
            return;
        }
        match self {
            Axis::X => {
                unit.bbox.x += delta;
                unit.dx += delta;
            }
            Axis::Y => {
                unit.bbox.y += delta;
                unit.dy += delta;
            }
        }
    }

    /// The anchors a drawer actually sets on this axis: the near edge, the
    /// centre, and on x the far edge: a width is named, a height is usually
    /// fitted to the text.
    pub(super) fn band_fractions(self) -> &'static [f64] {
        match self {
            Axis::X => &[0.0, 0.5, 1.0],
            Axis::Y => &[0.0, 0.5],
        }
    }
}
