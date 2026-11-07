//! The edge layer's input as one flat `f64` array: ADR-0054 decision 9's
//! declared typed-array fast path, which the layout's one call crosses.
//!
//! Ids are interned by the caller into small integers, equal strings to one
//! integer (`routing_input` says why the TypeScript needs that). The layout
//! is `[node count, then id, x, y, w, h per node, edge count, then per edge
//! its id, its from end, its to end, a bend count and x, y per bend]`. An
//! end is five numbers, `[kind, a, b, side, arrowhead]`:
//! - kind 0 is a node, `a` its id and `b` unused;
//! - kind 1 is a free point at `(a, b)`;
//! - side is an `edgeSideSchema.options` index or `-1` for none;
//! - arrowhead is `0` for `'none'`, `1` for `'arrow'` or `-1` for unset.
//!
//! A bend count of `-1` is an absent `bends`.

use crate::edge_primitives::count;
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::routing_input::{Arrowhead, RoutableEdge, RoutingEnd, RoutingNode};

/// A side from its wire index, `None` for `-1` or anything else.
pub(crate) fn side_of(index: f64) -> Option<Side> {
    match index {
        0.0 => Some(Side::Top),
        1.0 => Some(Side::Right),
        2.0 => Some(Side::Bottom),
        3.0 => Some(Side::Left),
        _ => None,
    }
}

/// A side as its wire index.
pub(crate) fn side_index(side: Side) -> f64 {
    match side {
        Side::Top => 0.0,
        Side::Right => 1.0,
        Side::Bottom => 2.0,
        Side::Left => 3.0,
    }
}

fn id_of(value: f64) -> Option<u32> {
    count(value).and_then(|n| u32::try_from(n).ok())
}

/// A cursor over the wire, every read checked.
pub(crate) struct Wire<'a> {
    rest: &'a [f64],
}

impl<'a> Wire<'a> {
    pub(crate) const fn new(values: &'a [f64]) -> Self {
        Self { rest: values }
    }

    pub(crate) fn number(&mut self) -> Option<f64> {
        let (&first, rest) = self.rest.split_first()?;
        self.rest = rest;
        Some(first)
    }

    fn take<const N: usize>(&mut self) -> Option<[f64; N]> {
        let (head, rest) = self.rest.split_first_chunk::<N>()?;
        self.rest = rest;
        Some(*head)
    }

    pub(crate) fn point(&mut self) -> Option<Point> {
        let [x, y] = self.take::<2>()?;
        Some(Point { x, y })
    }

    pub(crate) fn rest(&self) -> &'a [f64] {
        self.rest
    }

    pub(crate) fn is_done(&self) -> bool {
        self.rest.is_empty()
    }

    pub(crate) fn nodes(&mut self) -> Option<Vec<RoutingNode>> {
        let len = count(self.number()?)?;
        (0..len)
            .map(|_| {
                let [id, x, y, w, h] = self.take::<5>()?;
                Some(RoutingNode { id: id_of(id)?, rect: Rect { x, y, w, h } })
            })
            .collect()
    }

    fn end(&mut self) -> Option<RoutingEnd> {
        let [kind, a, b, side, arrowhead] = self.take::<5>()?;
        let arrowhead = match arrowhead {
            0.0 => Some(Arrowhead::None),
            1.0 => Some(Arrowhead::Arrow),
            _ => None,
        };
        match kind {
            0.0 => Some(RoutingEnd::Node { node: id_of(a)?, side: side_of(side), arrowhead }),
            1.0 => Some(RoutingEnd::Point { point: Point { x: a, y: b }, arrowhead }),
            _ => None,
        }
    }

    pub(crate) fn edges(&mut self) -> Option<Vec<RoutableEdge>> {
        let n = count(self.number()?)?;
        (0..n)
            .map(|_| {
                let id = id_of(self.number()?)?;
                let (from, to) = (self.end()?, self.end()?);
                let bends = match self.number()? {
                    -1.0 => None,
                    k => Some((0..count(k)?).map(|_| self.point()).collect::<Option<Vec<_>>>()?),
                };
                Some(RoutableEdge { id, from, to, bends })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::Wire;
    use whiteboard_edge_routing::routing_input::RoutingEnd;

    #[test]
    fn a_node_and_an_edge_with_a_free_end_decode_and_a_short_wire_is_refused() {
        let wire = [
            1.0,
            4.0,
            0.0,
            0.0,
            10.0,
            10.0, // one node
            1.0,
            9.0,
            0.0,
            4.0,
            f64::NAN,
            1.0,
            1.0, // edge 9 from node 4's right side, arrow
            1.0,
            5.0,
            6.0,
            -1.0,
            -1.0, // to the point (5, 6)
            -1.0, // no bends
        ];
        let mut w = Wire::new(&wire);
        let nodes = w.nodes().unwrap_or_default();
        let edges = w.edges().unwrap_or_default();
        assert_eq!((nodes.len(), edges.len(), w.is_done()), (1, 1, true));
        assert!(matches!(edges.first().map(|e| e.to), Some(RoutingEnd::Point { .. })));
        assert!(
            Wire::new(&wire[..9]).nodes().is_some_and(|_| Wire::new(&wire[6..9]).edges().is_none())
        );
    }
}
