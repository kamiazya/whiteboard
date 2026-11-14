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
//! the canvas declares (`visual.axes/v0`). The edges' are their scoped-tag
//! keys alone. A partition of one class declares nothing, and needs no
//! filter: a channel constant within it holds one value everywhere, which is
//! `unused` before any partition is asked.

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

/// A declared distinction: its name, and the population indices of each
/// LISTED class. Sparse, as `facet-score.ts`'s is: a scoped-tag key is
/// carried by the few elements naming it while a board may hold many keys, so
/// listing every element per key made the reading keys × elements. The
/// unlisted class (the untagged, `""`) is still a class, read as the
/// population less what is listed.
struct Partition {
    name: String,
    classes: Vec<Vec<usize>>,
}

/// The classes of a population, in order of first appearance, every member
/// listed.
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
/// in the unlisted `""` class, and a key some element carries twice (even one
/// value twice) partitions nothing. Only the tagged elements are listed.
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
            if placed.windows(2).any(|pair| matches!(pair, [a, b] if a.0 == b.0)) {
                return None;
            }
            let mut by_value: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
            for &(at, value) in &placed {
                by_value.entry(value).or_default().push(at);
            }
            Some(Partition { name: key.to_owned(), classes: by_value.into_values().collect() })
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

/// A colour as `==` tells colours apart: a preset's numeral or a hex
/// string, which no preset spells.
fn colour_key(colour: Option<&CanvasColor>) -> Option<&str> {
    colour.map(|c| match c {
        CanvasColor::CanvasColorPreset(preset) => preset.as_str(),
        CanvasColor::CanvasColorHex(hex) => hex.as_str(),
    })
}

/// How many elements of a population show each value.
type Totals<'v> = BTreeMap<Option<&'v str>, usize>;

fn bump<'v>(counts: &mut Totals<'v>, value: Option<&'v str>) {
    let n = counts.entry(value).or_default();
    *n = n.saturating_add(1);
}

/// Whether every class of `p`, the unlisted one included, shows one value.
/// The unlisted class shows a value exactly when the population shows it
/// more often than the listed classes do.
fn constant_within(p: &Partition, values: &[Option<&str>], totals: &Totals) -> bool {
    let mut listed: Totals = BTreeMap::new();
    for members in &p.classes {
        let first = members.first().and_then(|&at| values.get(at));
        if !members.iter().all(|&at| values.get(at) == first) {
            return false;
        }
        for &at in members {
            bump(&mut listed, values.get(at).copied().flatten());
        }
    }
    let in_rest = totals.iter().filter(|(value, n)| listed.get(*value).unwrap_or(&0) < n);
    in_rest.count() <= 1
}

/// One value everywhere is `unused`, answered before any partition is built:
/// an uncoloured board pays for none.
fn channel_use(
    colours: &[Option<&CanvasColor>],
    partitions: impl FnOnce() -> Vec<Partition>,
) -> ChannelUse {
    let values: Vec<Option<&str>> = colours.iter().map(|c| colour_key(*c)).collect();
    let mut totals: Totals = BTreeMap::new();
    for value in &values {
        bump(&mut totals, *value);
    }
    if totals.len() <= 1 {
        return ChannelUse::Unused;
    }
    let carried: Vec<String> = partitions()
        .into_iter()
        .filter(|p| constant_within(p, &values, &totals))
        .map(|p| p.name)
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
        boxes: channel_use(&box_colours, || box_partitions(canvas, &boxes, registry)),
        edges: channel_use(&edge_colours, || tag_partitions(&edge_tags)),
    }
}

#[cfg(test)]
mod tests {
    use super::{ChannelUse, canonical, channel_use, tag_partitions};
    use whiteboard_model::Value;
    use whiteboard_model::spatial::{CanvasColor, CanvasColorPreset};

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn map(entries: &[(&str, Value)]) -> Value {
        Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
    }

    #[test]
    fn a_payload_is_one_class_whatever_order_its_keys_were_written_in() {
        let inner = |a: f64, b: f64| map(&[("b", Value::Number(b)), ("a", Value::Number(a))]);
        let written = map(&[("z", Value::Seq(vec![inner(1.0, 2.0)])), ("y", Value::Null)]);
        let reordered = map(&[
            ("y", Value::Null),
            ("z", Value::Seq(vec![map(&[("a", Value::Number(1.0)), ("b", Value::Number(2.0))])])),
        ]);
        assert_ne!(written, reordered);
        assert_eq!(canonical(&written), canonical(&reordered));
        assert_ne!(
            canonical(&written),
            canonical(&map(&[("z", Value::Seq(vec![inner(2.0, 1.0)])), ("y", Value::Null)]))
        );
    }

    #[test]
    fn a_tag_partition_lists_its_tagged_members_and_no_one_else() {
        let tags: Vec<Vec<String>> = (0..300).map(|at| vec![format!("k{at}:v")]).collect();
        let written: Vec<Option<&[String]>> = tags.iter().map(|t| Some(t.as_slice())).collect();
        let partitions = tag_partitions(&written);
        assert_eq!(partitions.len(), 300);
        let listed: usize = partitions.iter().flat_map(|p| &p.classes).map(Vec::len).sum();
        assert_eq!(listed, 300);
    }

    #[test]
    fn the_untagged_class_must_hold_one_colour_too() {
        let red = CanvasColor::CanvasColorPreset(CanvasColorPreset::V1);
        let hex = |written: &str| CanvasColor::CanvasColorHex(written.to_owned());
        let (blue, green) = (hex("#0000ff"), hex("#00ff00"));
        let colours = [Some(&red), Some(&blue), Some(&blue), Some(&green)];
        let one = [String::from("k:a")];
        let two = [String::from("k:b")];
        let untagged_differ = [Some(&one[..]), None, None, None];
        let untagged_agree = [Some(&one[..]), None, None, Some(&two[..])];
        assert_eq!(
            channel_use(&colours, || tag_partitions(&untagged_differ)),
            ChannelUse::Contested
        );
        assert_eq!(
            channel_use(&colours, || tag_partitions(&untagged_agree)),
            ChannelUse::Carried(vec!["k".to_owned()])
        );
    }

    #[test]
    fn one_colour_everywhere_builds_no_partition() {
        let colours = [None, None];
        assert_eq!(channel_use(&colours, || unreachable!()), ChannelUse::Unused);
    }
}
