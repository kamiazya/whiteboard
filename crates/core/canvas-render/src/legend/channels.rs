//! The reading of the facet score (`quality/facet-score.ts`, ADR-0033) that the
//! legend is derived from: what the colour channel of the boxes, and of the
//! edges, is doing, and which declared distinctions carry it. The score's
//! columns (deficit, overload, excess and the rest) and its shape channel are
//! not read by anything ported, so they are not ported.
//!
//! A channel is `carried` by a declared partition when it is constant within
//! every class of it; differing across two classes follows, since one value
//! everywhere is `unused` before any partition is asked. The boxes' partitions
//! are, in order: the first frame holding each box, what each box shows, the
//! stencil it wears, each scoped-tag key (ADR-0040 decision 3) and each axis
//! the canvas declares (`visual.axes/v0`). A partition of one class declares
//! nothing and is dropped. The edges' are their scoped-tag keys alone.

use std::collections::BTreeMap;

use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::Value;
use whiteboard_model::node_content::{is_frame, node_kind};
use whiteboard_model::spatial::{CanvasColor, ExtensionFacets, SpatialCanvas, SpatialNode};
use whiteboard_model::tags::parse_scoped_tag;
use whiteboard_plugin_visual::read::{VISUAL_AXES_KEY, node_stencil};

/// What a channel is doing: one value everywhere, spent with no declared
/// distinction behind it, or carried by the named distinctions, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelUse {
    Unused,
    Contested,
    Carried(Vec<String>),
}

/// The colour channel of a board's two populations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColourChannels {
    pub boxes: ChannelUse,
    pub edges: ChannelUse,
}

/// A declared distinction: its name, and its population's indices by class.
struct Partition {
    name: String,
    classes: Vec<Vec<usize>>,
}

/// The classes of a population, in order of first appearance.
fn partition<C: PartialEq>(name: &str, classes: impl IntoIterator<Item = C>) -> Partition {
    let mut seen: Vec<(C, Vec<usize>)> = Vec::new();
    for (at, class) in classes.into_iter().enumerate() {
        match seen.iter_mut().find(|(held, _)| *held == class) {
            Some((_, members)) => members.push(at),
            None => seen.push((class, vec![at])),
        }
    }
    Partition { name: name.to_owned(), classes: seen.into_iter().map(|(_, m)| m).collect() }
}

/// Keys the boxes already partition by under their own name.
const BUILT_IN: [&str; 3] = ["frame", "kind", "stencil"];

/// One partition per scoped-tag key, in key order: an element carrying none is
/// the `""` class, and a key some element carries twice (even one value twice)
/// partitions nothing.
fn tag_partitions(tags: &[Option<&[String]>]) -> Vec<Partition> {
    let mut by_key: BTreeMap<&str, Vec<(usize, &str)>> = BTreeMap::new();
    for (at, written) in tags.iter().enumerate() {
        for (key, value) in written.unwrap_or_default().iter().filter_map(|t| parse_scoped_tag(t)) {
            if !BUILT_IN.contains(&key) {
                by_key.entry(key).or_default().push((at, value));
            }
        }
    }
    by_key
        .into_iter()
        .filter_map(|(key, placed)| {
            let mut classes = vec![""; tags.len()];
            for (at, value) in placed {
                let slot = classes.get_mut(at)?;
                if !slot.is_empty() {
                    return None;
                }
                *slot = value;
            }
            Some(partition(key, classes))
        })
        .collect()
}

/// Edge-inclusive: a box sharing a border with a frame is inside it.
fn contains(outer: &SpatialNode, inner: &SpatialNode) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height
}

fn facet<'f>(facets: Option<&'f ExtensionFacets>, key: &str) -> Option<&'f Value> {
    facets?.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// The facet keys a canvas names as its semantic axes, each once; a payload
/// of another shape names none.
fn declared_axes(canvas: &SpatialCanvas) -> Vec<&str> {
    let Some(Value::Map(declared)) = facet(canvas.facets.as_ref(), VISUAL_AXES_KEY) else {
        return Vec::new();
    };
    let Some(Value::Seq(axes)) = facet(Some(declared), "axes") else { return Vec::new() };
    let mut keys: Vec<&str> = Vec::new();
    for axis in axes {
        if let Value::String(key) = axis
            && !keys.contains(&key.as_str())
        {
            keys.push(key);
        }
    }
    keys
}

/// A payload as `facetPayloadKey` tells payloads apart: a mapping's keys in
/// one order, and an absent payload as `null`.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Map(entries) => {
            let mut sorted: Vec<(String, Value)> =
                entries.iter().map(|(key, item)| (key.clone(), canonical(item))).collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Map(sorted)
        }
        Value::Seq(items) => Value::Seq(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn box_partitions(
    canvas: &SpatialCanvas,
    boxes: &[&SpatialNode],
    registry: &Registry,
) -> Vec<Partition> {
    let frames: Vec<&SpatialNode> = canvas.nodes.iter().filter(|n| is_frame(n)).collect();
    let frame_of = |b: &SpatialNode| frames.iter().find(|f| contains(f, b)).map(|f| f.id.as_str());
    let tags: Vec<Option<&[String]>> = boxes.iter().map(|b| b.tags.as_deref()).collect();
    let mut out = vec![
        partition("frame", boxes.iter().map(|b| frame_of(b))),
        partition("kind", boxes.iter().map(|b| node_kind(b))),
        partition(
            "stencil",
            boxes.iter().map(|b| node_stencil(b.facets.as_ref(), registry).unwrap_or_default()),
        ),
    ];
    out.extend(tag_partitions(&tags));
    for key in declared_axes(canvas) {
        let payload =
            |b: &SpatialNode| facet(b.facets.as_ref(), key).map_or(Value::Null, canonical);
        out.push(partition(key, boxes.iter().map(|b| payload(b))));
    }
    out
}

/// Whether every class of `p` shows one value.
fn constant_within(p: &Partition, values: &[Option<&CanvasColor>]) -> bool {
    p.classes.iter().all(|members| {
        let first = members.first().and_then(|&at| values.get(at));
        members.iter().all(|&at| values.get(at) == first)
    })
}

fn channel_use(values: &[Option<&CanvasColor>], partitions: &[Partition]) -> ChannelUse {
    let first = values.first();
    if values.iter().all(|value| Some(value) == first) {
        return ChannelUse::Unused;
    }
    let carried: Vec<String> = partitions
        .iter()
        .filter(|p| p.classes.len() >= 2 && constant_within(p, values))
        .map(|p| p.name.clone())
        .collect();
    if carried.is_empty() { ChannelUse::Contested } else { ChannelUse::Carried(carried) }
}

/// What the colour of a board's boxes and of its edges is doing.
#[must_use]
pub fn colour_channels(canvas: &SpatialCanvas, registry: &Registry) -> ColourChannels {
    let boxes: Vec<&SpatialNode> = canvas.nodes.iter().filter(|n| !is_frame(n)).collect();
    let box_colours: Vec<Option<&CanvasColor>> = boxes.iter().map(|b| b.color.as_ref()).collect();
    let edge_colours: Vec<Option<&CanvasColor>> =
        canvas.edges.iter().map(|e| e.color.as_ref()).collect();
    let edge_tags: Vec<Option<&[String]>> =
        canvas.edges.iter().map(|e| e.tags.as_deref()).collect();
    ColourChannels {
        boxes: channel_use(&box_colours, &box_partitions(canvas, &boxes, registry)),
        edges: channel_use(&edge_colours, &tag_partitions(&edge_tags)),
    }
}
