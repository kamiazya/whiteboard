use std::collections::BTreeMap;

use whiteboard_codec::markdown::parse_markdown_body;
use whiteboard_codec::references::resolve_references;
use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::{CanvasLine, LineEnd, LineEndPoint, SpatialCanvas, SpatialNode};

use super::{
    Expansion, ExtraImage, FenceTokens, LoadedReference, ReferenceExtra, ReferenceWire, Refused,
    WireHost,
};
use crate::canvas_fragment::select_canvas_fragment;
use crate::compose_node::{ComposeHost, Degradation};
use crate::node_box::{FacetCard, FacetRow, ReferenceImage, ResolvedReference};
use crate::typeset::{
    CanvasSummary, CodeToken, CodeTokenLines, CodeTokenizer, EmbedResolver, Embedded, IconRange,
    ImageRef, InlineSeams, NestedLayoutBudget, TokenRole,
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
fn a_fence_a_narrowed_embed_and_a_section_refuse_nothing() {
    let wire = wire();
    let code = WireHost::new(&wire, true);
    assert_eq!(code.tokenize("rust", "fn", None), None);
    assert_eq!(code.embedded_canvas("board", Some("f")), None);
    assert_eq!(code.refused(), None);

    let section = WireHost::new(&wire, true);
    assert!(section.resolve_embed("D1", Some("f")).is_some());
    assert_eq!(section.refused(), None);
}

/// Two frames apart and a line: `^n1` selects one frame and keeps the line.
fn apart() -> (SpatialCanvas, ReferenceWire) {
    let mut board = canvas(2, 1);
    if let Some(n1) = board.nodes.get_mut(1) {
        n1.x = 100.0;
    }
    let entry = LoadedReference { canvas: Some(board.clone()), ..LoadedReference::default() };
    let wire = ReferenceWire {
        entries: vec![("board".to_owned(), Some(entry))],
        ..ReferenceWire::default()
    };
    (board, wire)
}

#[test]
fn a_canvas_embed_is_narrowed_to_the_part_its_fragment_names() {
    let (board, wire) = apart();
    let host = WireHost::new(&wire, true);
    let part = select_canvas_fragment(&board, "^n1");
    assert!(part.as_ref().is_some_and(|p| p.nodes.len() == 1), "the fixture selects one node");
    assert_eq!(host.embedded_canvas("board", Some(" ^n1 ")), part);
    let summary = CanvasSummary { elements: 2, empty: false };
    let want = Embedded::Canvas { title: None, canvas: Some(summary) };
    assert_eq!(host.resolve_embed("board", Some("^n1")), Some(want));
    assert_eq!(host.embedded_canvas("board", None), Some(board));
    assert_eq!(host.refused(), None);
}

#[test]
fn a_fragment_naming_nothing_is_a_canvas_with_no_part_not_a_refusal() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    assert_eq!(host.embedded_canvas("board", Some("Nope")), None);
    let want = Embedded::Canvas { title: None, canvas: None };
    assert_eq!(host.resolve_embed("board", Some("^missing")), Some(want));
    assert_eq!(host.embedded_canvas("gone", Some("^n0")), None);
    assert_eq!(host.resolve_embed("gone", Some("^n0")), None);
    assert_eq!(host.refused(), None);
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
fn shortcodes_are_answered_from_the_plugin_tables_without_a_refusal() {
    let wire = ReferenceWire::default();
    let host = WireHost::new(&wire, true);
    assert_eq!(host.expand_emoji("a :rocket: at 10:30: b"), "a 🚀 at 10:30: b");
    let want = IconRange { from: 2, to: 13, name: "star".to_owned() };
    assert_eq!(host.icon_ranges("😀:icon-star: :icon-nope:"), vec![want]);
    assert_eq!(host.refused(), None);
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
    assert_eq!(Refused::Body.class(), "body");
}

fn lines(text: &str) -> CodeTokenLines {
    vec![vec![CodeToken { text: text.to_owned(), role: Some(TokenRole::Keyword) }]]
}

fn fence(lang: &str, value: &str, lines: Option<CodeTokenLines>) -> FenceTokens {
    FenceTokens { lang: lang.to_owned(), value: value.to_owned(), lines }
}

#[test]
fn a_fence_the_highlighter_colours_answers_its_tokens_as_the_host_sent_them() {
    let wire = wire();
    let table = [
        fence("js", "let", Some(lines("old"))),
        fence("js", "let", Some(lines("let"))),
        fence("ts", "y", None),
    ];
    let host = WireHost::new(&wire, true).with_code_tokens(&table);
    let budget = NestedLayoutBudget::new();
    assert_eq!(host.tokenize("js", "let", Some(&budget)), Some(lines("let")));
    assert_eq!(budget.tokenizer_remaining().0, NestedLayoutBudget::WORD_RUNS - 9);
    assert_eq!(host.tokenize("ts", "y", Some(&budget)), None);
    assert_eq!(host.tokenize("JS", "let", None), None);
    assert_eq!(host.needs(), vec![("JS".to_owned(), "let".to_owned())]);
    assert_eq!(budget.refused(), 0);
    assert_eq!(host.refused(), None);
}

#[test]
fn a_fence_with_no_tokens_is_asked_for_once_and_no_cache_keeps_its_body() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    let budget = NestedLayoutBudget::new();
    for _ in 0..2 {
        assert_eq!(host.tokenize("python", "z", Some(&budget)), None);
    }
    assert_eq!(host.tokenize("yaml", "a: 1", Some(&budget)), None);
    let asked = [("python", "z"), ("yaml", "a: 1")].map(|(l, v)| (l.to_owned(), v.to_owned()));
    assert_eq!(host.needs(), asked.to_vec());
    assert_eq!(budget.refused(), 3);
    assert_eq!(host.refused(), None);
}

#[test]
fn a_fence_the_highlighter_would_leave_plain_is_neither_asked_for_nor_refused() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    let budget = NestedLayoutBudget::new();
    for (lang, value) in [("", "fn"), ("rust", "fn"), ("js", &"a".repeat(4097))] {
        assert_eq!(host.tokenize(lang, value, Some(&budget)), None);
    }
    assert!(host.needs().is_empty());
    assert_eq!(budget.refused(), 0);
    assert_eq!(host.refused(), None);
}

#[test]
fn a_file_node_opens_when_the_settled_policy_names_its_id() {
    let wire = wire();
    let ids = vec!["f1".to_owned(), "f3".to_owned()];
    let host = WireHost::new(&wire, Expansion::Only(ids));
    assert!(host.expand_file_node(&node("f1")));
    assert!(host.expand_file_node(&node("f3")));
    assert!(!host.expand_file_node(&node("f2")));
    assert!(!WireHost::new(&wire, Expansion::Only(Vec::new())).expand_file_node(&node("f1")));
    assert!(WireHost::new(&wire, Expansion::Every(true)).expand_file_node(&node("f2")));
    assert!(!WireHost::new(&wire, Expansion::Every(false)).expand_file_node(&node("f2")));
}
