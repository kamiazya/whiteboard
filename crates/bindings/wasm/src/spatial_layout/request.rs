//! What `layout_spatial_canvas` is asked, read from the value wire of
//! [`crate::json_canvas_wire`]: one mapping whose fields are the layout's
//! options as data. Read strictly, as the canvas is: a key the request does
//! not name, a field of another kind or a missing required one is no request.

use whiteboard_canvas_render::node_box::{FacetCard, FacetRow};
use whiteboard_canvas_render::references::{
    ExtraImage, LoadedReference, ReferenceExtra, ReferenceWire,
};
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::edge_sides::EdgeAnchorOverride;
use whiteboard_edge_routing::geometry::Point;
use whiteboard_model::Value;
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_plugin_visual::visual::{TagKeyDeclaration, TagLibrary, TagValueDeclaration};

use crate::json_canvas_wire::{Fields, Read, canvas_of, items_of, number_of, string_of};

/// One face of a font-table measurer: where its bytes sit in the fonts argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Face {
    pub(crate) family: String,
    pub(crate) bold: bool,
    pub(crate) italic: bool,
    pub(crate) from: usize,
    pub(crate) to: usize,
}

/// The measurer the host's own `measure` is, named as data.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MeasureSpec {
    /// `createFakeMeasure(factor)`.
    Fake(f64),
    /// `constantRatioMeasureText`, the estimate with no font.
    Ratio,
    /// The Node measurer over these faces.
    Fonts(Vec<Face>),
}

/// A layout request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Request {
    pub(crate) canvas: SpatialCanvas,
    pub(crate) measure: MeasureSpec,
    pub(crate) dark: bool,
    pub(crate) geometry: Option<SpatialGeometry>,
    pub(crate) locked: Vec<String>,
    pub(crate) suppressed: Vec<String>,
    pub(crate) overrides: Option<Vec<(String, EdgeAnchorOverride)>>,
    pub(crate) tags: Option<TagLibrary>,
    pub(crate) embed_path: Vec<String>,
    pub(crate) references: ReferenceWire,
    pub(crate) expand: bool,
}

fn flag_of(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

fn strings_of(value: &Value) -> Option<Vec<String>> {
    items_of(value, string_of)
}

/// A whole number that indexes the fonts argument.
fn offset_of(value: &Value) -> Option<usize> {
    let n = number_of(value)?;
    let whole = n.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&n);
    whole.then(|| format!("{n}").parse().ok()).flatten()
}

/// The entries of a mapping, each read by `read`.
fn entries_of<T>(value: &Value, read: impl Fn(&Value) -> Option<T>) -> Option<Vec<(String, T)>> {
    match value {
        Value::Map(entries) => {
            entries.iter().map(|(key, item)| Some((key.clone(), read(item)?))).collect()
        }
        _ => None,
    }
}

/// A two-item list, each item read by its own reader.
fn pair_of<A, B>(
    value: &Value,
    first: impl Fn(&Value) -> Option<A>,
    second: impl Fn(&Value) -> Option<B>,
) -> Option<(A, B)> {
    match value {
        Value::Seq(items) => match items.as_slice() {
            [a, b] => Some((first(a)?, second(b)?)),
            _ => None,
        },
        _ => None,
    }
}

fn face_of(value: &Value) -> Option<Face> {
    let mut f = Fields::of(value)?;
    let face = Face {
        family: f.field("family", string_of)??,
        bold: f.field("bold", flag_of)??,
        italic: f.field("italic", flag_of)??,
        from: f.field("from", offset_of)??,
        to: f.field("to", offset_of)??,
    };
    f.all_named().then_some(face)
}

fn measure_of(value: &Value) -> Option<MeasureSpec> {
    let mut f = Fields::of(value)?;
    let spec = match f.field("kind", string_of)??.as_str() {
        "fake" => MeasureSpec::Fake(f.field("factor", number_of)??),
        "ratio" => MeasureSpec::Ratio,
        "fonts" => MeasureSpec::Fonts(f.field("faces", |v| items_of(v, face_of))??),
        _ => return None,
    };
    f.all_named().then_some(spec)
}

fn dark_of(value: &Value) -> Option<bool> {
    match string_of(value)?.as_str() {
        "light" => Some(false),
        "dark" => Some(true),
        _ => None,
    }
}

fn geometry_of(value: &Value) -> Option<SpatialGeometry> {
    let mut f = Fields::of(value)?;
    let geometry = SpatialGeometry {
        padding_px: f.field("paddingPx", number_of)??,
        label_font_size_px: f.field("labelFontSizePx", number_of)??,
        min_content_width_px: f.field("minContentWidthPx", number_of)??,
    };
    f.all_named().then_some(geometry)
}

fn side_of(value: &Value) -> Option<Side> {
    Some(match string_of(value)?.as_str() {
        "top" => Side::Top,
        "bottom" => Side::Bottom,
        "left" => Side::Left,
        "right" => Side::Right,
        _ => return None,
    })
}

