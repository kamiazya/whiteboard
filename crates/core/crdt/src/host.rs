//! Where a document's containers are found: the roots of its own `LoroDoc`,
//! or the keys of the meta map of the workspace tree node that hosts it — the
//! TypeScript's `DocumentContainers` seam. The writers are written once over
//! this and hosted twice, so a hosted write appends the operations the
//! TypeScript's `documentContainers` host appends.
//!
//! On a node, opening a container is a write: an absent key gets a regular
//! child container (`getOrCreateContainer`), and a key holding anything other
//! than the container opened there — a scalar, or another kind — is refused
//! (`UnreadableDocumentContentError`) rather than opened over. A peek opens
//! nothing. A root is implicit, so opening one and peeking at one agree.

use crate::spatial_write::Fault;
use loro::{Container, LoroDoc, LoroMap, LoroText, ValueOrContainer};

/// What a node holding the wrong thing at a key is refused with.
const UNREADABLE: Fault = Fault::Thrown("UnreadableDocumentContentError");
/// What npm loro-crdt throws is a string, so the engine names its class so.
pub(crate) const LORO_REFUSAL: Fault = Fault::Thrown("string");
/// A root container name npm loro-crdt refuses to open starts with this.
const MERGEABLE_PREFIX: &str = "🤝:";

/// One document's containers.
pub(crate) struct Host<'a> {
    doc: &'a LoroDoc,
    node: Option<LoroMap>,
}

/// The container at `key` of a node's meta map when it is the kind `pick`
/// takes, nothing when absent, and a refusal over anything else.
fn held<T>(
    meta: &LoroMap,
    key: &str,
    pick: fn(Container) -> Option<T>,
) -> Result<Option<T>, Fault> {
    match meta.get(key) {
        None => Ok(None),
        Some(ValueOrContainer::Container(held)) => pick(held).map(Some).ok_or(UNREADABLE),
        Some(ValueOrContainer::Value(_)) => Err(UNREADABLE),
    }
}

fn as_map(held: Container) -> Option<LoroMap> {
    if let Container::Map(map) = held { Some(map) } else { None }
}

fn as_text(held: Container) -> Option<LoroText> {
    if let Container::Text(text) = held { Some(text) } else { None }
}

impl<'a> Host<'a> {
    /// A document that is the root of its own `LoroDoc`.
    pub(crate) fn root(doc: &'a LoroDoc) -> Self {
        Self { doc, node: None }
    }

    /// The document hosted on the tree node whose meta map is `meta`.
    pub(crate) fn node(doc: &'a LoroDoc, meta: LoroMap) -> Self {
        Self { doc, node: Some(meta) }
    }

    /// The `LoroDoc` the containers belong to.
    pub(crate) fn doc(&self) -> &'a LoroDoc {
        self.doc
    }

    /// Ends the change in progress, on the document the containers belong to.
    pub(crate) fn commit(&self) {
        self.doc.commit();
    }

    /// `getMap`: the map at `key`, opened.
    pub(crate) fn map(&self, key: &str) -> Result<LoroMap, Fault> {
        let Some(meta) = &self.node else { return Ok(self.doc.get_map(key)) };
        match held(meta, key, as_map)? {
            Some(map) => Ok(map),
            None => meta.insert_container(key, LoroMap::new()).map_err(|_| Fault::Declined),
        }
    }

    /// `getText`: the text at `key`, opened. A root name npm loro-crdt
    /// refuses (empty, mergeable-prefixed, or holding `/` or NUL) is thrown
    /// as it throws it; a node's key is a map key, which takes any name.
    pub(crate) fn text(&self, key: &str) -> Result<LoroText, Fault> {
        let Some(meta) = &self.node else {
            let named = !key.is_empty() && !key.starts_with(MERGEABLE_PREFIX);
            if !named || key.contains(['/', '\0']) {
                return Err(LORO_REFUSAL);
            }
            return Ok(self.doc.get_text(key));
        };
        match held(meta, key, as_text)? {
            Some(text) => Ok(text),
            None => meta.insert_container(key, LoroText::new()).map_err(|_| Fault::Declined),
        }
    }

    /// `peekMapOf`: the map at `key` if one is there, opening none on a node.
    pub(crate) fn peek_map(&self, key: &str) -> Result<Option<LoroMap>, Fault> {
        match &self.node {
            None => Ok(Some(self.doc.get_map(key))),
            Some(meta) => held(meta, key, as_map),
        }
    }
}
