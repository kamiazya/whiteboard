//! The JSON Canvas codec as properties: a canvas the projection can express
//! reads back as itself, the strict mode keeps exactly what JSON Canvas 1.0
//! states, and a damaged text is either refused or settles after one trip.

use whiteboard_codec::json_canvas::{Mode, SpatialCanvas, parse, serialize};
use whiteboard_model::spatial::{
    Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine,
    CanvasPoint, EdgeEnd, EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeEmbed, NodeResource,
    SpatialNode,
};
use whiteboard_model::{Value, enumeration_order};
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, any, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const AWKWARD: &[&str] = &[
    "\"",
    "\\",
    "\n",
    "\t",
    "\u{0}",
    "\u{1f}",
    "\u{7f}",
    "\u{2028}",
    "\u{e9}",
    "\u{1f600}",
    "/",
    "{",
    "[",
    "a",
];
const FACET_KEYS: &[&str] = &["visual.shape/v0", "a.b/v12", "x-y.z9/v1", "plugin.name/v0"];
const PAYLOAD_KEYS: &[&str] = &["a", "b", "10", "2", "0", "__proto__", "x y", "\u{e9}", "01"];
const URLS: &[&str] = &[
    "https://example.com",
    "http://localhost:8080/a?b=c#d",
    "mailto:a@b.c",
    "foo://bar/baz",
    "https://user@example.org/p",
];
const ULIDS: &[&str] = &["01ARZ3NDEKTSV4RRFFQ69G5FAV", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"];

fn text() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => any::<String>(),
        2 => prop::collection::vec(prop::sample::select(AWKWARD), 0..8).prop_map(|p| p.concat()),
    ]
}

/// A finite double with no negative zero: mostly a fraction with a short
/// binary expansion, since a double drawn at random is almost always so large
/// that it is a whole number.
fn finite() -> impl Strategy<Value = f64> {
    prop_oneof![
        3 => (any::<i32>(), 0u32..12).prop_map(|(n, k)| f64::from(n) / f64::from(1u32 << k)),
        1 => any::<f64>().prop_map(|x| if x.is_finite() { x + 0.0 } else { 0.0 }),
    ]
}

fn whole() -> impl Strategy<Value = f64> {
    prop_oneof![
        8 => (-100_000i32..100_000).prop_map(f64::from),
        1 => prop::sample::select(&[9_007_199_254_740_991.0, -9_007_199_254_740_991.0, 0.0][..]),
    ]
}

fn payload() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        finite().prop_map(Value::Number),
        text().prop_map(Value::String),
    ];
    leaf.prop_recursive(3, 20, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Seq),
            prop::collection::btree_map(prop::sample::select(PAYLOAD_KEYS), inner, 0..4).prop_map(
                |entries| {
                    let entries = entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
                    enumeration_order(Value::Map(entries))
                }
            ),
        ]
    })
}

