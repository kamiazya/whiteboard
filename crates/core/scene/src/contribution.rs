//! What a plugin contributes to drawing: the geometry vocabulary, and the
//! trait a per-node decoration implements.

use whiteboard_model::spatial::SpatialNode;

use crate::appearance::{Appearance, BoundingBox};
use crate::graph::SceneNode;

/// A point in canvas coordinates, the shape a scene path is made of.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct ScenePoint {
    pub x: f64,
    pub y: f64,
}

/// A node's silhouette, as a kind plus numbers derived from its box, never
/// stored path coordinates, so translating a scene moves the box and the
/// outline follows.
#[derive(Debug, Clone, PartialEq)]
pub enum NodeOutline {
    Ellipse {
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
    },
    Polygon {
        points: Vec<ScenePoint>,
    },
    Cylinder {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        /// The lid ellipse's vertical radius: a tenth of the width, capped
        /// at a quarter of the height so short nodes keep a visible body.
        ry: f64,
    },
}

/// What a decoration is told about the node it marks.
#[derive(Debug, Clone, PartialEq)]
pub struct DecorationContext {
    pub bounds: BoundingBox,
    pub label: Appearance,
}

/// A plugin's mark on a node (`NodeDecoration`): the scene nodes drawn over it
/// after its own content, in the shared vocabulary, so the node union stays
/// closed and a contribution builds from it. The renderer asks every
/// contribution in order and appends what each answers.
pub trait NodeDecoration {
    fn decorate(&self, node: &SpatialNode, context: &DecorationContext) -> Vec<SceneNode>;
}
