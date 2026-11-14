//! `resolveEmbed` over the wire: a body as its parsed root, a canvas whole,
//! and the fragment decline.

use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::SpatialCanvas;

use super::{Refused, WireHost};
use crate::typeset::{CanvasSummary, EmbedResolver, Embedded};

fn element_count(canvas: &SpatialCanvas) -> usize {
    let lines = canvas.lines.as_ref().map_or(0, Vec::len);
    canvas.nodes.len().saturating_add(canvas.edges.len()).saturating_add(lines)
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
            Some(body) => Ok(self.root_of(body)?),
            None => Err(entry.canvas.as_ref()?),
        };
        Some((title, content))
    }

    /// The canvas a fragment-free embed of `id` names; a fragment narrows it,
    /// which the core does not, so the layout is refused.
    pub(super) fn whole_canvas(
        &self,
        id: &str,
        fragment: Option<&str>,
    ) -> Option<&'w SpatialCanvas> {
        if fragment.is_some() {
            self.refuse(Refused::Fragment);
            return None;
        }
        self.embedded(id)?.1.err()
    }
}

impl EmbedResolver for WireHost<'_> {
    fn resolve_embed(&self, document_id: &str, fragment: Option<&str>) -> Option<Embedded> {
        let (title, content) = self.embedded(document_id)?;
        if let Ok(root) = content {
            return Some(Embedded::Document { title, root });
        }
        let canvas = self.whole_canvas(document_id, fragment)?;
        let elements = element_count(canvas);
        let summary = CanvasSummary { elements, empty: elements == 0 };
        Some(Embedded::Canvas { title, canvas: Some(summary) })
    }
}
