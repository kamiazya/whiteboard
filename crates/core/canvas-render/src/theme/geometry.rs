//! `spatial-geometry.ts`: the geometry half of the theme layer. It is
//! deliberately NOT part of an appearance resolver — it drives wrapped-line
//! counts and content bounds, so a surface choosing its own value would lay the
//! same canvas out differently depending on who rendered it. A layout defaults
//! to [`SPATIAL_THEME_GEOMETRY`] and takes an override only when a caller
//! passes one.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpatialGeometry {
    /// Uniform padding (px) between a node's box edge and its laid-out content.
    pub padding_px: f64,
    /// Font size (px) used for label runs (file/link/group labels, edge labels).
    pub label_font_size_px: f64,
    /// Floor for a node's derived content width, so padding never drives it negative.
    pub min_content_width_px: f64,
}

pub const SPATIAL_THEME_GEOMETRY: SpatialGeometry =
    SpatialGeometry { padding_px: 8.0, label_font_size_px: 16.0, min_content_width_px: 0.0 };
