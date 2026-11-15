use serde_json::{Value as Json, json};

use super::tests::{answer, m, request, s};
use super::{MAX_PRIOR_FACET_ENTRIES, MAX_PROPOSAL_CHANGES, MAX_PROPOSALS};

/// A plain JSON value on the value wire: an object a mapping in its written
/// order, an array a list, a number that is no safe integer its bits.
fn wire(value: &Json) -> Json {
    match value {
        Json::Object(o) => m(&o.iter().map(|(k, v)| (k.as_str(), wire(v))).collect::<Vec<_>>()),
        Json::Array(items) => s(items.iter().map(wire).collect()),
        Json::Number(n) if n.is_f64() => {
            json!(["f", format!("{:016x}", n.as_f64().unwrap_or_default().to_bits())])
        }
        other => other.clone(),
    }
}

fn text(id: &str, x: i32, y: i32) -> Json {
    json!({"id": id, "x": x, "y": y, "width": 140, "height": 70,
        "resource": {"mimeType": "text/markdown", "content": id}})
}

/// Three boxes, an edge and a line, the edge `e` with a facet bucket.
fn canvas() -> Json {
    json!({
        "nodes": [text("a", 0, 0), text("b", 400, 0), text("c", 0, 300)],
        "edges": [{"id": "e", "from": {"node": "a"}, "to": {"node": "b", "end": "arrow"},
            "label": "flow", "bends": [{"x": 200, "y": -40}],
            "facets": {"x.k/v0": {"p": 1, "q": [1, {"r": 2}]}}}],
        "lines": [{"id": "k", "from": {"kind": "point", "point": {"x": -200, "y": 100}},
            "to": {"kind": "node", "node": "c"}}]
    })
}

fn lay_out(proposals: &Json) -> Json {
    answer(&request(wire(&canvas()), &[("proposals", wire(proposals))]))
}

fn bare() -> Json {
    answer(&request(wire(&canvas()), &[]))
}

/// The scene node `id` of an answer, at any depth.
fn scene_node<'a>(answer: &'a Json, id: &str) -> Option<&'a Json> {
    fn find<'a>(value: &'a Json, id: &str) -> Option<&'a Json> {
        match value {
            Json::Object(o) if o.get("id") == Some(&json!(id)) => Some(value),
            Json::Object(o) => o.values().find_map(|v| find(v, id)),
            Json::Array(items) => items.iter().find_map(|v| find(v, id)),
            _ => None,
        }
    }
    find(answer.get(1)?, id)
}

fn one(change: &Json) -> Json {
    json!([{"id": "p", "changes": [change]}])
}

fn label_of(proposals: &Json) -> String {
    let drawn = lay_out(proposals);
    assert_eq!(drawn.get(0), Some(&json!("ok")), "{drawn}");
    // The label is the paragraph after the bubble, wrapped across its runs.
    let nodes = drawn.pointer("/1/nodes").and_then(Json::as_array).cloned().unwrap_or_default();
    let at = nodes.iter().position(|n| n["id"] == json!("p/bubble"));
    let label = at.and_then(|i| nodes.get(i + 1)).and_then(|n| n["runs"].as_array().cloned());
    let words = label.unwrap_or_else(|| panic!("no label: {drawn}"));
    words.iter().filter_map(|run| run["text"].as_str()).collect::<Vec<_>>().join(" ")
}

