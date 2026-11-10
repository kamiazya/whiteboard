//! The named checks of `contracts/model`'s `x-wb-check` and `x-wb-matcher`
//! keywords: what a schema cannot state, written once here and once in
//! `packages/model/src/contract-checks.ts` under the camelCase name, and held
//! equal by the differential.

use std::collections::BTreeSet;

use crate::Map;
use crate::spatial::{CanvasComment, EdgeEnd, LineEnd, SpatialCanvas, SpatialNode};

/// The characters `String.prototype.trim` strips: ECMAScript's `WhiteSpace`
/// and `LineTerminator`. Not `char::is_whitespace`, which counts U+0085 and
/// misses U+FEFF.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// An actor is a single line with no surrounding whitespace
/// (`okfActor`: `value.trim() === value && !/[\r\n]/.test(value)`).
pub fn okf_actor(actor: &str) -> bool {
    !actor.starts_with(is_js_space)
        && !actor.ends_with(is_js_space)
        && !actor.contains(['\r', '\n'])
}

/// Consumes `count` ASCII digits from the front of `rest`.
fn digits(rest: &mut &[u8], count: usize) -> bool {
    match rest.split_at_checked(count) {
        Some((head, tail)) if head.iter().all(u8::is_ascii_digit) => {
            *rest = tail;
            true
        }
        _ => false,
    }
}

/// Consumes `byte` from the front of `rest`.
fn byte(rest: &mut &[u8], want: u8) -> bool {
    match rest.split_first() {
        Some((&got, tail)) if got == want => {
            *rest = tail;
            true
        }
        _ => false,
    }
}

