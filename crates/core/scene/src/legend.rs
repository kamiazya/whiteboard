//! What a board's colour means, for the reader: the legend a document draws
//! in a corner (ADR-0040 decision 6).

/// The paint one value is drawn in.
#[derive(Debug, Clone, PartialEq, Default)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields, default))]
pub struct LegendSwatch {
    pub fill: Option<String>,
    pub stroke: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct LegendEntry {
    /// The value under the key; the empty string is the untagged class, listed last.
    pub value: String,
    pub count: f64,
    pub swatch: LegendSwatch,
}

/// Which population a key partitions: a box swatch is a filled rect, an
/// edge's a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum LegendKind {
    Boxes,
    Edges,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct LegendKey {
    pub key: String,
    pub of: LegendKind,
    pub entries: Vec<LegendEntry>,
}

/// Colour spent on a population with no key carrying it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct Uncarried {
    pub boxes: bool,
    pub edges: bool,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct SceneLegend {
    pub keys: Vec<LegendKey>,
    pub uncarried: Uncarried,
}
