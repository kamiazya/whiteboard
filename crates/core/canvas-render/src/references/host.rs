//! The composer's host over a [`ReferenceWire`]: `referenceSeamsFromWire`'s
//! seams, answered in the core.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use whiteboard_codec::markdown::parse_markdown_body;
use whiteboard_codec::references::resolve_references;
use whiteboard_det::utf16::is_js_whitespace;
use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};

use super::{LoadedReference, ReferenceWire, Refused};
use crate::compose_node::{ComposeHost, Degradation, ParseFailed};
use crate::node_box::{ReferenceImage, ResolvedReference};
use crate::typeset::{
    CanvasSummary, CodeTokenLines, CodeTokenizer, EmbedResolver, Embedded, IconRange, ImageRef,
    InlineSeams,
};

/// The seams over one wire, and what one layout through them reported.
pub struct WireHost<'w> {
    wire: &'w ReferenceWire,
    /// The wire's own alias table over the graph's ids: a written target to
    /// the id it names (`resolveAlias`).
    aliases: BTreeMap<String, String>,
    /// Whether a file node's resolved canvas is drawn open.
    expand: bool,
    refused: Cell<Option<Refused>>,
    degradations: RefCell<Vec<Degradation>>,
}

/// JavaScript's `trim()` would leave nothing: every unit is a white space or a
/// line terminator, which is what `\s` matches.
fn is_blank(text: &str) -> bool {
    text.chars().all(|c| u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace))
}

/// A name between two colons, which only the plugin's tables can read.
fn may_hold_shortcode(text: &str) -> bool {
    text.matches(':').nth(1).is_some()
}

fn element_count(canvas: &SpatialCanvas) -> usize {
    let lines = canvas.lines.as_ref().map_or(0, Vec::len);
    canvas.nodes.len().saturating_add(canvas.edges.len()).saturating_add(lines)
}

impl<'w> WireHost<'w> {
    /// The host over `wire`, drawing every resolved canvas of a file node open
    /// when `expand` says so (the caller's policy, settled ahead as one answer).
    #[must_use]
    pub fn new(wire: &'w ReferenceWire, expand: bool) -> Self {
        let mut aliases: BTreeMap<String, String> = wire
            .entries
            .iter()
            .filter_map(|(key, entry)| Some((key.clone(), entry.as_ref()?.document_id.clone()?)))
            .collect();
        // The caller's table answers ahead of the graph.
        aliases.extend(wire.aliases.iter().cloned());
        Self {
            wire,
            aliases,
            expand,
            refused: Cell::new(None),
            degradations: RefCell::new(Vec::new()),
        }
    }

    /// Why the layout through this host must be refused, the first reason noted.
    #[must_use]
    pub fn refused(&self) -> Option<Refused> {
        self.refused.get()
    }

    /// What the layout reported instead of failing, in order.
    #[must_use]
    pub fn degradations(&self) -> Vec<Degradation> {
        self.degradations.borrow().clone()
    }

    fn refuse(&self, why: Refused) {
        if self.refused.get().is_none() {
            self.refused.set(Some(why));
        }
    }