fn facets() -> impl Strategy<Value = Vec<(String, Value)>> {
    prop::collection::btree_map(prop::sample::select(FACET_KEYS), payload(), 0..3)
        .prop_map(|m| m.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn tags() -> impl Strategy<Value = Vec<String>> {
    prop::collection::vec(text(), 0..3)
}

fn color() -> impl Strategy<Value = CanvasColor> {
    prop_oneof![
        prop::sample::select(&["1", "2", "3", "4", "5", "6"][..]).prop_map(|p| {
            CanvasColor::CanvasColorPreset(CanvasColorPreset::from_wire(p).unwrap_or_default())
        }),
        "#[0-9a-fA-F]{6}".prop_map(CanvasColor::CanvasColorHex),
    ]
}

fn side() -> impl Strategy<Value = EdgeSide> {
    prop::sample::select(&[EdgeSide::Top, EdgeSide::Right, EdgeSide::Bottom, EdgeSide::Left][..])
}

fn arrow() -> impl Strategy<Value = Arrowhead> {
    prop::sample::select(&[Arrowhead::None, Arrowhead::Arrow][..])
}

fn maybe<S: Strategy + 'static>(s: S) -> impl Strategy<Value = Option<S::Value>>
where
    S::Value: Clone + std::fmt::Debug,
{
    prop::option::of(s)
}

fn resource() -> impl Strategy<Value = Option<NodeResource>> {
    prop_oneof![
        2 => Just(None),
        2 => text().prop_map(|content| Some(NodeResource {
            mime_type: "text/markdown".to_string(),
            content: Some(content),
            ..NodeResource::default()
        })),
        2 => (text(), maybe(text().prop_map(|s| format!("#{s}")))).prop_map(|(location, subpath)| {
            Some(NodeResource {
                mime_type: "application/octet-stream".to_string(),
                location: Some(location),
                subpath,
                ..NodeResource::default()
            })
        }),
        2 => prop::sample::select(URLS).prop_map(|url| Some(NodeResource {
            mime_type: "text/uri-list".to_string(),
            location: Some(url.to_string()),
            ..NodeResource::default()
        })),
    ]
}

fn node(id: String) -> impl Strategy<Value = SpatialNode> {
    let geometry = (whole(), whole(), whole().prop_map(f64::abs), whole().prop_map(f64::abs));
    let extension = (
        maybe(color()),
        maybe((prop::sample::select(ULIDS), maybe(Just("v1".to_string())))),
        maybe(facets()),
        maybe(tags()),
    );
    let frame = (
        maybe(text()),
        maybe(text()),
        maybe(prop::sample::select(
            &[BackgroundStyle::Cover, BackgroundStyle::Ratio, BackgroundStyle::Repeat][..],
        )),
    );
    (geometry, extension, resource(), frame).prop_map(move |(g, e, resource, f)| {
        let framed = resource.is_none();
        SpatialNode {
            id: id.clone(),
            x: g.0,
            y: g.1,
            width: g.2,
            height: g.3,
            color: e.0,
            embed: e.1.map(|(doc, version)| NodeEmbed {
                document_id: doc.to_string(),
                version_ref: version,
            }),
            facets: e.2,
            tags: e.3,
            resource,
            label: if framed { f.0 } else { None },
            background: if framed { f.1 } else { None },
            background_style: if framed { f.2 } else { None },
        }
    })
}

fn bends(limit: usize) -> impl Strategy<Value = Option<Vec<CanvasPoint>>> {
    maybe(prop::collection::vec(
        (whole(), whole()).prop_map(|(x, y)| CanvasPoint { x, y }),
        1..=limit,
    ))
}

fn edge(id: String, nodes: usize) -> impl Strategy<Value = CanvasEdge> {
    let end = move || {
        (0..nodes, maybe(side()), maybe(arrow())).prop_map(|(at, side, end)| EdgeEnd {
            node: format!("n{at}"),
            side,
            end,
        })
    };
    (end(), end(), maybe(color()), maybe(text()), bends(4), maybe(facets()), maybe(tags()))
        .prop_map(move |(from, to, color, label, bends, facets, tags)| CanvasEdge {
            id: id.clone(),
            from,
            to,
            color,
            label,
            bends,
            facets,
            tags,
        })
}

fn line_end(nodes: usize) -> impl Strategy<Value = LineEnd> {
    let on_node = (0..nodes.max(1), maybe(side()), maybe(arrow())).prop_map(|(at, side, end)| {
        LineEnd::LineEndNode(LineEndNode { node: format!("n{at}"), side, end })
    });
    let free = (finite(), finite(), maybe(arrow())).prop_map(|(x, y, end)| {
        LineEnd::LineEndPoint(LineEndPoint { point: CanvasPoint { x, y }, end })
    });
    prop_oneof![on_node, free]
}

fn line(id: String, nodes: usize) -> impl Strategy<Value = CanvasLine> {
    let ink = bends(3).prop_map(|b| {
        b.map(|b| b.into_iter().map(|p| CanvasPoint { x: p.x / 3.0, y: p.y }).collect())
    });
    (line_end(nodes), line_end(nodes), maybe(color()), maybe(text()), ink, maybe(facets()))
        .prop_map(move |(from, to, color, label, bends, facets)| CanvasLine {
            id: id.clone(),
            from,
            to,
            color,
            label,
            bends,
            facets,
        })
}

/// A canvas the projection can express: whole geometry, ids that are unique and
/// named, ends that name nodes that are there, a location that is a URL where a
/// link needs one.
fn canvas() -> impl Strategy<Value = SpatialCanvas> {
    (0usize..4).prop_flat_map(|count| {
        let nodes = (0..count).map(|at| node(format!("n{at}"))).collect::<Vec<_>>();
        let edges = if count == 0 {
            Just(Vec::new()).boxed()
        } else {
            (0..4usize)
                .prop_flat_map(move |n| {
                    (0..n).map(|at| edge(format!("e{at}"), count)).collect::<Vec<_>>()
                })
                .boxed()
        };
        let lines = prop::option::weighted(
            0.7,
            (0..4usize).prop_flat_map(move |n| {
                (0..n).map(|at| line(format!("l{at}"), count)).collect::<Vec<_>>()
            }),
        );
        (nodes, edges, lines, maybe(facets()), maybe(tags())).prop_map(
            |(nodes, edges, lines, facets, tags)| SpatialCanvas {
                nodes,
                edges,
                lines,
                facets,
                tags,
            },
        )
    })
}

#[test]
fn what_the_extended_writer_writes_the_reader_reads_back_as_the_same_canvas() {
    let embeds = Floor::new("a canvas with an embed");
    let ink = Floor::new("a canvas with a line");
    let bent = Floor::new("a canvas with a bent edge");
    let linked = Floor::new("a canvas with a link");
    let facetted = Floor::new("a canvas with facets");
    let fractional = Floor::new("a canvas with a fractional ink coordinate");
    check(canvas(), None, |canvas| {
        embeds.draw(canvas.nodes.iter().any(|n| n.embed.is_some()));
        ink.draw(canvas.lines.as_ref().is_some_and(|l| !l.is_empty()));
        bent.draw(canvas.edges.iter().any(|e| e.bends.is_some()));
        linked.draw(
            canvas
                .nodes
                .iter()
                .any(|n| n.resource.as_ref().is_some_and(|r| r.mime_type == "text/uri-list")),
        );
        facetted.draw(canvas.facets.as_ref().is_some_and(|f| !f.is_empty()));
        fractional.draw(canvas.lines.iter().flatten().any(|l| {
            [&l.from, &l.to]
                .into_iter()
                .any(|end| matches!(end, LineEnd::LineEndPoint(p) if p.point.x.fract() != 0.0))
        }));
        let written = serialize(&canvas, Mode::Extended);
        prop_assert!(written.is_ok(), "{canvas:?} has no spelling: {written:?}");
        let written = written.unwrap_or_default();
        let read = parse(&written);
        prop_assert!(read.is_ok(), "{written:?} is refused: {read:?}");
        prop_assert_eq!(read.unwrap_or_default(), canvas, "{}", written);
        Ok(())
    });
    embeds.assert(60);
    ink.assert(60);
    bent.assert(40);
    linked.assert(30);
    facetted.assert(40);
    fractional.assert(40);
}

/// What JSON Canvas 1.0 itself states of a canvas: no extension anywhere.
fn stated(canvas: &SpatialCanvas) -> SpatialCanvas {
    SpatialCanvas {
        nodes: canvas
            .nodes
            .iter()
            .map(|n| SpatialNode { embed: None, facets: None, tags: None, ..n.clone() })
            .collect(),
        edges: canvas
            .edges
            .iter()
            .map(|e| CanvasEdge { bends: None, facets: None, tags: None, ..e.clone() })
            .collect(),
        lines: None,
        facets: None,
        tags: None,
    }
}

#[test]
fn the_strict_writer_writes_what_json_canvas_states_and_nothing_else() {
    let extras = Floor::new("a canvas with something the format cannot state");
    check(canvas(), None, |canvas| {
        let has_extension = canvas.lines.is_some()
            || canvas.facets.is_some()
            || canvas.tags.is_some()
            || canvas
                .nodes
                .iter()
                .any(|n| n.embed.is_some() || n.facets.is_some() || n.tags.is_some())
            || canvas
                .edges
                .iter()
                .any(|e| e.bends.is_some() || e.facets.is_some() || e.tags.is_some());
        extras.draw(has_extension);
        let written = serialize(&canvas, Mode::Strict);
        prop_assert!(written.is_ok(), "{canvas:?} has no strict spelling: {written:?}");
        let written = written.unwrap_or_default();
        prop_assert!(!written.contains("x-whiteboard"), "{written}");
        prop_assert_eq!(parse(&written), Ok(stated(&canvas)), "{}", written);
        Ok(())
    });
    extras.assert(100);
}

/// A serialization with a few characters inserted, removed or swapped.
fn damaged() -> impl Strategy<Value = String> {
    let edits = prop::collection::vec(
        (
            any::<prop::sample::Index>(),
            0u8..3,
            prop::sample::select(&['"', ',', '}', ']', ':', '\\', '1', '-', 'e', ' ', '{'][..]),
        ),
        0..4,
    );
    (canvas(), edits).prop_map(|(canvas, edits)| {
        let mut chars: Vec<char> =
            serialize(&canvas, Mode::Extended).unwrap_or_default().chars().collect();
        for (at, kind, piece) in edits {
            let i = at.index(chars.len() + 1).min(chars.len());
            match (kind, chars.get(i)) {
                (0, _) => chars.insert(i, piece),
                (1, Some(_)) => {
                    chars.remove(i);
                }
                (_, Some(_)) => {
                    if let Some(slot) = chars.get_mut(i) {
                        *slot = piece;
                    }
                }
                _ => {}
            }
        }
        chars.into_iter().collect()
    })
}

#[test]
fn a_damaged_text_is_refused_or_settles_after_one_trip() {
    let read = Floor::new("a damaged text that is still read");
    let refused = Floor::new("a damaged text that is refused");
    check(damaged(), None, |text| {
        let outcome = parse(&text);
        read.draw(outcome.is_ok());
        refused.draw(outcome.is_err());
        if let Ok(canvas) = outcome {
            let once = serialize(&canvas, Mode::Extended);
            prop_assert!(once.is_ok(), "{canvas:?} has no spelling: {once:?}");
            let once = once.unwrap_or_default();
            let again = parse(&once).map(|c| serialize(&c, Mode::Extended));
            prop_assert_eq!(again, Ok(Ok(once.clone())), "{}", once);
        }
        Ok(())
    });
    read.assert(50);
    refused.assert(50);
}

#[test]
fn any_text_is_answered_without_a_panic() {
    check(any::<String>(), None, |text| {
        let _ = parse(&text);
        Ok(())
    });
}
