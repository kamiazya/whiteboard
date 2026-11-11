//! Hoists the `defs` declarations scattered through a tree into one ordered,
//! id-deduplicated list: the document assembly wraps the result in a single
//! `<defs>` element as the root's first child, or emits nothing when the list
//! is empty. First occurrence wins on an id collision, which is sound because
//! ids are content-derived by contract: two declarations sharing an id say the
//! same thing in the same bytes.

use super::vnode::{Child, SvgDef, VNode};

/// The definitions collected so far, in emission order, and the ids among them.
#[derive(Default)]
struct Hoisted {
    seen: Vec<String>,
    collected: Vec<SvgDef>,
}

/// The elements a child holds at its top level: itself, or those in its nested lists.
fn visit(child: &Child, into: &mut Hoisted) {
    match child {
        Child::List(inner) => inner.iter().for_each(|c| visit(c, into)),
        Child::Node(node) => visit_node(node, into),
        Child::Text(_) | Child::Raw(_) => {}
    }
}

fn visit_node(node: &VNode, into: &mut Hoisted) {
    for def in &node.defs {
        hoist(def, into);
    }
    for inner in node.children.iter().flatten() {
        visit(inner, into);
    }
}

fn hoist(def: &SvgDef, into: &mut Hoisted) {
    if into.seen.contains(&def.id) {
        return;
    }
    into.seen.push(def.id.clone());
    // A definition's own node may declare the definitions IT depends on (a
    // mask carrying its gradient). Visit it before pushing so a dependency is
    // emitted ahead of its dependent; `seen` is marked first, so mutually
    // dependent definitions terminate.
    visit_node(&def.node, into);
    into.collected.push(def.clone());
}

pub(super) fn collect_defs(children: &[Child]) -> Vec<SvgDef> {
    let mut into = Hoisted::default();
    for child in children {
        visit(child, &mut into);
    }
    into.collected
}

#[cfg(test)]
mod tests {
    use super::collect_defs;
    use crate::svg::vnode::{Attrs, Child, SvgDef, VNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn def(id: &str, tag: &'static str) -> SvgDef {
        SvgDef { id: id.into(), node: VNode::leaf(tag, Attrs::new().str("id", id)) }
    }

    fn with(defs: Vec<SvgDef>, children: Vec<Child>) -> Child {
        VNode::el("g", Attrs::new(), children).with_defs(defs).into()
    }

    fn ids(children: &[Child]) -> Vec<String> {
        collect_defs(children).into_iter().map(|d| d.id).collect()
    }

    #[test]
    fn definitions_come_out_in_document_order_once_each_first_occurrence_winning() {
        let tree = with(
            vec![def("a", "mask"), def("b", "filter")],
            vec![with(vec![def("a", "filter"), def("c", "mask")], vec![])],
        );
        let all = collect_defs(&[tree]);
        let found: Vec<(&str, &str)> = all.iter().map(|d| (d.id.as_str(), d.node.tag)).collect();
        assert_eq!(found, [("a", "mask"), ("b", "filter"), ("c", "mask")]);
    }

    #[test]
    fn a_definition_that_depends_on_another_follows_it() {
        let mask = SvgDef {
            id: "mask".into(),
            node: VNode::leaf("mask", Attrs::new())
                .with_defs(vec![def("gradient", "linearGradient")]),
        };
        assert_eq!(ids(&[with(vec![mask], vec![])]), ["gradient", "mask"]);
    }

    #[test]
    fn mutually_dependent_definitions_terminate() {
        let a = SvgDef {
            id: "a".into(),
            node: VNode::leaf("mask", Attrs::new()).with_defs(vec![SvgDef {
                id: "b".into(),
                node: VNode::leaf("mask", Attrs::new()).with_defs(vec![def("a", "mask")]),
            }]),
        };
        assert_eq!(ids(&[with(vec![a], vec![])]), ["b", "a"]);
    }

    #[test]
    fn nested_lists_and_children_are_searched_and_text_and_raw_hold_nothing() {
        let deep = Child::List(vec![
            Child::Text("t".into()),
            Child::Raw("<r/>".into()),
            Child::List(vec![with(vec![def("x", "mask")], vec![])]),
            with(vec![], vec![with(vec![def("y", "mask")], vec![])]),
        ]);
        assert_eq!(ids(&[deep]), ["x", "y"]);
        assert!(ids(&[Child::none(), Child::Text("t".into())]).is_empty());
        assert!(ids(&[]).is_empty());
    }

    #[test]
    fn an_element_s_own_definitions_come_before_its_children_s() {
        let tree = with(vec![def("outer", "mask")], vec![with(vec![def("inner", "mask")], vec![])]);
        assert_eq!(ids(&[tree]), ["outer", "inner"]);
    }
}