/// `^#[0-9a-fA-F]{6}$`: the pattern of the contract's `CanvasColorHex`. Byte
/// for byte, so a trailing newline is no match, as in JavaScript.
pub fn canvas_color_hex(text: &str) -> bool {
    match text.as_bytes().split_first() {
        Some((b'#', digits)) => digits.len() == 6 && digits.iter().all(u8::is_ascii_hexdigit),
        _ => false,
    }
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`: the
/// pattern of the contract's `OkfTimestamp`, matched without a regex engine.
pub fn okf_timestamp(text: &str) -> bool {
    let mut rest = text.as_bytes();
    let date_and_time = digits(&mut rest, 4)
        && byte(&mut rest, b'-')
        && digits(&mut rest, 2)
        && byte(&mut rest, b'-')
        && digits(&mut rest, 2)
        && byte(&mut rest, b'T')
        && digits(&mut rest, 2)
        && byte(&mut rest, b':')
        && digits(&mut rest, 2)
        && byte(&mut rest, b':')
        && digits(&mut rest, 2);
    if !date_and_time {
        return false;
    }
    if byte(&mut rest, b'.') {
        let fraction = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if fraction == 0 {
            return false;
        }
        rest = rest.get(fraction..).unwrap_or_default();
    }
    if byte(&mut rest, b'Z') {
        return rest.is_empty();
    }
    (byte(&mut rest, b'+') || byte(&mut rest, b'-'))
        && digits(&mut rest, 2)
        && byte(&mut rest, b':')
        && digits(&mut rest, 2)
        && rest.is_empty()
}

/// Whether `key` is `{namespace}.{name}/v{n}`:
/// `^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$`.
fn is_extension_facet_key(key: &str) -> bool {
    let name = |part: &str| {
        part.starts_with(|c: char| c.is_ascii_lowercase())
            && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    let Some((namespace, rest)) = key.split_once('.') else { return false };
    let Some((facet, version)) = rest.split_once("/v") else { return false };
    name(namespace)
        && name(facet)
        && !version.is_empty()
        && version.bytes().all(|b| b.is_ascii_digit())
}

/// The keys of an extension-facet bucket that are not `{namespace}.{name}/v{n}`,
/// in written order (`extensionFacetKeys`). Empty is valid.
pub fn extension_facet_keys(facets: &Map) -> Vec<&str> {
    facets.iter().map(|(key, _)| key.as_str()).filter(|key| !is_extension_facet_key(key)).collect()
}

/// The root keys a document models itself (`RESERVED_ROOT_KEYS`), which
/// `facetsRaw` therefore may not hold.
pub const RESERVED_ROOT_KEYS: [&str; 9] =
    ["type", "title", "description", "resource", "tags", "view", "facets", "generated", "verified"];

/// The keys of a `facetsRaw` bucket that are reserved, in written order
/// (`facetsRawKeys`). Empty is valid.
pub fn facets_raw_keys(raw: &Map) -> Vec<&str> {
    raw.iter().map(|(key, _)| key.as_str()).filter(|key| RESERVED_ROOT_KEYS.contains(key)).collect()
}

/// `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`: the pattern of the contract's `DocumentId`,
/// a canonical ULID. Crockford's base32 leaves out `I`, `L`, `O` and `U`, and
/// the first character stays below 8 so the 128-bit value fits.
pub fn canonical_ulid(text: &str) -> bool {
    let crockford = |b: &u8| matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z');
    match text.as_bytes().split_first() {
        Some((first, rest)) => {
            matches!(first, b'0'..=b'7') && rest.len() == 25 && rest.iter().all(crockford)
        }
        None => false,
    }
}

/// A node that shows a resource is not a frame, so it carries none of a
/// frame's fields (`resourceNodeIsNotFrame`).
pub fn resource_node_is_not_frame(node: &SpatialNode) -> bool {
    node.resource.is_none()
        || (node.label.is_none() && node.background.is_none() && node.background_style.is_none())
}

/// A comment is about a node or an edge, never both (`namesOneTarget`).
pub fn names_one_target(comment: &CanvasComment) -> bool {
    comment.target_node_id.is_none() || comment.target_edge_id.is_none()
}

/// One step of the path to the value an issue is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathStep {
    Key(&'static str),
    Index(usize),
}

/// What a check found wrong, and where: the message and path the Zod half
/// reports for the same canvas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasIssue {
    pub path: Vec<PathStep>,
    pub message: String,
}

/// The node an edge's end names, which is always one.
fn edge_end(end: &EdgeEnd) -> Option<&str> {
    Some(end.node.as_str())
}

/// The node a line's end names, if it sits on one.
fn line_end(end: &LineEnd) -> Option<&str> {
    match end {
        LineEnd::LineEndNode(on_node) => Some(on_node.node.as_str()),
        LineEnd::LineEndPoint(_) => None,
    }
}

/// The first id that repeats an earlier one (`findDuplicateId`).
fn first_repeat<'a>(ids: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let mut seen = BTreeSet::new();
    let mut ids = ids;
    ids.find(|id| !seen.insert(*id))
}

/// Every end of `collection` that names a node the canvas does not hold, in
/// order. A free end names nothing and is never missing.
fn dangling_ends<'a>(
    issues: &mut Vec<CanvasIssue>,
    nodes: &BTreeSet<&str>,
    collection: &'static str,
    label: &str,
    ends: impl Iterator<Item = (&'a str, Option<&'a str>, Option<&'a str>)>,
) {
    for (index, (id, from, to)) in ends.enumerate() {
        for (side, node) in [("from", from), ("to", to)] {
            let Some(node) = node else { continue };
            if nodes.contains(node) {
                continue;
            }
            issues.push(CanvasIssue {
                path: vec![
                    PathStep::Key(collection),
                    PathStep::Index(index),
                    PathStep::Key(side),
                    PathStep::Key("node"),
                ],
                message: format!("{label} \"{id}\" references nonexistent {side} node \"{node}\""),
            });
        }
    }
}

/// Node ids are unique; edge and line ids are unique across BOTH collections;
/// and every node an end names exists (`spatialCanvasIntegrity`). Issues come
/// in the order the Zod half reports them.
pub fn spatial_canvas_integrity(canvas: &SpatialCanvas) -> Vec<CanvasIssue> {
    let mut issues = Vec::new();
    let node_ids = || canvas.nodes.iter().map(|node| node.id.as_str());
    if let Some(id) = first_repeat(node_ids()) {
        let message = format!("duplicate node id \"{id}\"");
        issues.push(CanvasIssue { path: vec![PathStep::Key("nodes")], message });
    }
    let lines = canvas.lines.as_deref().unwrap_or_default();
    let edge_ids = canvas.edges.iter().map(|edge| edge.id.as_str());
    if let Some(id) = first_repeat(edge_ids.chain(lines.iter().map(|line| line.id.as_str()))) {
        let message = format!("duplicate edge or line id \"{id}\"");
        issues.push(CanvasIssue { path: vec![PathStep::Key("edges")], message });
    }
    let nodes: BTreeSet<&str> = node_ids().collect();
    let edges = canvas.edges.iter().map(|e| (e.id.as_str(), edge_end(&e.from), edge_end(&e.to)));
    dangling_ends(&mut issues, &nodes, "edges", "edge", edges);
    let lines = lines.iter().map(|l| (l.id.as_str(), line_end(&l.from), line_end(&l.to)));
    dangling_ends(&mut issues, &nodes, "lines", "line", lines);
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Value;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn map(keys: &[&str]) -> Map {
        keys.iter().map(|k| ((*k).to_owned(), Value::Null)).collect()
    }

    #[test]
    fn an_actor_is_one_line_with_no_edge_whitespace_as_javascript_trims_it() {
        for ok in ["human:alice", "a/1", "a b", "\u{85}x", "team:ga4-docs"] {
            assert!(okf_actor(ok), "{ok:?}");
        }
        for bad in [" a", "a ", "a\nb", "a\rb", "\u{feff}a", "a\u{2028}", "\u{a0}", "\tx"] {
            assert!(!okf_actor(bad), "{bad:?}");
        }
        for space in [
            '\u{1680}', '\u{2000}', '\u{2005}', '\u{200a}', '\u{2029}', '\u{202f}', '\u{205f}',
            '\u{3000}',
        ] {
            assert!(!okf_actor(&format!("{space}x")), "{space:?}");
            assert!(!okf_actor(&format!("x{space}")), "{space:?}");
        }
    }

    #[test]
    fn a_hex_colour_is_a_hash_and_six_hex_digits_and_nothing_else() {
        for ok in ["#000000", "#1a2b3c", "#ABCDEF", "#aBcDeF"] {
            assert!(canvas_color_hex(ok), "{ok:?}");
        }
        for bad in [
            "",
            "#",
            "#12345",
            "#1234567",
            "123456",
            "#12345g",
            "#12345G",
            " #123456",
            "#123456\n",
            "##12345",
            "#１２３４５６",
            "#12345é",
        ] {
            assert!(!canvas_color_hex(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_timestamp_is_an_iso_datetime_with_an_explicit_offset() {
        for ok in [
            "2026-11-09T12:00:00Z",
            "2026-11-09T12:00:00.5Z",
            "2026-11-09T12:00:00.123456+09:00",
            "2026-11-09T12:00:00-05:30",
        ] {
            assert!(okf_timestamp(ok), "{ok}");
        }
        for bad in [
            "",
            "2026-11-09",
            "2026-11-09T12:00:00",
            "2026-11-09T12:00:00z",
            "2026-11-09T12:00:00.Z",
            "2026-11-09T12:00:00ZZ",
            "2026-11-09T12:00:00+0900",
            "2026-11-09T12:00:00+09:0",
            "2026-11-09T12:00:00Z\n",
            "26-11-09T12:00:00Z",
            "2026-11-09 12:00:00Z",
            "2026-11-09T12:00:00.5",
            "2026-1x-09T12:00:00Z",
            "2026-11-09T12:0x:00Z",
            "2026-11-09T12:00:00+09:x0",
            "2026-11-09T1\u{0662}:00:00Z",
        ] {
            assert!(!okf_timestamp(bad), "{bad:?}");
        }
    }

    #[test]
    fn extension_facet_keys_name_the_malformed_keys_in_written_order() {
        assert!(extension_facet_keys(&map(&["visual.shape/v0", "a-b.c-d/v12"])).is_empty());
        let bad = [
            "visual",
            "Visual.shape/v0",
            "v.s/v",
            "v.s/vx",
            "v.s/",
            "1v.s/v0",
            "v.1s/v0",
            "v.s/v0x",
        ];
        assert_eq!(extension_facet_keys(&map(&bad)), bad);
        assert_eq!(extension_facet_keys(&map(&["z", "visual.shape/v0", "a"])), ["z", "a"]);
    }

    #[test]
    fn a_reserved_root_key_is_named_wherever_it_sits_in_facets_raw() {
        assert!(facets_raw_keys(&map(&["x-extra", "Type", "other"])).is_empty());
        assert_eq!(facets_raw_keys(&map(&["a", "tags", "b", "verified"])), ["tags", "verified"]);
        for key in RESERVED_ROOT_KEYS {
            assert_eq!(facets_raw_keys(&map(&[key])), [key]);
        }
    }

    mod spatial {
        use super::super::*;
        use crate::spatial::{CanvasEdge, CanvasLine, LineEndNode, LineEndPoint};
        #[cfg(target_arch = "wasm32")]
        use wasm_bindgen_test::wasm_bindgen_test as test;

        #[test]
        fn a_document_id_is_a_canonical_ulid_and_nothing_else() {
            for ok in [
                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
                "00000000000000000000000000",
            ] {
                assert!(canonical_ulid(ok), "{ok}");
            }
            for bad in [
                "",
                "8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
                "01arz3ndektsv4rrffq69g5fav",
                "01ARZ3NDEKTSV4RRFFQ69G5FA",
                "01ARZ3NDEKTSV4RRFFQ69G5FAVV",
                "01ARZ3NDEKTSV4RRFFQ69G5FAI",
                "01ARZ3NDEKTSV4RRFFQ69G5FAL",
                "01ARZ3NDEKTSV4RRFFQ69G5FAO",
                "01ARZ3NDEKTSV4RRFFQ69G5FAU",
                "01ARZ3NDEKTSV4RRFFQ69G5FA\n",
                "01ARZ3NDEKTSV4RRFFQ69G5FA\u{ff21}",
                "\u{ff10}1ARZ3NDEKTSV4RRFFQ69G5FAV",
            ] {
                assert!(!canonical_ulid(bad), "{bad:?}");
            }
            for edge in ['0', '9', 'A', 'H', 'J', 'K', 'M', 'N', 'P', 'T', 'V', 'Z'] {
                assert!(canonical_ulid(&format!("0{}", edge.to_string().repeat(25))), "{edge}");
            }
            for gap in ['I', 'L', 'O', 'U', '/', ':', '@', '[', 'a'] {
                assert!(!canonical_ulid(&format!("0{}", gap.to_string().repeat(25))), "{gap}");
            }
        }

        fn node(id: &str) -> SpatialNode {
            SpatialNode { id: id.to_owned(), ..SpatialNode::default() }
        }

        #[test]
        fn a_node_showing_a_resource_carries_none_of_a_frames_fields() {
            let shows = |f: fn(&mut SpatialNode)| {
                let mut n = node("a");
                n.resource = Some(Default::default());
                f(&mut n);
                n
            };
            assert!(resource_node_is_not_frame(&shows(|_| {})));
            assert!(!resource_node_is_not_frame(&shows(|n| n.label = Some(String::new()))));
            assert!(!resource_node_is_not_frame(&shows(|n| n.background = Some(String::new()))));
            assert!(!resource_node_is_not_frame(&shows(|n| {
                n.background_style = Some(Default::default());
            })));
            let mut frame = node("f");
            assert!(resource_node_is_not_frame(&frame));
            frame.label = Some("Caption".to_owned());
            frame.background = Some("b".to_owned());
            frame.background_style = Some(Default::default());
            assert!(resource_node_is_not_frame(&frame));
        }

        #[test]
        fn a_comment_names_a_node_or_an_edge_never_both() {
            let comment = |node: bool, edge: bool| CanvasComment {
                target_node_id: node.then(|| "n".to_owned()),
                target_edge_id: edge.then(|| "e".to_owned()),
                ..CanvasComment::default()
            };
            assert!(names_one_target(&comment(false, false)));
            assert!(names_one_target(&comment(true, false)));
            assert!(names_one_target(&comment(false, true)));
            assert!(!names_one_target(&comment(true, true)));
        }

        fn edge(id: &str, from: &str, to: &str) -> CanvasEdge {
            let end = |node: &str| EdgeEnd { node: node.to_owned(), ..EdgeEnd::default() };
            CanvasEdge { id: id.to_owned(), from: end(from), to: end(to), ..CanvasEdge::default() }
        }

        fn on_node(node: &str) -> LineEnd {
            LineEnd::LineEndNode(LineEndNode { node: node.to_owned(), ..LineEndNode::default() })
        }

        fn line(id: &str, from: LineEnd, to: LineEnd) -> CanvasLine {
            CanvasLine { id: id.to_owned(), from, to, ..CanvasLine::default() }
        }

        fn canvas(ids: &[&str], edges: Vec<CanvasEdge>, lines: Vec<CanvasLine>) -> SpatialCanvas {
            SpatialCanvas {
                nodes: ids.iter().map(|id| node(id)).collect(),
                edges,
                lines: (!lines.is_empty()).then_some(lines),
                ..SpatialCanvas::default()
            }
        }

        fn issue(path: Vec<PathStep>, message: &str) -> CanvasIssue {
            CanvasIssue { path, message: message.to_owned() }
        }

        use PathStep::{Index, Key};

        #[test]
        fn a_canvas_whose_ids_are_distinct_and_ends_exist_has_no_issue() {
            let free = LineEnd::LineEndPoint(LineEndPoint::default());
            let c = canvas(
                &["a", "b"],
                vec![edge("e", "a", "b")],
                vec![line("l", on_node("a"), free.clone()), line("m", free.clone(), free)],
            );
            assert_eq!(spatial_canvas_integrity(&c), []);
            assert_eq!(spatial_canvas_integrity(&SpatialCanvas::default()), []);
        }

        #[test]
        fn the_first_node_id_to_repeat_is_named_at_the_nodes_path() {
            let c = canvas(&["a", "b", "b", "a"], vec![], vec![]);
            let want = issue(vec![Key("nodes")], "duplicate node id \"b\"");
            assert_eq!(spatial_canvas_integrity(&c), [want]);
        }

        #[test]
        fn an_edge_and_a_line_may_not_share_an_id_but_a_node_may_share_theirs() {
            let want = issue(vec![Key("edges")], "duplicate edge or line id \"x\"");
            let shared = canvas(
                &["a"],
                vec![edge("x", "a", "a")],
                vec![line("x", on_node("a"), on_node("a"))],
            );
            assert_eq!(spatial_canvas_integrity(&shared), [want.clone()]);
            let twice = canvas(&["a"], vec![edge("x", "a", "a"), edge("x", "a", "a")], vec![]);
            assert_eq!(spatial_canvas_integrity(&twice), [want]);
            let node_named_alike = canvas(&["x"], vec![edge("x", "x", "x")], vec![]);
            assert_eq!(spatial_canvas_integrity(&node_named_alike), []);
        }

        #[test]
        fn a_missing_node_is_named_with_its_side_index_and_collection() {
            let c = canvas(
                &["a"],
                vec![edge("e0", "a", "a"), edge("e1", "ghost", "a"), edge("e2", "a", "gone")],
                vec![
                    line("l0", on_node("a"), on_node("a")),
                    line("l1", on_node("nope"), on_node("a")),
                ],
            );
            let at = |collection, index, side| {
                vec![Key(collection), Index(index), Key(side), Key("node")]
            };
            assert_eq!(
                spatial_canvas_integrity(&c),
                [
                    issue(
                        at("edges", 1, "from"),
                        "edge \"e1\" references nonexistent from node \"ghost\""
                    ),
                    issue(
                        at("edges", 2, "to"),
                        "edge \"e2\" references nonexistent to node \"gone\""
                    ),
                    issue(
                        at("lines", 1, "from"),
                        "line \"l1\" references nonexistent from node \"nope\""
                    ),
                ]
            );
        }

        #[test]
        fn a_free_end_is_never_missing_and_every_kind_of_issue_comes_in_order() {
            let free = LineEnd::LineEndPoint(LineEndPoint::default());
            let c =
                canvas(&["a", "a"], vec![edge("x", "a", "b")], vec![line("x", free, on_node("c"))]);
            let issues = spatial_canvas_integrity(&c);
            let messages: Vec<&str> = issues.iter().map(|i| i.message.as_str()).collect();
            assert_eq!(
                messages,
                [
                    "duplicate node id \"a\"",
                    "duplicate edge or line id \"x\"",
                    "edge \"x\" references nonexistent to node \"b\"",
                    "line \"x\" references nonexistent to node \"c\"",
                ]
            );
        }
    }
}
