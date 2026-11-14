use std::collections::BTreeMap;

use whiteboard_codec::markdown::parse_markdown_body;
use whiteboard_codec::references::resolve_references;
use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::{CanvasLine, LineEnd, LineEndPoint, SpatialCanvas, SpatialNode};

use super::{ExtraImage, LoadedReference, ReferenceExtra, ReferenceWire, Refused, WireHost};
use crate::compose_node::{ComposeHost, Degradation};
use crate::node_box::{FacetCard, FacetRow, ReferenceImage, ResolvedReference};
use crate::typeset::{
    CanvasSummary, CodeTokenizer, EmbedResolver, Embedded, ImageRef, InlineSeams,
};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn node(id: &str) -> SpatialNode {
    SpatialNode { id: id.to_owned(), width: 10.0, height: 10.0, ..SpatialNode::default() }
}

fn canvas(nodes: usize, lines: usize) -> SpatialCanvas {
    let line = |i: usize| CanvasLine {
        id: format!("l{i}"),
        from: LineEnd::LineEndPoint(LineEndPoint::default()),
        to: LineEnd::LineEndPoint(LineEndPoint::default()),
        ..CanvasLine::default()
    };
    SpatialCanvas {
        nodes: (0..nodes).map(|i| node(&format!("n{i}"))).collect(),
        lines: (lines > 0).then(|| (0..lines).map(line).collect()),
        ..SpatialCanvas::default()
    }
}

fn loaded(id: Option<&str>, name: Option<&str>, body: Option<&str>) -> LoadedReference {
    LoadedReference {
        document_id: id.map(str::to_owned),
        name: name.map(str::to_owned),
        body: body.map(str::to_owned),
        canvas: None,
    }
}

fn parsed(text: &str, aliases: &[(&str, &str)]) -> Root {
    let table: BTreeMap<String, String> =
        aliases.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect();
    resolve_references(&parse_markdown_body(text).unwrap_or_default(), &table)
}

fn wire() -> ReferenceWire {
    let board = LoadedReference { canvas: Some(canvas(2, 1)), ..LoadedReference::default() };
    let empty = LoadedReference { canvas: Some(canvas(0, 0)), ..LoadedReference::default() };
    ReferenceWire {
        entries: vec![
            ("note".to_owned(), Some(loaded(Some("D1"), Some("Note"), Some("see [[other]]")))),
            ("blank".to_owned(), Some(loaded(None, Some("Blank"), Some(" \n\u{feff}\t")))),
            ("board".to_owned(), Some(board)),
            ("empty".to_owned(), Some(empty)),
            ("gone".to_owned(), None),
            ("other".to_owned(), Some(loaded(Some("D2"), None, None))),
            ("twice".to_owned(), Some(loaded(None, Some("first"), None))),
            ("twice".to_owned(), Some(loaded(None, Some("second"), None))),
        ],
        aliases: vec![("alias".to_owned(), "D9".to_owned()), ("other".to_owned(), "D3".to_owned())],
        titles: vec![("D9".to_owned(), "Nine".to_owned()), ("D2".to_owned(), "Two".to_owned())],
        extras: vec![
            (
                "note".to_owned(),
                ReferenceExtra {
                    label: Some("Shown".to_owned()),
                    missing: Some(true),
                    image: Some(ExtraImage {
                        href: "data:x".to_owned(),
                        alt: Some("alt".to_owned()),
                        width: Some(4.0),
                        height: None,
                    }),
                    facets: Some(FacetCard {
                        title: Some("T".to_owned()),
                        rows: vec![FacetRow { label: "a".to_owned(), value: "b".to_owned() }],
                    }),
                },
            ),
            ("bare".to_owned(), ReferenceExtra::default()),
        ],
    }
}

#[test]
fn a_body_resolves_its_targets_through_the_wire_aliases_ahead_of_the_graph() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    let body = "[[alias]] [[other]] [[note]] [[nothing]]";
    let want = parsed(body, &[("alias", "D9"), ("other", "D3"), ("note", "D1")]);
    assert_eq!(host.parse_body(body), Ok(want));
    assert_ne!(host.parse_body(body), Ok(parsed(body, &[])));
    assert_eq!(host.refused(), None);
}

#[test]
fn a_reference_draws_its_record_under_the_surface_extras() {
    let wire = wire();
    let host = WireHost::new(&wire, false);
    let note = host.resolve_reference("note");
    assert_eq!(
        note,
        Some(ResolvedReference {
            label: Some("Shown".to_owned()),
            missing: true,
            image: Some(ReferenceImage { href: "data:x".to_owned(), alt: Some("alt".to_owned()) }),
            canvas: None,
            markdown: Some(parsed("see [[other]]", &[("other", "D3"), ("note", "D1")])),
            facets: wire.extras.first().and_then(|(_, e)| e.facets.clone()),
        })
    );
    let blank = host.resolve_reference("blank");
    assert_eq!(
        blank,
        Some(ResolvedReference { label: Some("Blank".to_owned()), ..Default::default() })
    );
    let board = host.resolve_reference("board");
    assert_eq!(board.and_then(|r| r.canvas).map(|c| c.nodes.len()), Some(2));
    for nothing in ["empty", "gone", "bare", "unknown"] {
        assert_eq!(host.resolve_reference(nothing), None, "{nothing}");
    }
    let twice = host.resolve_reference("twice").and_then(|r| r.label);
    assert_eq!(twice.as_deref(), Some("second"));
    assert!(!host.expand_file_node(&node("n")));
    assert!(WireHost::new(&wire, true).expand_file_node(&node("n")));
}

