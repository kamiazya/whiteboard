//! `resolveEmbed` over the wire: a body as its parsed root, a canvas narrowed
//! to the part its fragment names.

use std::borrow::Cow;

use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::SpatialCanvas;

use super::WireHost;
use crate::canvas_fragment::select_canvas_fragment;
use crate::typeset::{CanvasSummary, EmbedResolver, Embedded};

fn element_count(canvas: &SpatialCanvas) -> usize {
    let lines = canvas.lines.as_ref().map_or(0, Vec::len);
    canvas.nodes.len().saturating_add(canvas.edges.len()).saturating_add(lines)
}

/// `whole` narrowed to the part `fragment` names; `None` when it names
/// nothing, which is unresolvable the way a missing document is.
fn narrowed<'c>(
    whole: &'c SpatialCanvas,
    fragment: Option<&str>,
) -> Option<Cow<'c, SpatialCanvas>> {
    match fragment {
        None => Some(Cow::Borrowed(whole)),
        Some(fragment) => select_canvas_fragment(whole, fragment).map(Cow::Owned),
    }
}

impl<'w> WireHost<'w> {
    /// `resolveEmbed`: a body as its parsed root, else a canvas; with the
    /// record's name, else the title table's.
    pub(super) fn embedded(
        &self,
        id: &str,
    ) -> Option<(Option<String>, Result<Root, &'w SpatialCanvas>)> {
        let entry = self.by_id(id)?;
        let title = entry.name.clone().or_else(|| self.title(id));
        let content = match &entry.body {
            Some(body) => Ok(self.root_of(body)),
            None => Err(entry.canvas.as_ref()?),
        };
        Some((title, content))
    }

    /// The canvas an embed of `id` draws, narrowed to `fragment`.
    pub(super) fn canvas_part(&self, id: &str, fragment: Option<&str>) -> Option<SpatialCanvas> {
        narrowed(self.embedded(id)?.1.err()?, fragment).map(Cow::into_owned)
    }
}

impl EmbedResolver for WireHost<'_> {
    fn resolve_embed(&self, document_id: &str, fragment: Option<&str>) -> Option<Embedded> {
        let (title, content) = self.embedded(document_id)?;
        let whole = match content {
            Ok(root) => return Some(Embedded::Document { title, root }),
            Err(whole) => whole,
        };
        let summary = Some(whole).and_then(|whole| narrowed(whole, fragment)).map(|part| {
            let elements = element_count(&part);
            CanvasSummary { elements, empty: elements == 0 }
        });
        Some(Embedded::Canvas { title, canvas: summary })
    }
}