#[test]
fn a_patch_is_outlined_where_it_would_leave_the_node() {
    let patch = one(&json!({"id": "c1", "status": "open", "op": "node.patch", "nodeId": "a",
        "patch": {"x": 10.5, "width": 200}, "assumed": {"x": 0, "width": 140}}));
    let drawn = lay_out(&patch);
    for part in ["c1/outline", "p/bubble", "p/leader"] {
        assert!(scene_node(&drawn, part).is_some(), "{part}: {drawn}");
    }
    let bbox = scene_node(&drawn, "c1/outline").and_then(|o| o.get("bbox")).cloned();
    assert_eq!(bbox, Some(json!({"x": 10.5, "y": 0, "w": 200, "h": 70})));
    assert_eq!(label_of(&patch), "1 proposed change");
    assert_eq!(lay_out(&json!([])), bare());
    let decided = one(&json!({"id": "c1", "status": "adopted", "op": "node.patch",
        "nodeId": "a", "patch": {"x": 10}, "assumed": {"x": 0}}));
    assert_eq!(lay_out(&decided), bare());
    let dismissed = one(&json!({"id": "c1", "status": "dismissed", "op": "node.add",
        "node": text("n", 900, 0)}));
    assert_eq!(lay_out(&dismissed), bare());
}

#[test]
fn a_prior_the_anchor_no_longer_holds_needs_a_look() {
    let patch = |field: &str, set: Json, prior: Json| {
        one(&json!({"id": "c", "status": "open", "op": "node.patch", "nodeId": "a",
            "patch": {field: set}, "assumed": {field: prior}}))
    };
    let held = |proposals: &Json| label_of(proposals) == "1 proposed change";
    assert!(held(&patch("x", json!(5), json!(0))));
    assert!(!held(&patch("x", json!(5), json!(1))));
    assert!(held(&patch("text", json!("z"), json!("a"))));
    assert!(!held(&patch("text", json!("z"), json!("b"))));
    assert!(!held(&patch("color", json!("2"), json!("1"))));
    // A prior that leaves a field out says the anchor held nothing there.
    let unset = one(&json!({"id": "c", "status": "open", "op": "node.patch", "nodeId": "a",
        "patch": {"color": "2"}, "assumed": {}}));
    assert!(held(&unset));
    // A node that is gone, and one added under an id already held, both conflict.
    let both = json!([{"id": "p", "changes": [
        {"id": "c", "status": "open", "op": "node.patch", "nodeId": "zz",
            "patch": {"x": 1}, "assumed": {"x": 1}},
        {"id": "d", "status": "open", "op": "node.add", "node": text("a", 0, 0)}]}]);
    assert_eq!(label_of(&both), "2 proposed changes, 2 needs a look");
}

#[test]
fn an_element_prior_is_compared_by_value() {
    let edge = canvas()["edges"][0].clone();
    let mut reordered = edge.clone();
    reordered["facets"] = json!({"x.k/v0": {"q": [1, {"r": 2}], "p": 1}});
    let remove = |assumed: Json| {
        one(&json!({"id": "c", "status": "open", "op": "edge.remove", "edgeId": "e",
            "assumed": assumed}))
    };
    assert_eq!(label_of(&remove(edge.clone())), "1 proposed change");
    assert_eq!(label_of(&remove(reordered)), "1 proposed change");
    let mut moved = edge.clone();
    moved["bends"] = json!([{"x": 200, "y": -41}]);
    assert_eq!(label_of(&remove(moved)), "1 proposed change, 1 needs a look");
    let patch = |assumed: Json| {
        one(&json!({"id": "c", "status": "open", "op": "edge.patch", "edgeId": "e",
            "patch": {"to": {"node": "c"}, "bends": [], "facets": {}}, "assumed": assumed}))
    };
    let same = json!({"to": {"node": "b", "end": "arrow"}, "bends": [{"x": 200, "y": -40}],
        "facets": {"x.k/v0": {"q": [1, {"r": 2}], "p": 1}}});
    assert_eq!(label_of(&patch(same)), "1 proposed change");
    let other = json!({"to": {"node": "b"}, "bends": [{"x": 200, "y": -40}],
        "facets": {"x.k/v0": {"p": 1, "q": [1, {"r": 2}]}}});
    assert_eq!(label_of(&patch(other)), "1 proposed change, 1 needs a look");
    let line = canvas()["lines"][0].clone();
    let line_remove = one(&json!({"id": "c", "status": "open", "op": "line.remove",
        "lineId": "k", "assumed": line}));
    assert_eq!(label_of(&line_remove), "1 proposed change");
    let line_patch = one(&json!({"id": "c", "status": "open", "op": "line.patch",
        "lineId": "k", "patch": {"from": {"kind": "node", "node": "a", "side": "top"},
        "label": "ink", "color": "#ff0000"}, "assumed": {"from": {"kind": "point",
        "point": {"x": -200, "y": 100}}}}));
    assert_eq!(label_of(&line_patch), "1 proposed change");
}