#[test]
fn an_embed_is_a_body_or_a_canvas_named_by_its_record_or_the_title_table() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    let note = host.resolve_embed("D1", None);
    let root = parsed("see [[other]]", &[("other", "D3"), ("note", "D1")]);
    assert_eq!(note, Some(Embedded::Document { title: Some("Note".to_owned()), root }));
    let board = host.resolve_embed("board", None);
    let summary = Some(CanvasSummary { elements: 3, empty: false });
    assert_eq!(board, Some(Embedded::Canvas { title: None, canvas: summary }));
    let empty = host.resolve_embed("empty", None);
    let summary = Some(CanvasSummary { elements: 0, empty: true });
    assert_eq!(empty, Some(Embedded::Canvas { title: None, canvas: summary }));
    assert_eq!(host.resolve_embed("D2", None), None);
    assert_eq!(host.embed_name("D1").as_deref(), Some("Note"));
    assert_eq!(host.embed_name("board"), None);
    assert_eq!(host.embedded_canvas("board", None).map(|c| c.nodes.len()), Some(2));
    assert_eq!(host.embedded_canvas("D1", None), None);
    assert_eq!(host.refused(), None);
}

#[test]
fn a_title_is_the_record_name_then_the_table() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    assert_eq!(host.document_title("D1").as_deref(), Some("Note"));
    assert_eq!(host.document_title("D2").as_deref(), Some("Two"));
    assert_eq!(host.document_title("D9").as_deref(), Some("Nine"));
    assert_eq!(host.document_title("D7"), None);
    assert!(!host.embed_pending("D1"));
}

#[test]
fn a_picture_is_the_surface_extra_with_its_natural_size() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    let want = ImageRef { href: "data:x".to_owned(), width: Some(4.0), height: None };
    assert_eq!(host.image_reference("note"), Some(want));
    assert_eq!(host.image_reference("bare"), None);
    assert_eq!(host.image_reference("board"), None);
}

#[test]
fn what_only_the_typescript_can_answer_refuses_the_layout_keeping_the_first_reason() {
    let wire = wire();
    let shortcode = WireHost::new(&wire, true);
    assert_eq!(shortcode.expand_emoji("a :x"), "a :x");
    assert!(shortcode.icon_ranges("one: colon").is_empty());
    assert_eq!(shortcode.refused(), None);
    assert_eq!(shortcode.expand_emoji("a :rocket: b"), "a :rocket: b");
    assert_eq!(shortcode.refused(), Some(Refused::Shortcode));
    assert_eq!(shortcode.tokenize("rust", "fn"), None);
    assert_eq!(shortcode.refused(), Some(Refused::Shortcode));

    let icons = WireHost::new(&wire, true);
    assert!(icons.icon_ranges(":a: :b:").is_empty());
    assert_eq!(icons.refused(), Some(Refused::Shortcode));

    let code = WireHost::new(&wire, true);
    assert_eq!(code.tokenize("", "fn"), None);
    assert_eq!(code.refused(), None);
    assert_eq!(code.tokenize("rust", "fn"), None);
    assert_eq!(code.refused(), Some(Refused::Highlight));

    let fragment = WireHost::new(&wire, true);
    assert_eq!(fragment.embedded_canvas("board", Some("f")), None);
    assert_eq!(fragment.refused(), Some(Refused::Fragment));
    let fragment = WireHost::new(&wire, true);
    assert_eq!(fragment.resolve_embed("board", Some("f")), None);
    assert_eq!(fragment.refused(), Some(Refused::Fragment));
    let section = WireHost::new(&wire, true);
    assert!(section.resolve_embed("D1", Some("f")).is_some());
    assert_eq!(section.refused(), None);
}

#[test]
fn a_body_past_the_parser_bounds_refuses_the_layout() {
    let long = "a".repeat(whiteboard_markdown_max() + 1);
    let wire = ReferenceWire {
        entries: vec![("big".to_owned(), Some(loaded(Some("B"), Some("Big"), Some(&long))))],
        ..ReferenceWire::default()
    };
    let host = WireHost::new(&wire, true);
    assert!(host.parse_body(&long).is_err());
    assert_eq!(host.refused(), Some(Refused::Body));
    let host = WireHost::new(&wire, true);
    assert!(host.parse_markdown(&long).is_err());
    assert_eq!(host.refused(), Some(Refused::Body));
    let host = WireHost::new(&wire, true);
    assert_eq!(host.resolve_embed("B", None), None);
    assert_eq!(host.refused(), Some(Refused::Body));
    let host = WireHost::new(&wire, true);
    assert_eq!(host.resolve_reference("big").and_then(|r| r.markdown), None);
    assert_eq!(host.refused(), Some(Refused::Body));
    let host = WireHost::new(&wire, true);
    assert_eq!(
        host.parse_markdown("[[x]]"),
        parse_markdown_body("[[x]]").map_err(|_| unreachable())
    );
    assert_eq!(host.refused(), None);
}

/// The parser's byte bound (`whiteboard_markdown::limits::MAX_BYTES`).
const fn whiteboard_markdown_max() -> usize {
    786_432
}

fn unreachable() -> crate::compose_node::ParseFailed {
    crate::compose_node::ParseFailed
}

#[test]
fn degradations_are_kept_in_order() {
    let wire = ReferenceWire::default();
    let host = WireHost::new(&wire, true);
    let first = Degradation::UnknownTheme { theme: "a".to_owned() };
    let second = Degradation::FontMissing { family: "b".to_owned() };
    host.degrade(first.clone());
    host.degrade(second.clone());
    assert_eq!(host.degradations(), vec![first, second]);
}

#[test]
fn each_refusal_names_its_class() {
    let classes = [Refused::Body, Refused::Shortcode, Refused::Highlight, Refused::Fragment]
        .map(Refused::class);
    assert_eq!(classes, ["body", "shortcode", "highlight", "fragment"]);
}
