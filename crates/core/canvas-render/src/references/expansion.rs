//! Which file nodes draw their resolved canvas open (`expandFileNode`): the
//! caller's policy, settled ahead by `canvasLayoutRequest` over every file
//! node of the canvas and of each canvas it could nest, so the core asks a
//! table where the TypeScript calls a function.

use std::collections::BTreeSet;

use whiteboard_model::spatial::SpatialNode;

/// The settled policy. A node is asked by its id alone, which is why the
/// request gate refuses a policy that answers one id both ways.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expansion {
    /// Every file node alike.
    Every(bool),
    /// Only the file nodes with these ids.
    Only(BTreeSet<String>),
}

impl Expansion {
    /// Whether `node` is drawn open.
    #[must_use]
    pub fn opens(&self, node: &SpatialNode) -> bool {
        match self {
            Self::Every(open) => *open,
            Self::Only(ids) => ids.contains(&node.id),
        }
    }
}

impl From<bool> for Expansion {
    fn from(open: bool) -> Self {
        Self::Every(open)
    }
}