#[test]
fn every_arm_is_outlined_and_a_passage_only_counted() {
    let changes = json!([
        {"id": "n1", "status": "open", "op": "node.add", "node": text("n", 600, 400)},
        {"id": "n2", "status": "open", "op": "node.remove", "nodeId": "b",
            "assumed": text("b", 400, 0)},
        {"id": "e1", "status": "open", "op": "edge.add",
            "edge": {"id": "f", "from": {"node": "a"}, "to": {"node": "c"}}},
        {"id": "l1", "status": "open", "op": "line.add", "line": {"id": "k2",
            "from": {"kind": "point", "point": {"x": 1, "y": 2}},
            "to": {"kind": "node", "node": "a", "end": "arrow"}}},
        {"id": "l2", "status": "open", "op": "line.patch", "lineId": "k",
            "patch": {"label": "x"}, "assumed": {}},
        {"id": "b1", "status": "open", "op": "body.replace"}
    ]);
    let all = json!([{"id": "p", "changes": changes}]);
    let drawn = lay_out(&all);
    for id in ["n1", "n2", "e1", "l1", "l2"] {
        assert!(scene_node(&drawn, &format!("{id}/outline")).is_some(), "{id}: {drawn}");
    }
    assert!(scene_node(&drawn, "b1/outline").is_none());
    assert_eq!(label_of(&all), "6 proposed changes");
}

#[test]
fn a_proposal_that_is_not_one_is_no_request() {
    let malformed = |proposals: Json| {
        let got = lay_out(&proposals);
        assert_eq!(got, json!(["refused", "malformed", "request"]), "{proposals}");
    };
    let change = |extra: &[(&str, Json)]| {
        let mut c = json!({"id": "c", "status": "open", "op": "node.patch", "nodeId": "a",
            "patch": {"x": 1}, "assumed": {}});
        for (k, v) in extra {
            c[*k] = v.clone();
        }
        one(&c)
    };
    malformed(json!({}));
    malformed(json!([{"id": "p"}]));
    malformed(json!([{"id": "p", "changes": [], "author": "x"}]));
    malformed(change(&[("status", json!("closed"))]));
    malformed(change(&[("op", json!("node.move"))]));
    malformed(change(&[("edgeId", json!("e"))]));
    malformed(change(&[("patch", json!({"x": 1, "z": 2}))]));
    malformed(change(&[("patch", json!({"backgroundStyle": "tile"}))]));
    malformed(change(&[("assumed", json!(null))]));
    malformed(one(&json!({"id": "b", "status": "open", "op": "body.replace", "text": "y"})));
    malformed(one(&json!({"id": "c", "status": "open", "op": "edge.patch", "edgeId": "e",
        "patch": {"bends": [{"x": 1}]}, "assumed": {}})));
    malformed(one(&json!({"id": "c", "status": "open", "op": "line.remove", "lineId": "k",
        "assumed": {"id": "k"}})));
    let read = change(&[(
        "patch",
        json!({"x": 1, "y": 2, "width": 3, "height": 4,
        "color": "1", "text": "t", "file": "f", "subpath": "#s", "url": "https://x",
        "label": "l", "background": "b", "backgroundStyle": "ratio"}),
    )]);
    assert_eq!(lay_out(&read).get(0), Some(&json!("ok")));
}

