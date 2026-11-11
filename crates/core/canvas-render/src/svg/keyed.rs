//! The keyed projection of the SVG document: the same bytes
//! [`render_scene_to_svg`](super::render_scene_to_svg) emits, cut at the seams a
//! DOM patch layer needs. Every top-level scene entry becomes one
//! `<g data-wb-key="...">` group; the document-chrome pieces that live outside
//! any entry (`<defs>` and the background rect) become the pseudo-groups
//! `#defs` and `#background`. A consumer mounts `svg` once, then on the next
//! render compares each group's string against what it holds and replaces only
//! the ones that differ: string equality IS change detection, because the
//! serializer is canonical and deterministic.
//!
//! The wrappers are an EDITOR-MODE projection: exports and the render tool keep
//! calling `render_scene_to_svg`, whose bytes carry no keys. The legend is not
//! a group: the editor draws it as its own overlay.

use super::backend::{SvgDocumentOptions, build_document_parts};
use super::format::{NonFinite, format_coord};
use super::serialize::{open_tag, serialize_child, serialize_svg};
use super::vnode::{AttrValue, Attrs, Child, VNode};
use crate::scene_entries::scene_entries;
use whiteboard_scene::Scene;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyedSvgGroup {
    pub key: String,
    /// The group's exact document bytes: `<g data-wb-key="KEY">...</g>` for a
    /// scene entry, the bare element for a pseudo-group.
    pub svg: String,
    /// This group draws the ANNOTATION LAYER rather than the document: a
    /// conversation's pin, count, leader or bubble. Out-of-band on purpose: it
    /// never reaches `svg`, so the projection's bytes stay the plain
    /// renderer's, which is what the consumer's safety argument rests on.
    pub annotation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyedSvgRender {
    /// The full document: identical bytes to mounting the groups yourself.
    pub svg: String,
    /// The root `<svg ...>` open tag, exactly as it appears in `svg`.
    pub root_open: String,
    /// Root attributes as raw (unescaped) strings, for `setAttribute` when a
    /// patch keeps the mounted root element and only its attributes moved.
    pub root_attrs: Vec<(String, String)>,
    pub groups: Vec<KeyedSvgGroup>,
}

fn is_empty_child(child: &Child) -> bool {
    matches!(child, Child::List(items) if items.is_empty())
}

fn root_attr_pairs(attrs: &Attrs) -> Result<Vec<(String, String)>, NonFinite> {
    attrs
        .iter()
        .map(|(name, value)| {
            let text = match value {
                AttrValue::Num(n) => format_coord(*n)?,
                AttrValue::Str(s) => s.clone(),
            };
            Ok((name.to_string(), text))
        })
        .collect()
}

pub fn render_scene_to_keyed_svg(
    scene: &Scene,
    options: Option<&SvgDocumentOptions>,
) -> Result<KeyedSvgRender, NonFinite> {
    let parts = build_document_parts(scene, options)?;
    let mut groups = Vec::new();
    if !is_empty_child(&parts.defs) {
        groups.push(KeyedSvgGroup {
            key: "#defs".to_string(),
            svg: serialize_child(&parts.defs)?,
            annotation: false,
        });
    }
    if !is_empty_child(&parts.background) {
        groups.push(KeyedSvgGroup {
            key: "#background".to_string(),
            svg: serialize_child(&parts.background)?,
            annotation: false,
        });
    }
    for (child, entry) in parts.body.into_iter().zip(scene_entries(scene)) {
        let wrapper = VNode::el("g", Attrs::new().str("data-wb-key", &entry.key), vec![child]);
        groups.push(KeyedSvgGroup {
            key: entry.key,
            svg: serialize_svg(&wrapper)?,
            annotation: entry.annotation,
        });
    }
    let root_open = open_tag(&VNode::el("svg", parts.root_attrs.clone(), Vec::new()), false)?;
    let body: String = groups.iter().map(|group| group.svg.as_str()).collect();
    Ok(KeyedSvgRender {
        svg: format!("{root_open}{body}</svg>"),
        root_attrs: root_attr_pairs(&parts.root_attrs)?,
        root_open,
        groups,
    })
}
