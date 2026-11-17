//! The board's legend (the TypeScript legend, ADR-0040 decision 6),
//! derived from the colour readings ([`channels`]) so it can only name a
//! distinction the drawing keeps: a scoped-tag key is listed when a
//! population's colour is carried by it, each value with the swatch its class
//! is drawn in, resolved by the appearance the layout paints with. A frame, a
//! kind or a stencil carrying the colour has no values to name and is not
//! listed; colour spent with no key carrying it is said in one flag per
//! population.

pub mod block;
pub mod channels;

use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::node_content::is_frame;
use whiteboard_model::spatial::{CanvasEdge, SpatialCanvas, SpatialNode};
use whiteboard_model::tags::parse_scoped_tag;
use whiteboard_scene::{LegendEntry, LegendKey, LegendKind, LegendSwatch, SceneLegend, Uncarried};

use crate::theme::appearance::{RoutableElement, SpatialAppearanceResolver};
use channels::{BUILT_IN, ChannelUse, colour_channels};

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

/// The keys carrying a population's colour that are scoped tags of it. A
/// built-in name carrying it is the built-in partition, never a tag written
/// under that name (`frame:west`), whose values the colour does not follow.
fn legend_keys(population: &Population<'_>, usage: &ChannelUse) -> Vec<LegendKey> {
    let ChannelUse::Carried(carried_by) = usage else { return Vec::new() };
    carried_by
        .iter()
        .filter(|key| !BUILT_IN.contains(&key.as_str()))
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

#[cfg(test)]
mod tests {
    use whiteboard_model::spatial::{
        CanvasColor, CanvasColorPreset, NodeResource, SpatialCanvas, SpatialNode,
    };
    use whiteboard_plugin_visual::host::visual_registry;

    use super::canvas_legend;
    use crate::theme::mode::SpatialThemeMode;
    use crate::theme::spatial_theme::create_spatial_theme;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn frame(id: &str, width: f64) -> SpatialNode {
        SpatialNode { id: id.to_owned(), width, height: 100.0, ..SpatialNode::default() }
    }

    /// A box at `x` in `colour`: a text node, or a file node when `file`.
    fn card(id: &str, x: f64, colour: CanvasColorPreset, file: bool, tags: &[&str]) -> SpatialNode {
        let (content, location) =
            if file { (None, Some(format!("{id}.png"))) } else { (Some(id.to_owned()), None) };
        let resource = Some(NodeResource { content, location, ..NodeResource::default() });
        let tags = (!tags.is_empty()).then(|| tags.iter().map(|t| (*t).to_owned()).collect());
        SpatialNode {
            id: id.to_owned(),
            x,
            y: 10.0,
            width: 80.0,
            height: 40.0,
            color: Some(CanvasColor::CanvasColorPreset(colour)),
            resource,
            tags,
            ..SpatialNode::default()
        }
    }

    fn legend_of(nodes: Vec<SpatialNode>) -> Option<whiteboard_scene::SceneLegend> {
        let canvas = SpatialCanvas { nodes, ..SpatialCanvas::default() };
        let registry = visual_registry().unwrap_or_else(|e| panic!("{e:?}"));
        canvas_legend(&canvas, &create_spatial_theme(SpatialThemeMode::Light, None), &registry)
    }

    /// The colour follows frame membership alone. `frame:west` is a scoped
    /// tag, not the frame partition — `c` wears it inside `f2` — and listing
    /// it named classes the colour does not follow: its untagged row drew
    /// `e`'s box in `a`'s red.
    #[test]
    fn a_frame_carrying_the_colour_is_not_listed_through_a_frame_tag() {
        use CanvasColorPreset::{V1, V2, V3};
        let legend = legend_of(vec![
            frame("f1", 200.0),
            frame("f2", 400.0),
            card("a", 10.0, V1, false, &[]),
            card("b", 110.0, V1, false, &[]),
            card("c", 210.0, V2, false, &["frame:west"]),
            card("d", 310.0, V2, false, &["frame:east"]),
            card("e", 500.0, V3, false, &[]),
        ]);
        assert_eq!(legend, None);
    }

    /// The same for the kind partition and a `kind:` tag.
    #[test]
    fn a_kind_carrying_the_colour_is_not_listed_through_a_kind_tag() {
        use CanvasColorPreset::{V1, V2};
        let legend = legend_of(vec![
            card("a", 0.0, V1, false, &[]),
            card("b", 100.0, V1, false, &["kind:west"]),
            card("c", 200.0, V2, true, &["kind:west"]),
            card("d", 300.0, V2, true, &["kind:east"]),
        ]);
        assert_eq!(legend, None);
    }
}
