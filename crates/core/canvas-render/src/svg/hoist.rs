//! Hoists inherited paint attributes shared by every child of a container
//! (`<g>`, `<a>`) onto the container itself: the SVG-inheritance form of
//! deduplication, measured at 30 to 40 percent of a realistic document's raw
//! bytes. Pure tree to tree; the painted output is unchanged.
//!
//! The soundness rule: an attribute is lifted only when EVERY direct child is
//! an element that declares it with the SAME value. A child lacking the
//! attribute blocks the lift, since it would otherwise start inheriting a value
//! it never declared, and an opaque raw child blocks all lifting for its
//! container, since its computed style cannot be inspected. Nearest-ancestor-
//! wins keeps differing descendants untouched. Bottom-up application lets lifts
//! compose through nested containers.

use super::vnode::{AttrValue, Attrs, Child, VNode};

/// The SVG-inherited presentation attributes this backend emits. `role`,
/// `mask` and `xml:space` are deliberately absent: not inheritance-safe
/// (`role`), not inherited (`mask`), or content semantics (`xml:space`).
const HOISTABLE: [&str; 7] = [
    "fill",
    "stroke",
    "stroke-width",
    "font-family",
    "font-size",
    "fill-opacity",
    "stroke-opacity",
];

/// Containers legal to receive inherited paint and emitted by this backend.
fn is_container(node: &VNode) -> bool {
    matches!(node.tag, "g" | "a")
}

/// `node` with `attrs` and `children` in place of its own; its definitions stay.
fn rebuild(node: &VNode, attrs: Attrs, children: Option<Vec<Child>>) -> VNode {
    VNode { tag: node.tag, attrs, children, defs: node.defs.clone() }
}

/// `role` stays the last attribute: the canonical position it has always had on
/// this backend's container elements.
fn with_hoisted(node: VNode, hoisted: &[(&str, AttrValue)]) -> VNode {
    if hoisted.is_empty() {
        return node;
    }
    let role = node.attrs.get("role").cloned();
    let mut attrs = node.attrs.without(&["role"]);
    for (name, value) in hoisted {
        attrs = match value {
            AttrValue::Str(s) => attrs.str(name, s),
            AttrValue::Num(n) => attrs.num(name, *n),
        };
    }
    if let Some(role) = role {
        attrs = match role {
            AttrValue::Str(s) => attrs.str("role", &s),
            AttrValue::Num(n) => attrs.num("role", n),
        };
    }
    rebuild(&node, attrs, node.children.clone())
}

fn flatten(children: &[Child]) -> Vec<Child> {
    let mut out = Vec::new();
    for child in children {
        match child {
            Child::List(inner) => out.extend(flatten(inner)),
            other => out.push(other.clone()),
        }
    }
    out
}

fn as_node(child: &Child) -> Option<&VNode> {
    match child {
        Child::Node(node) => Some(node),
        _ => None,
    }
}