fn patches(proposals: usize, each: usize) -> Json {
    let change = |i: usize| {
        json!({"id": format!("c{i}"), "status": "dismissed", "op": "node.patch",
            "nodeId": "a", "patch": {"x": 1}, "assumed": {}})
    };
    let proposal = |p: usize| {
        json!({"id": format!("p{p}"), "changes":
        (0..each).map(|i| change(p * each + i)).collect::<Vec<_>>()})
    };
    Json::Array((0..proposals).map(proposal).collect())
}

fn facet_prior(entries: usize) -> Json {
    let bucket: serde_json::Map<String, Json> =
        (0..entries).map(|i| (format!("k{i}"), json!({"v": i}))).collect();
    let mut edge = canvas()["edges"][0].clone();
    edge["facets"] = json!({"x.k/v0": bucket});
    one(&json!({"id": "c", "status": "open", "op": "edge.remove", "edgeId": "e",
        "assumed": edge}))
}

#[test]
fn a_proposal_layer_past_its_caps_is_refused() {
    let past = json!(["refused", "input-too-large", "proposals"]);
    assert_eq!(lay_out(&patches(MAX_PROPOSALS, 2)).get(0), Some(&json!("ok")));
    assert_eq!(lay_out(&patches(MAX_PROPOSALS + 1, 0)), past);
    assert_eq!(lay_out(&patches(1, MAX_PROPOSAL_CHANGES)).get(0), Some(&json!("ok")));
    assert_eq!(lay_out(&patches(2, MAX_PROPOSAL_CHANGES / 2 + 1)), past);
    // The bucket's own key counts, and each of its entries with the one it holds.
    let at = MAX_PRIOR_FACET_ENTRIES / 2 - 1;
    assert_eq!(lay_out(&facet_prior(at)).get(0), Some(&json!("ok")));
    assert_eq!(lay_out(&facet_prior(at + 1)), past);
}

/// Facets holding `n` entries besides their bucket's own key and its list's:
/// one mapping per list item, so the entries inside a list are counted too.
fn listed_facets(n: usize) -> Json {
    let items: Vec<Json> = (0..n).map(|i| json!({format!("k{i}"): i})).collect();
    json!({"x.k/v0": {"s": items}})
}

/// A change of one arm, its prior carrying the facets it is handed.
type Arm = fn(Json) -> Json;

#[test]
fn every_prior_s_facets_count_toward_the_cap() {
    let arms: [(&str, Arm); 5] = [
        ("node.remove", |f| {
            json!({"op": "node.remove", "nodeId": "a",
            "assumed": {"id": "a", "x": 0, "y": 0, "width": 140, "height": 70, "facets": f}})
        }),
        ("edge.remove", |f| {
            json!({"op": "edge.remove", "edgeId": "e",
            "assumed": {"id": "e", "from": {"node": "a"}, "to": {"node": "b"}, "facets": f}})
        }),
        ("line.remove", |f| {
            json!({"op": "line.remove", "lineId": "k",
            "assumed": {"id": "k", "from": {"kind": "node", "node": "a"},
                "to": {"kind": "node", "node": "c"}, "facets": f}})
        }),
        ("edge.patch", |f| {
            json!({"op": "edge.patch", "edgeId": "e",
            "patch": {"facets": {}}, "assumed": {"facets": f}})
        }),
        ("line.patch", |f| {
            json!({"op": "line.patch", "lineId": "k",
            "patch": {"facets": {}}, "assumed": {"facets": f}})
        }),
    ];
    let past = json!(["refused", "input-too-large", "proposals"]);
    for (name, arm) in arms {
        let change = |n: usize| {
            let mut change = arm(listed_facets(n));
            change["id"] = json!("c");
            change["status"] = json!("open");
            one(&change)
        };
        let at = lay_out(&change(MAX_PRIOR_FACET_ENTRIES - 2));
        assert_eq!(at.get(0), Some(&json!("ok")), "{name}");
        assert_eq!(lay_out(&change(MAX_PRIOR_FACET_ENTRIES - 1)), past, "{name}");
    }
}
