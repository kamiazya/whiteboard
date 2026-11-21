//! The composer's host over a [`ReferenceWire`]: `referenceSeamsFromWire`'s
//! seams, answered in the core.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use whiteboard_codec::markdown::{parse_markdown_body, parse_markdown_body_with_lines};
use whiteboard_codec::references::resolve_references;
use whiteboard_det::utf16::is_js_whitespace;
use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};

use super::{Expansion, FenceTokens, LoadedReference, ReferenceWire};
use crate::comments::body::literal_root;
use crate::compose_node::{ComposeHost, Degradation, ParseFailed};
use crate::node_box::{ReferenceImage, ResolvedReference};
use crate::typeset::CodeTokenLines;

mod code;
mod embed;
mod inline;

/// A fence as `(lang, value)`.
type Fence = (String, String);

/// The fences a layout asked for, in the order met and as a set.
#[derive(Default)]
struct Asked {
    order: Vec<Fence>,
    seen: BTreeSet<Fence>,
}

/// The seams over one wire, and what one layout through them reported.
pub struct WireHost<'w> {
    wire: &'w ReferenceWire,
    /// The wire's own alias table over the graph's ids: a written target to
    /// the id it names (`resolveAlias`).
    aliases: BTreeMap<String, String>,
    /// Which file nodes draw their resolved canvas open.
    expand: Expansion,
    /// The fences' tokens the caller sent by `(lang, value)`, a later row
    /// answering first: indexed once, since a body may hold many fences.
    code: BTreeMap<(&'w str, &'w str), &'w Option<CodeTokenLines>>,
    /// Each fence the highlighter colours whose tokens were not sent, in the
    /// order met, and the same as a set so a fence is asked for once.
    needs: RefCell<Asked>,
    degradations: RefCell<Vec<Degradation>>,
}

/// JavaScript's `trim()` would leave nothing: every unit is a white space or a
/// line terminator, which is what `\s` matches.
fn is_blank(text: &str) -> bool {
    text.chars().all(|c| u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace))
}

impl<'w> WireHost<'w> {
    /// `parse_body`'s tree with the start line of each top-level block, from
    /// the one parse.
    ///
    /// # Errors
    ///
    /// [`ParseFailed`] for a body past the parser's bounds.
    pub fn parse_body_with_lines(&self, text: &str) -> Result<(Root, Vec<usize>), ParseFailed> {
        let (root, lines) = parse_markdown_body_with_lines(text).map_err(|_| ParseFailed)?;
        Ok((resolve_references(&root, &self.aliases), lines))
    }

    /// The host over `wire`, drawing a file node's resolved canvas open when
    /// `expand` (the caller's policy, settled ahead) names it.
    #[must_use]
    pub fn new(wire: &'w ReferenceWire, expand: impl Into<Expansion>) -> Self {
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
            expand: expand.into(),
            code: BTreeMap::new(),
            needs: RefCell::new(Asked::default()),
            degradations: RefCell::new(Vec::new()),
        }
    }

    /// This host answering a fence's tokens from `code`.
    #[must_use]
    pub fn with_code_tokens(mut self, code: &'w [FenceTokens]) -> Self {
        // Inserted one by one: `collect` builds a map in bulk through a stable
        // sort, which links several kilobytes for no gain on a table this size.
        for fence in code {
            self.code.insert((fence.lang.as_str(), fence.value.as_str()), &fence.lines);
        }
        self
    }

    /// The fences, as `[lang, value]`, the highlighter colours and whose
    /// tokens the caller must send before this layout can be drawn as the
    /// TypeScript draws it, in the order they were met.
    #[must_use]
    pub fn needs(&self) -> Vec<(String, String)> {
        self.needs.borrow().order.clone()
    }

    /// What the layout reported instead of failing, in order.
    #[must_use]
    pub fn degradations(&self) -> Vec<Degradation> {
        self.degradations.borrow().clone()
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

    /// Whether the caller is still loading `document_id`: an
    /// extra marked pending names it as written, or as a target the alias
    /// table resolves to it.
    fn pending(&self, document_id: &str) -> bool {
        self.wire.extras.iter().any(|(key, extra)| {
            extra.pending == Some(true)
                && (key == document_id || self.aliases.get(key).is_some_and(|id| id == document_id))
        })
    }

    fn title(&self, id: &str) -> Option<String> {
        self.wire.titles.iter().rev().find(|(name, _)| name == id).map(|(_, title)| title.clone())
    }

    /// A body parsed with this wire's aliases resolved; past the parser's
    /// bounds, one paragraph of its literal text (owner decision q81, D7a).
    fn root_of(&self, body: &str) -> Root {
        parse_markdown_body(body)
            .map_or_else(|_| literal_root(body), |root| resolve_references(&root, &self.aliases))
    }

    /// What a file node's reference draws from its record (`fileContent`).
    fn file_content(&self, entry: &LoadedReference, resolved: &mut ResolvedReference) {
        if let Some(body) = &entry.body {
            resolved.markdown = if is_blank(body) { None } else { Some(self.root_of(body)) };
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
}

impl ComposeHost for WireHost<'_> {
    fn parse_body(&self, text: &str) -> Result<Root, ParseFailed> {
        self.parse_body_with_lines(text).map(|(root, _)| root)
    }

    fn resolve_reference(&self, reference: &str) -> Option<ResolvedReference> {
        self.reference(reference)
    }

    fn expand_file_node(&self, node: &SpatialNode) -> bool {
        self.expand.opens(node)
    }

    fn embedded_canvas(&self, document_id: &str, fragment: Option<&str>) -> Option<SpatialCanvas> {
        self.canvas_part(document_id, fragment)
    }

    fn degrade(&self, event: Degradation) {
        self.degradations.borrow_mut().push(event);
    }
}