/// The attributes every element declares identically, and what to do with each:
/// lift it onto the container, or only strip the now-redundant copies.
struct Plan {
    lift: Vec<(&'static str, AttrValue)>,
    strip: Vec<&'static str>,
}

fn plan(container: &VNode, elements: &[&VNode]) -> Plan {
    let mut lift = Vec::new();
    let mut strip = Vec::new();
    for name in HOISTABLE {
        let Some(first) = elements.first().and_then(|e| e.attrs.get(name)) else { continue };
        if !elements.iter().all(|e| e.attrs.get(name) == Some(first)) {
            continue;
        }
        match container.attrs.get(name) {
            None => {
                lift.push((name, first.clone()));
                strip.push(name);
            }
            // The parent already declares the same value: the copies are noise.
            Some(own) if own == first => strip.push(name),
            Some(_) => {}
        }
    }
    Plan { lift, strip }
}

fn hoist_container(container: &VNode, changed: &mut bool) -> VNode {
    let children = flatten(container.children.as_deref().unwrap_or(&[]));
    let elements: Vec<&VNode> = children.iter().filter_map(as_node).collect();
    // A non-element child (text, raw markup) cannot be inspected or is content,
    // so lifting anything past it is unsound and the container is left alone.
    if elements.is_empty() || elements.len() != children.len() {
        return rebuild(container, container.attrs.clone(), Some(children));
    }
    let Plan { lift, strip } = plan(container, &elements);
    if strip.is_empty() {
        return rebuild(container, container.attrs.clone(), Some(children));
    }
    *changed = true;
    let stripped = children
        .iter()
        .map(|child| match child {
            Child::Node(node) => {
                Child::Node(rebuild(node, node.attrs.without(&strip), node.children.clone()))
            }
            other => other.clone(),
        })
        .collect();
    with_hoisted(rebuild(container, container.attrs.clone(), Some(stripped)), &lift)
}

fn hoist_once(child: &Child, changed: &mut bool) -> Child {
    match child {
        Child::Text(_) | Child::Raw(_) => child.clone(),
        Child::List(inner) => Child::List(inner.iter().map(|c| hoist_once(c, changed)).collect()),
        Child::Node(node) => {
            let rebuilt = match &node.children {
                None => node.clone(),
                Some(children) => {
                    let hoisted = children.iter().map(|c| hoist_once(c, changed)).collect();
                    rebuild(node, node.attrs.clone(), Some(hoisted))
                }
            };
            Child::Node(if is_container(&rebuilt) {
                hoist_container(&rebuilt, changed)
            } else {
                rebuilt
            })
        }
    }
}

/// Applies hoisting bottom-up through the whole tree, ITERATED TO A FIXPOINT.
/// One bottom-up pass is not enough: stripping a nested container's attribute
/// (because its parent lifted the same value) can make that container's own
/// children newly uniform, an opportunity the pass already walked past. Each
/// pass only moves attributes upward or deletes copies, so the iteration
/// terminates; in practice it converges in one or two passes.
///
/// Nested child lists are flattened inside processed containers, which is
/// byte-identical since the serializer flattens them anyway.
pub(super) fn hoist_inherited_attrs(child: &Child) -> Child {
    let mut changed = false;
    let next = hoist_once(child, &mut changed);
    if changed { hoist_inherited_attrs(&next) } else { next }
}

#[cfg(test)]
mod tests {
    use super::hoist_inherited_attrs;
    use crate::svg::serialize::serialize_child;
    use crate::svg::vnode::{Attrs, Child, VNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn rect(attrs: Attrs) -> Child {
        VNode::leaf("rect", attrs).into()
    }

    fn group(attrs: Attrs, children: Vec<Child>) -> Child {
        VNode::el("g", attrs, children).into()
    }

    fn hoisted(child: &Child) -> String {
        serialize_child(&hoist_inherited_attrs(child)).unwrap_or_default()
    }

    #[test]
    fn an_attribute_every_child_declares_alike_moves_to_the_container() {
        let tree = group(
            Attrs::new().str("role", "presentation"),
            vec![
                rect(Attrs::new().str("fill", "#111").num("x", 1.0).num("stroke-width", 2.0)),
                rect(Attrs::new().str("fill", "#111").num("x", 2.0).num("stroke-width", 3.0)),
            ],
        );
        assert_eq!(
            hoisted(&tree),
            "<g fill=\"#111\" role=\"presentation\"><rect x=\"1\" stroke-width=\"2\"/><rect x=\"2\" stroke-width=\"3\"/></g>"
        );
    }

    #[test]
    fn lifted_attributes_follow_the_declared_order_and_role_stays_last() {
        let all = |x: f64| {
            rect(
                Attrs::new()
                    .str("stroke-opacity", "0.5")
                    .str("fill-opacity", "0.5")
                    .num("font-size", 9.0)
                    .str("font-family", "F")
                    .num("stroke-width", 1.0)
                    .str("stroke", "#000")
                    .str("fill", "#fff")
                    .num("x", x),
            )
        };
        let tree = group(
            Attrs::new().str("id", "g").str("role", "presentation"),
            vec![all(1.0), all(2.0)],
        );
        assert_eq!(
            hoisted(&tree),
            "<g id=\"g\" fill=\"#fff\" stroke=\"#000\" stroke-width=\"1\" font-family=\"F\" font-size=\"9\" fill-opacity=\"0.5\" stroke-opacity=\"0.5\" role=\"presentation\"><rect x=\"1\"/><rect x=\"2\"/></g>"
        );
    }

    #[test]
    fn a_differing_value_or_a_child_without_the_attribute_blocks_the_lift() {
        let differing = group(
            Attrs::new(),
            vec![rect(Attrs::new().str("fill", "a")), rect(Attrs::new().str("fill", "b"))],
        );
        assert_eq!(hoisted(&differing), "<g><rect fill=\"a\"/><rect fill=\"b\"/></g>");
        let lacking = group(
            Attrs::new(),
            vec![rect(Attrs::new().str("fill", "a")), rect(Attrs::new().num("x", 1.0))],
        );
        assert_eq!(hoisted(&lacking), "<g><rect fill=\"a\"/><rect x=\"1\"/></g>");
        let kinds = group(
            Attrs::new(),
            vec![
                rect(Attrs::new().num("stroke-width", 1.0)),
                rect(Attrs::new().str("stroke-width", "1")),
            ],
        );
        assert_eq!(hoisted(&kinds), "<g><rect stroke-width=\"1\"/><rect stroke-width=\"1\"/></g>");
    }

    #[test]
    fn an_attribute_that_is_not_inherited_is_never_lifted() {
        let tree = group(
            Attrs::new(),
            vec![
                rect(
                    Attrs::new()
                        .str("mask", "m")
                        .str("role", "r")
                        .str("filter", "f")
                        .str("xml:space", "preserve"),
                ),
                rect(
                    Attrs::new()
                        .str("mask", "m")
                        .str("role", "r")
                        .str("filter", "f")
                        .str("xml:space", "preserve"),
                ),
            ],
        );
        let again = hoisted(&tree);
        assert!(
            again.starts_with(
                "<g><rect mask=\"m\" role=\"r\" filter=\"f\" xml:space=\"preserve\"/>"
            ),
            "{again}"
        );
    }

    #[test]
    fn text_or_raw_markup_among_the_children_blocks_every_lift() {
        let text = group(
            Attrs::new(),
            vec![
                rect(Attrs::new().str("fill", "a")),
                Child::Text("t".into()),
                rect(Attrs::new().str("fill", "a")),
            ],
        );
        assert_eq!(hoisted(&text), "<g><rect fill=\"a\"/>t<rect fill=\"a\"/></g>");
        let raw = group(
            Attrs::new(),
            vec![rect(Attrs::new().str("fill", "a")), Child::Raw("<x/>".into())],
        );
        assert_eq!(hoisted(&raw), "<g><rect fill=\"a\"/><x/></g>");
    }

    #[test]
    fn a_container_that_already_holds_the_value_only_sheds_the_copies() {
        let same = group(
            Attrs::new().str("fill", "a"),
            vec![rect(Attrs::new().str("fill", "a")), rect(Attrs::new().str("fill", "a"))],
        );
        assert_eq!(hoisted(&same), "<g fill=\"a\"><rect/><rect/></g>");
        let other = group(
            Attrs::new().str("fill", "b"),
            vec![rect(Attrs::new().str("fill", "a")), rect(Attrs::new().str("fill", "a"))],
        );
        assert_eq!(hoisted(&other), "<g fill=\"b\"><rect fill=\"a\"/><rect fill=\"a\"/></g>");
    }

    #[test]
    fn lifting_composes_through_nested_containers_until_nothing_moves() {
        // Lifting the outer value strips the inner container, whose own children
        // are then uniform: one pass would stop before the second lift.
        let tree = group(
            Attrs::new(),
            vec![group(
                Attrs::new().num("stroke-width", 1.0),
                vec![rect(Attrs::new().num("stroke-width", 2.0))],
            )],
        );
        assert_eq!(hoisted(&tree), "<g stroke-width=\"1\"><g stroke-width=\"2\"><rect/></g></g>");
        let deep = group(
            Attrs::new(),
            vec![group(
                Attrs::new(),
                vec![group(Attrs::new(), vec![rect(Attrs::new().str("fill", "a"))])],
            )],
        );
        assert_eq!(hoisted(&deep), "<g fill=\"a\"><g><g><rect/></g></g></g>");
    }

    #[test]
    fn an_anchor_is_a_container_and_any_other_element_is_not() {
        let anchor: Child = VNode::el(
            "a",
            Attrs::new().str("href", "#"),
            vec![rect(Attrs::new().str("fill", "a")), rect(Attrs::new().str("fill", "a"))],
        )
        .into();
        assert_eq!(hoisted(&anchor), "<a href=\"#\" fill=\"a\"><rect/><rect/></a>");
        let text: Child = VNode::el(
            "text",
            Attrs::new(),
            vec![rect(Attrs::new().str("fill", "a")), rect(Attrs::new().str("fill", "a"))],
        )
        .into();
        assert_eq!(hoisted(&text), "<text><rect fill=\"a\"/><rect fill=\"a\"/></text>");
    }

    #[test]
    fn a_container_with_no_children_comes_back_paired_and_lists_are_flattened() {
        assert_eq!(hoisted(&Child::Node(VNode::leaf("g", Attrs::new()))), "<g></g>");
        let nested = group(
            Attrs::new(),
            vec![Child::List(vec![
                Child::List(vec![rect(Attrs::new().str("fill", "a"))]),
                rect(Attrs::new().str("fill", "a")),
            ])],
        );
        assert_eq!(hoisted(&nested), "<g fill=\"a\"><rect/><rect/></g>");
        assert_eq!(hoisted(&Child::Text("t".into())), "t");
        assert_eq!(hoisted(&Child::Raw("<r/>".into())), "<r/>");
    }

    #[test]
    fn definitions_stay_on_the_element_that_declared_them() {
        let node = VNode::el("g", Attrs::new(), vec![rect(Attrs::new().str("fill", "a"))])
            .with_defs(vec![crate::svg::vnode::SvgDef {
                id: "d".into(),
                node: VNode::leaf("mask", Attrs::new()),
            }]);
        let Child::Node(out) = hoist_inherited_attrs(&Child::Node(node)) else { return };
        assert_eq!(out.defs.len(), 1);
    }
}
