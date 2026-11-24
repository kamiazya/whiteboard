//! Where a workspace's addresses are kept: which canonical id a segment names,
//! in which namespace (ADR-0019, ADR-0053).

use std::future::Future;

use crate::{MaybeSend, PortError};

/// A registry row: a workspace's canonical id, and the namespace and segment
/// it is addressed by. A layer the row lacks is absent rather than invented:
/// a workspace minted before segments existed is reached by its id alone, and
/// a row with no namespace sits in the single-person one, `me`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEntry {
    pub workspace_id: String,
    pub namespace: Option<String>,
    pub segment: Option<String>,
}

/// One point lookup in the registry. Both forms are unique, so either names
/// at most one row, which is what lets a keeper with many people answer it
/// from an index rather than by reading every row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceLookup {
    /// The row of this canonical id, whatever namespace holds it.
    Id(String),
    /// The row holding `segment` in `namespace`. Not checked as a handle: a
    /// caller with no namespace of its own looks in one no row can hold, and
    /// reaches nothing rather than being refused.
    Segment { namespace: String, segment: String },
}

/// The workspace registry a keeper holds: natively a table, on Workers a
/// Durable Object's index. Only the read an address needs is here; the
/// listing and the registry's writes join with the operations that make them.
pub trait WorkspaceRegistry {
    /// The row `lookup` names, or `None`. An answer is the row the lookup
    /// names and no other; a row without a namespace sits in `me`.
    fn find(
        &self,
        lookup: &WorkspaceLookup,
    ) -> impl Future<Output = Result<Option<WorkspaceEntry>, PortError>> + MaybeSend;
}
