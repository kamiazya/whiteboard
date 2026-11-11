//! The one place a [`VNode`] tree becomes serialized SVG text. Everything
//! byte-visible is decided here: attribute order (insertion order), number
//! formatting, escaping, self-closing.

use super::format::{NonFinite, format_coord};
use super::vnode::{AttrValue, Child, VNode};
use crate::xml_escape::{escape_xml_attr, escape_xml_text};

/// The ASCII subset of the XML `Name` production. Attribute names are written
/// raw, only values being escaped, and some arrive from data rather than code
/// (an icon set's paint keys), so a name outside this subset could open a
/// second attribute or close the tag. Such a name is DROPPED rather than
/// refused: the renderer is total, and one bad key in a contributed table must
/// not refuse the whole render.
fn is_xml_attr_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == ':')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// The opening tag of `node`, self-closed when asked.
pub(super) fn open_tag(node: &VNode, self_close: bool) -> Result<String, NonFinite> {
    let mut out = format!("<{}", node.tag);
    for (name, value) in node.attrs.iter().filter(|(name, _)| is_xml_attr_name(name)) {
        let text = match value {
            AttrValue::Num(n) => format_coord(*n)?,
            AttrValue::Str(s) => escape_xml_attr(s),
        };
        for piece in [" ", name, "=\"", &text, "\""] {
            out.push_str(piece);
        }
    }
    out.push_str(if self_close { "/>" } else { ">" });
    Ok(out)
}

fn write_child(out: &mut String, child: &Child) -> Result<(), NonFinite> {
    match child {
        Child::Text(text) => out.push_str(&escape_xml_text(text)),
        Child::Raw(raw) => out.push_str(raw),
        Child::List(children) => {
            for inner in children {
                write_child(out, inner)?;
            }
        }
        Child::Node(node) => write_node(out, node)?,
    }
    Ok(())
}

fn write_node(out: &mut String, node: &VNode) -> Result<(), NonFinite> {
    let Some(children) = &node.children else {
        out.push_str(&open_tag(node, true)?);
        return Ok(());
    };
    out.push_str(&open_tag(node, false)?);
    for child in children {
        write_child(out, child)?;
    }
    for piece in ["</", node.tag, ">"] {
        out.push_str(piece);
    }
    Ok(())
}

/// Serializes any child form (element, text, raw markup, nested lists) to its
/// exact document bytes: the keyed renderer's per-part serializer.
pub(super) fn serialize_child(child: &Child) -> Result<String, NonFinite> {
    let mut out = String::new();
    write_child(&mut out, child)?;
    Ok(out)
}

pub(super) fn serialize_svg(node: &VNode) -> Result<String, NonFinite> {
    let mut out = String::new();
    write_node(&mut out, node)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{open_tag, serialize_child, serialize_svg};
    use crate::svg::format::NonFinite;
    use crate::svg::vnode::{Attrs, Child, VNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn an_element_without_children_self_closes_and_one_with_an_empty_list_is_paired() {
        let leaf = VNode::leaf("g", Attrs::new());
        assert_eq!(serialize_svg(&leaf), Ok("<g/>".to_string()));
        let paired = VNode::el("g", Attrs::new(), Vec::new());
        assert_eq!(serialize_svg(&paired), Ok("<g></g>".to_string()));
    }

    #[test]
    fn attributes_keep_their_order_numbers_are_canonical_and_strings_are_escaped() {
        let attrs = Attrs::new().str("b", "x\"y<z>&'").num("a", 1.5).num("c", 2.0).str("d", "");
        let node = VNode::leaf("rect", attrs);
        assert_eq!(
            serialize_svg(&node),
            Ok("<rect b=\"x&quot;y&lt;z&gt;&amp;&apos;\" a=\"1.5\" c=\"2\" d=\"\"/>".to_string())
        );
    }

    #[test]
    fn a_name_outside_the_xml_name_subset_is_dropped_not_written() {
        let bad = ["", "1a", "-a", ".a", "a b", "a\"b", "a=b", "a>b", "a/b", "é", "a\nb"];
        for name in bad {
            let node = VNode::leaf("g", Attrs::new().str(name, "v").str("ok", "v"));
            assert_eq!(serialize_svg(&node), Ok("<g ok=\"v\"/>".to_string()), "{name:?}");
        }
        for name in ["a", "_a", ":a", "xml:space", "a.b", "a-b", "a_b", "A1", "a:b-c.d_e9"] {
            let node = VNode::leaf("g", Attrs::new().str(name, "v"));
            assert_eq!(serialize_svg(&node), Ok(format!("<g {name}=\"v\"/>")), "{name:?}");
        }
    }

    #[test]
    fn text_is_escaped_raw_markup_is_not_and_nested_lists_flatten_in_order() {
        let child = Child::List(vec![
            Child::Text("a<b".into()),
            Child::List(vec![Child::Raw("<i/>".into()), Child::Text("&".into())]),
            Child::none(),
        ]);
        assert_eq!(serialize_child(&child), Ok("a&lt;b<i/>&amp;".to_string()));
        let node = VNode::el("text", Attrs::new(), vec![child]);
        assert_eq!(serialize_svg(&node), Ok("<text>a&lt;b<i/>&amp;</text>".to_string()));
    }

    #[test]
    fn a_non_finite_number_refuses_the_whole_serialisation() {
        let node = VNode::el(
            "g",
            Attrs::new(),
            vec![VNode::leaf("rect", Attrs::new().num("x", f64::NAN)).into()],
        );
        assert!(matches!(serialize_svg(&node), Err(NonFinite(_))));
        assert!(matches!(serialize_child(&Child::Node(node.clone())), Err(NonFinite(_))));
        assert!(open_tag(&node, false).is_ok());
        let bad = VNode::leaf("rect", Attrs::new().num("x", f64::INFINITY));
        assert!(matches!(open_tag(&bad, true), Err(NonFinite(_))));
    }

    #[test]
    fn the_open_tag_is_closed_or_self_closed_as_asked() {
        let node = VNode::leaf("svg", Attrs::new().str("xmlns", "u"));
        assert_eq!(open_tag(&node, false), Ok("<svg xmlns=\"u\">".to_string()));
        assert_eq!(open_tag(&node, true), Ok("<svg xmlns=\"u\"/>".to_string()));
    }
}
