//! Geometry and paint, the two things every scene node is built from.

/// A box in canvas coordinates; `w` and `h` may be negative in a hand-built
/// scene, which readers normalise.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A soft halo around an element in its own paint.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, rename_all = "camelCase")
)]
pub struct Glow {
    pub radius_px: f64,
}

/// Resolved paint attributes for a shape, text run or edge. Every field is
/// optional and assigned, never invented: an absent one is omitted from the
/// drawing rather than defaulted.
#[derive(Debug, Clone, PartialEq, Default)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, rename_all = "camelCase", default)
)]
pub struct Appearance {
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub stroke_width: Option<f64>,
    pub font_family: Option<String>,
    pub font_size: Option<f64>,
    /// Alpha applied to the fill, so a run whose colour is inherited can still be tinted.
    pub fill_opacity: Option<f64>,
    pub stroke_opacity: Option<f64>,
    /// The canvas surface colour a label sits on, painted as an underlay.
    pub halo: Option<String>,
    /// An SVG `stroke-dasharray` value, verbatim.
    pub stroke_dasharray: Option<String>,
    /// A soft drop shadow under the element (`dropShadow?: true`).
    pub drop_shadow: bool,
    pub glow: Option<Glow>,
}

/// How a style inks chrome other than crisp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum SceneInkStyle {
    Sketch,
}

/// A hatched fill in place of the flat one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum SceneInkFill {
    Hatch,
}

/// A style's ink assignment on a node or an edge. `seed` is `seedFromId` of
/// the element's id, an unsigned 32-bit value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct SceneInk {
    pub style: SceneInkStyle,
    pub seed: u32,
    #[cfg_attr(feature = "oracle", serde(default))]
    pub fill: Option<SceneInkFill>,
}