fn point_of(value: &Value) -> Option<Point> {
    let mut f = Fields::of(value)?;
    let point = Point { x: f.field("x", number_of)??, y: f.field("y", number_of)?? };
    f.all_named().then_some(point)
}

fn override_of(value: &Value) -> Option<EdgeAnchorOverride> {
    let mut f = Fields::of(value)?;
    let sides = SidePair {
        from_side: f.field("fromSide", side_of)??,
        to_side: f.field("toSide", side_of)??,
        around: f.field("around", flag_of)?.unwrap_or_default(),
    };
    let pin = EdgeAnchorOverride {
        sides,
        from: f.field("from", point_of)?,
        from_lane_depth: f.field("fromLaneDepth", number_of)?,
        to: f.field("to", point_of)?,
        to_lane_depth: f.field("toLaneDepth", number_of)?,
    };
    f.all_named().then_some(pin)
}

fn tag_value_of(value: &Value) -> Option<TagValueDeclaration> {
    let mut f = Fields::of(value)?;
    let declaration = TagValueDeclaration {
        color: f.field("color", string_of)?,
        description: f.field("description", string_of)?,
    };
    f.all_named().then_some(declaration)
}

fn tag_key_of(value: &Value) -> Option<TagKeyDeclaration> {
    let mut f = Fields::of(value)?;
    let declaration = TagKeyDeclaration {
        description: f.field("description", string_of)?,
        exclusive: f.field("exclusive", flag_of)?,
        values: f.field("values", |v| entries_of(v, tag_value_of))?,
    };
    f.all_named().then_some(declaration)
}

/// A graph entry: `null` is "looked up, nothing there".
fn loaded_of(value: &Value) -> Read<LoadedReference> {
    if *value == Value::Null {
        return Some(None);
    }
    let mut f = Fields::of(value)?;
    let loaded = LoadedReference {
        document_id: f.field("documentId", string_of)?,
        name: f.field("name", string_of)?,
        body: f.field("body", string_of)?,
        canvas: f.field("canvas", canvas_of)?,
    };
    f.all_named().then_some(Some(loaded))
}

fn image_of(value: &Value) -> Option<ExtraImage> {
    let mut f = Fields::of(value)?;
    let image = ExtraImage {
        href: f.field("href", string_of)??,
        alt: f.field("alt", string_of)?,
        width: f.field("width", number_of)?,
        height: f.field("height", number_of)?,
    };
    f.all_named().then_some(image)
}

fn row_of(value: &Value) -> Option<FacetRow> {
    let mut f = Fields::of(value)?;
    let row =
        FacetRow { label: f.field("label", string_of)??, value: f.field("value", string_of)?? };
    f.all_named().then_some(row)
}

fn card_of(value: &Value) -> Option<FacetCard> {
    let mut f = Fields::of(value)?;
    let card = FacetCard {
        title: f.field("title", string_of)?,
        rows: f.field("rows", |v| items_of(v, row_of))??,
    };
    f.all_named().then_some(card)
}

fn extra_of(value: &Value) -> Option<ReferenceExtra> {
    let mut f = Fields::of(value)?;
    let extra = ReferenceExtra {
        label: f.field("label", string_of)?,
        missing: f.field("missing", flag_of)?,
        image: f.field("image", image_of)?,
        facets: f.field("facets", card_of)?,
    };
    f.all_named().then_some(extra)
}

fn table_of<T>(value: &Value, read: impl Fn(&Value) -> Option<T>) -> Option<Vec<(String, T)>> {
    items_of(value, |row| pair_of(row, string_of, &read))
}

fn references_of(value: &Value) -> Option<ReferenceWire> {
    let mut f = Fields::of(value)?;
    let wire = ReferenceWire {
        entries: f.field("entries", |v| table_of(v, loaded_of))??,
        aliases: f.field("aliases", |v| table_of(v, string_of))??,
        titles: f.field("titles", |v| table_of(v, string_of))??,
        extras: f.field("extras", |v| table_of(v, extra_of))??,
    };
    f.all_named().then_some(wire)
}

/// The request a value stands for, or `None` when it is none.
pub(crate) fn request_of(value: &Value) -> Option<Request> {
    let mut f = Fields::of(value)?;
    let request = Request {
        canvas: f.field("canvas", canvas_of)??,
        measure: f.field("measure", measure_of)??,
        dark: f.field("mode", dark_of)??,
        geometry: f.field("geometry", geometry_of)?,
        locked: f.field("lockedNodeIds", strings_of)?.unwrap_or_default(),
        suppressed: f.field("suppressedBodyNodeIds", strings_of)?.unwrap_or_default(),
        overrides: f.field("sideOverrides", |v| table_of(v, override_of))?,
        tags: f.field("tagLibrary", |v| entries_of(v, tag_key_of))?,
        embed_path: f.field("embedPath", strings_of)?.unwrap_or_default(),
        references: f.field("references", references_of)?.unwrap_or_default(),
        expand: f.field("expand", flag_of)??,
    };
    f.all_named().then_some(request)
}
