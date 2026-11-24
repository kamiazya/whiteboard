//! The operation table: every operation this crate answers, as data.

use crate::{
    DocumentGet, DocumentList, DocumentResolve, DocumentSearch, FacetList, Operation, Row,
    VersionList, VersionSave,
};

/// Visits each operation by type, so a caller reaches its `execute` and its
/// input and output types as well as its row.
pub trait Visit {
    fn operation<O: Operation>(&mut self);
}

/// Both halves of the table from one list, so they cannot disagree.
macro_rules! table {
    ($($op:ty),+ $(,)?) => {
        /// Every operation's row, in table order.
        pub const OPERATIONS: &[Row] = &[$(<$op as Operation>::ROW),+];

        /// Hands each operation to `visit`, in table order.
        pub fn each_operation(visit: &mut impl Visit) {
            $(visit.operation::<$op>();)+
        }
    };
}

table!(
    DocumentList,
    DocumentResolve,
    DocumentGet,
    VersionList,
    VersionSave,
    FacetList,
    DocumentSearch
);

#[cfg(test)]
mod tests;