    // The tables are maps on the host's side, where a later row wins.
    fn entry(&self, key: &str) -> Option<&'w Option<LoadedReference>> {
        self.wire.entries.iter().rev().find(|(name, _)| name == key).map(|(_, entry)| entry)
    }

    /// The loaded record of a document id: its own `documentId`, else its key.
    fn by_id(&self, id: &str) -> Option<&'w LoadedReference> {
        self.wire.entries.iter().rev().find_map(|(key, entry)| {
            let entry = entry.as_ref()?;
            (entry.document_id.as_deref().unwrap_or(key) == id).then_some(entry)
        })
    }

    fn title(&self, id: &str) -> Option<String> {
        self.wire.titles.iter().rev().find(|(name, _)| name == id).map(|(_, title)| title.clone())
    }

    /// A body parsed with this wire's aliases resolved; refused past the
    /// parser's bounds.
    fn root_of(&self, body: &str) -> Option<Root> {
        let root = parse_markdown_body(body).map_err(|_| self.refuse(Refused::Body)).ok()?;
        Some(resolve_references(&root, &self.aliases))
    }

    /// What a file node's reference draws from its record (`fileContent`).
    fn file_content(&self, entry: &LoadedReference, resolved: &mut ResolvedReference) {
        if let Some(body) = &entry.body {
            resolved.markdown = if is_blank(body) { None } else { self.root_of(body) };
        } else {
            resolved.canvas = entry.canvas.clone().filter(|canvas| !canvas.nodes.is_empty());
        }
    }

    /// `resolveReference`: what loaded for `reference`, the surface's extras
    /// over it; none when neither says anything, which the composer reads as
    /// it reads a record that says nothing.
    fn reference(&self, reference: &str) -> Option<ResolvedReference> {
        let loaded = self.entry(reference).and_then(Option::as_ref);
        let extra = self.wire.extras.iter().rev().find(|(key, _)| key == reference).map(|(_, e)| e);
        let mut resolved = ResolvedReference::default();
        if let Some(entry) = loaded {
            resolved.label.clone_from(&entry.name);
            self.file_content(entry, &mut resolved);
        }
        if let Some(extra) = extra {
            resolved.label = extra.label.clone().or(resolved.label);
            resolved.missing = extra.missing.unwrap_or_default();
            resolved.image = extra
                .image
                .as_ref()
                .map(|image| ReferenceImage { href: image.href.clone(), alt: image.alt.clone() });
            resolved.facets.clone_from(&extra.facets);
        }
        (resolved != ResolvedReference::default()).then_some(resolved)
    }

    /// `resolveEmbed`: a body as its parsed root, else a canvas; with the
    /// record's name, else the title table's.
    fn embedded(&self, id: &str) -> Option<(Option<String>, Result<Root, &'w SpatialCanvas>)> {
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
    fn whole_canvas(&self, id: &str, fragment: Option<&str>) -> Option<&'w SpatialCanvas> {
        if fragment.is_some() {
            self.refuse(Refused::Fragment);
            return None;
        }
        self.embedded(id)?.1.err()
    }
}

impl ComposeHost for WireHost<'_> {
    fn parse_body(&self, text: &str) -> Result<Root, ParseFailed> {
        self.root_of(text).ok_or(ParseFailed)
    }

    fn resolve_reference(&self, reference: &str) -> Option<ResolvedReference> {
        self.reference(reference)
    }

    fn expand_file_node(&self, _: &SpatialNode) -> bool {
        self.expand
    }

    fn embedded_canvas(&self, document_id: &str, fragment: Option<&str>) -> Option<SpatialCanvas> {
        self.whole_canvas(document_id, fragment).cloned()
    }

    fn parse_markdown(&self, text: &str) -> Result<Root, ParseFailed> {
        parse_markdown_body(text).map_err(|_| self.refuse(Refused::Body)).map_err(|()| ParseFailed)
    }

    fn degrade(&self, event: Degradation) {
        self.degradations.borrow_mut().push(event);
    }
}

impl InlineSeams for WireHost<'_> {
    fn expand_emoji(&self, text: &str) -> String {
        if may_hold_shortcode(text) {
            self.refuse(Refused::Shortcode);
        }
        text.to_owned()
    }

    fn icon_ranges(&self, text: &str) -> Vec<IconRange> {
        if may_hold_shortcode(text) {
            self.refuse(Refused::Shortcode);
        }
        Vec::new()
    }

    fn document_title(&self, document_id: &str) -> Option<String> {
        self.by_id(document_id)
            .and_then(|entry| entry.name.clone())
            .or_else(|| self.title(document_id))
    }

    fn embed_name(&self, document_id: &str) -> Option<String> {
        self.embedded(document_id)?.0
    }

    fn embed_pending(&self, _: &str) -> bool {
        false
    }

    fn image_reference(&self, url: &str) -> Option<ImageRef> {
        let extra = self.wire.extras.iter().rev().find(|(key, _)| key == url)?;
        let image = extra.1.image.as_ref()?;
        Some(ImageRef { href: image.href.clone(), width: image.width, height: image.height })
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

impl CodeTokenizer for WireHost<'_> {
    /// A fence with no language is plain to the TypeScript's highlighter too;
    /// any other is the highlighter's to colour.
    fn tokenize(&self, lang: &str, _: &str) -> Option<CodeTokenLines> {
        if !lang.is_empty() {
            self.refuse(Refused::Highlight);
        }
        None
    }
}
