//! A document's content as `wb_facet_set` reads it, one named query at a
//! time, refusing as the TypeScript's session does.

use whiteboard_api_contracts::Refusal;
use whiteboard_model::crdt::QueryName;
use whiteboard_model::{Map, Value};
use whiteboard_ports::PortError;
use whiteboard_workspace_index::WorkspaceRecord;

use super::FacetSetPending;
use crate::content::field;
use crate::document_get::Stop;
use crate::document_get::engine::{Fault, Hosted, defined};

/// Why the call stops before it answers.
#[derive(Debug)]
pub(super) enum Halt {
    Refused(Refusal),
    Pending(FacetSetPending),
}

impl From<Refusal> for Halt {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<&PortError> for Halt {
    fn from(error: &PortError) -> Self {
        Self::Refused(Refusal::from(error))
    }
}

impl From<Fault> for Halt {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Retired(found) => Self::Refused(Refusal::RetiredStoredShape { found }),
            Fault::Stop(Stop::Refused(refusal)) => Self::Refused(refusal),
            Fault::Stop(Stop::Pending(_)) => Self::Pending(FacetSetPending::UndecidedRead),
        }
    }
}

/// The kinds a document states; one that states none, or one this build does
/// not recognise, is none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Spatial,
    Markdown,
}

impl Kind {
    pub(super) const fn name(self) -> &'static str {
        match self {
            Self::Spatial => "spatial",
            Self::Markdown => "markdown",
        }
    }
}

/// One document of the record, read as the call's session reads it.
#[derive(Clone, Copy)]
pub(super) struct Doc<'a> {
    pub(super) record: &'a WorkspaceRecord,
    pub(super) id: &'a str,
}

impl Doc<'_> {
    fn query(self, query: QueryName) -> Result<Value, Halt> {
        Ok(Hosted { record: self.record, document_id: self.id }.read(query, &[])?)
    }

    pub(super) fn kind(self) -> Result<Option<Kind>, Halt> {
        Ok(match defined(self.query(QueryName::DocumentKind)?) {
            Some(Value::String(kind)) if kind == "spatial" => Some(Kind::Spatial),
            Some(Value::String(kind)) if kind == "markdown" => Some(Kind::Markdown),
            _ => None,
        })
    }

    /// The extension facets stored on the document, in the order the engine
    /// answers them.
    pub(super) fn facets(self) -> Result<Map, Halt> {
        facets_of(self.query(QueryName::Facets)?)
    }

    /// The core facets of a markdown document's frontmatter, none when it
    /// holds none yet.
    pub(super) fn core(self) -> Result<Option<Map>, Halt> {
        core_of(self.query(QueryName::CoreFacets)?)
    }

    /// The canvas the document holds.
    pub(super) fn canvas(self) -> Result<Map, Halt> {
        canvas_of(&self.query(QueryName::SpatialCanvas)?)
    }

    /// The ids of the nodes, or of the edges, a person has locked.
    pub(super) fn locks(self, query: QueryName) -> Result<Vec<String>, Halt> {
        locks_of(self.query(query)?)
    }
}

/// An answer the engine's contract does not hold is a read left undecided.
const UNDECIDED: Halt = Halt::Pending(FacetSetPending::UndecidedRead);

fn facets_of(answer: Value) -> Result<Map, Halt> {
    match answer {
        Value::Map(entries) => Ok(entries),
        _ => Err(UNDECIDED),
    }
}

fn core_of(answer: Value) -> Result<Option<Map>, Halt> {
    match defined(answer) {
        None => Ok(None),
        Some(Value::Map(entries)) => Ok(Some(entries)),
        Some(_) => Err(UNDECIDED),
    }
}

fn canvas_of(answer: &Value) -> Result<Map, Halt> {
    match field(answer, "canvas") {
        Some(Value::Map(canvas)) => Ok(canvas.clone()),
        _ => Err(UNDECIDED),
    }
}

fn locks_of(answer: Value) -> Result<Vec<String>, Halt> {
    match answer {
        Value::Seq(ids) => Ok(ids
            .into_iter()
            .filter_map(|id| match id {
                Value::String(id) => Some(id),
                _ => None,
            })
            .collect()),
        _ => Err(UNDECIDED),
    }
}

/// A member of a map value, by name.
pub(super) fn member<'m>(entries: &'m Map, name: &str) -> Option<&'m Value> {
    entries.iter().find(|(key, _)| key == name).map(|(_, value)| value)
}

/// The elements of a canvas collection, each as the map it is.
pub(super) fn elements<'m>(canvas: &'m Map, collection: &str) -> Vec<&'m Map> {
    match member(canvas, collection) {
        Some(Value::Seq(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::Map(entries) => Some(entries),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// An element's id.
pub(super) fn id_of(element: &Map) -> Option<&str> {
    match member(element, "id") {
        Some(Value::String(id)) => Some(id),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
