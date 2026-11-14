//! The board's legend (`legend/canvas-legend.ts`, ADR-0040 decision 6),
//! derived from the colour readings ([`channels`]) so it can only name a
//! distinction the drawing keeps: a scoped-tag key is listed when a
//! population's colour is carried by it, each value with the swatch its class
//! is drawn in, resolved by the appearance the layout paints with. A frame, a
//! kind or a stencil carrying the colour has no values to name and is not
//! listed; colour spent with no key carrying it is said in one flag per
//! population.

pub mod channels;

use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::node_content::is_frame;
use whiteboard_model::spatial::{CanvasEdge, SpatialCanvas, SpatialNode};
use whiteboard_model::tags::parse_scoped_tag;
use whiteboard_scene::{LegendEntry, LegendKey, LegendKind, LegendSwatch, SceneLegend, Uncarried};

use crate::theme::appearance::{RoutableElement, SpatialAppearanceResolver};
use channels::{ChannelUse, colour_channels};

/// An element's scoped tags as (key, value), the first value under a key winning.
fn scoped_tags(tags: Option<&[String]>) -> Vec<(&str, &str)> {
    let mut scoped: Vec<(&str, &str)> = Vec::new();
    for (key, value) in tags.unwrap_or_default().iter().filter_map(|t| parse_scoped_tag(t)) {
        if !scoped.iter().any(|(seen, _)| *seen == key) {
            scoped.push((key, value));
        }
    }
    scoped
}

fn value_under<'t>(scoped: &[(&str, &'t str)], key: &str) -> &'t str {
    scoped.iter().find(|(seen, _)| *seen == key).map_or("", |(_, value)| value)
}

/// One population's elements, each with its scoped tags and its swatch.
struct Population<'p> {
    of: LegendKind,
    scoped: Vec<Vec<(&'p str, &'p str)>>,
    swatches: Vec<LegendSwatch>,
}

/// Each value under `key` with how many elements hold it and the swatch of
/// the first, named values in code-unit order and the untagged class last.
/// The swatch is constant within a class: that is what carried means.
fn entries_for(population: &Population<'_>, key: &str) -> Vec<LegendEntry> {
    let mut entries: Vec<LegendEntry> = Vec::new();
    for (scoped, swatch) in population.scoped.iter().zip(&population.swatches) {
        let value = value_under(scoped, key);
        match entries.iter_mut().find(|entry| entry.value == value) {
            Some(entry) => entry.count += 1.0,
            None => entries.push(LegendEntry {
                value: value.to_owned(),
                count: 1.0,
                swatch: swatch.clone(),
            }),
        }
    }
    entries.sort_by(|a, b| (a.value.is_empty(), &a.value).cmp(&(b.value.is_empty(), &b.value)));
    entries
}

/// The keys carrying a population's colour that are scoped tags of it.
fn legend_keys(population: &Population<'_>, usage: &ChannelUse) -> Vec<LegendKey> {
    let ChannelUse::Carried(carried_by) = usage else { return Vec::new() };
    carried_by
        .iter()
        .filter(|key| population.scoped.iter().flatten().any(|(seen, _)| seen == key))
        .map(|key| LegendKey {
            key: key.clone(),
            of: population.of,
            entries: entries_for(population, key),
        })
        .collect()
}

fn box_swatch(appearance: &dyn SpatialAppearanceResolver, node: &SpatialNode) -> LegendSwatch {
    let resolved = appearance.resolve_node(node).appearance.unwrap_or_default();
    LegendSwatch { fill: resolved.fill, stroke: resolved.stroke }
}

fn edge_swatch(appearance: &dyn SpatialAppearanceResolver, edge: &CanvasEdge) -> LegendSwatch {
    let stroke = appearance.resolve_edge(RoutableElement::Edge(edge)).and_then(|a| a.stroke);
    LegendSwatch { fill: None, stroke }
}

/// The legend of `canvas` (`canvasLegend`), or none when there is nothing to say.
#[must_use]
pub fn canvas_legend(
    canvas: &SpatialCanvas,
    appearance: &dyn SpatialAppearanceResolver,
    registry: &Registry,
) -> Option<SceneLegend> {
    let channels = colour_channels(canvas, registry);
    let boxes: Vec<&SpatialNode> = canvas.nodes.iter().filter(|n| !is_frame(n)).collect();
    let mut keys = legend_keys(
        &Population {
            of: LegendKind::Boxes,
            scoped: boxes.iter().map(|b| scoped_tags(b.tags.as_deref())).collect(),
            swatches: boxes.iter().map(|b| box_swatch(appearance, b)).collect(),
        },
        &channels.boxes,
    );
    keys.extend(legend_keys(
        &Population {
            of: LegendKind::Edges,
            scoped: canvas.edges.iter().map(|e| scoped_tags(e.tags.as_deref())).collect(),
            swatches: canvas.edges.iter().map(|e| edge_swatch(appearance, e)).collect(),
        },
        &channels.edges,
    ));
    let uncarried = Uncarried {
        boxes: channels.boxes == ChannelUse::Contested,
        edges: channels.edges == ChannelUse::Contested,
    };
    (!keys.is_empty() || uncarried.boxes || uncarried.edges)
        .then_some(SceneLegend { keys, uncarried })
}
