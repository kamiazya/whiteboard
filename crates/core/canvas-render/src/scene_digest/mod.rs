//! `sceneDigest`, ported from `packages/canvas-render/src/scene-digest.ts`: the
//! AI-facing spatial digest of a laid-out scene. One entry per addressable node,
//! the pairs that overlap, the strict containments, the proximity clusters and
//! the free runs of a 20px grid, and whether a guard cut any of them short.
//!
//! The TypeScript is the byte-identical oracle ([`SceneDigest::to_json`] against
//! `JSON.stringify` of its answer), so every ordering is its explicit sort with
//! its tie-breaker, ids compare by UTF-16 code unit, and where it iterates a
//! `Map` the order of insertion is reproduced. Two answers are not data: a scene
//! whose free-region grid cannot be allocated is [`DigestError::InvalidGrid`]
//! where the TypeScript throws `RangeError`; and the TypeScript's own limit on
//! how many arguments `Math.min(...)` takes (about 125,000 entries) is not
//! reproduced, since no scene a layout produces comes near it.

mod free_regions;
mod json;
mod pairs;

use whiteboard_scene::{BoundingBox, Scene, SceneNode};

use crate::scene_walk::SceneWalk;

/// Upper bound on the entry count fed into the pairwise overlap, containment
/// and cluster derivations; past it each of the three is empty.
pub const PAIRWISE_MAX_ENTRIES: usize = 2_000;

/// One addressable node of the scene.
#[derive(Debug, Clone, PartialEq)]
pub struct DigestNode {
    pub id: String,
    pub bbox: BoundingBox,
    /// The node's position among the digest's entries.
    pub z: usize,
    /// The content was cut to fit the box.
    pub truncated: bool,
    /// The content does not fit the box at all.
    pub overflows: bool,
}

/// A strict containment: `parent` is the smallest box that strictly holds `child`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Containment {
    pub parent: String,
    pub child: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SceneDigest {
    pub nodes: Vec<DigestNode>,
    pub overlaps: Vec<[String; 2]>,
    pub containment: Vec<Containment>,
    pub clusters: Vec<Vec<String>>,
    pub free_regions: Vec<BoundingBox>,
    /// A guard dropped a derivation, or cut one short.
    pub partial: bool,
}

/// Why a digest was not answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestError {
    /// The free-region grid's width is not a number while its height is, which
    /// is a NaN or infinite coordinate: the TypeScript throws `RangeError:
    /// Invalid array length` allocating a row.
    InvalidGrid,
}

/// What the digest reports as an entry, before it is numbered.
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) bbox: BoundingBox,
    pub(crate) truncated: bool,
    pub(crate) overflows: bool,
}

/// The chrome shapes that carry an id and are neither comment nor proposal
/// chrome, which is what a reader can address. A scene with none is a fragment,
/// not a canvas projection, so every box-bearing node is taken, named by position.
fn collect_entries(scene: &Scene) -> Vec<Entry> {
    let identified: Vec<Entry> = scene
        .nodes
        .iter()
        .filter_map(|node| match node {
            SceneNode::Shape(shape) if !shape.comment_chrome && shape.proposal_chrome.is_none() => {
                shape.id.as_ref().map(|id| Entry {
                    id: id.clone(),
                    bbox: shape.bbox,
                    truncated: shape.truncated,
                    overflows: shape.overflows,
                })
            }
            _ => None,
        })
        .collect();
    if !identified.is_empty() {
        return identified;
    }
    scene
        .nodes
        .iter()
        .filter_map(|node| SceneWalk::Node(node).bbox())
        .enumerate()
        .map(|(index, bbox)| Entry {
            id: format!("n{index}"),
            bbox: *bbox,
            truncated: false,
            overflows: false,
        })
        .collect()
}

/// The digest of a laid-out scene.
///
/// # Errors
///
/// [`DigestError::InvalidGrid`] where the TypeScript throws `RangeError`.
pub fn scene_digest(scene: &Scene) -> Result<SceneDigest, DigestError> {
    let entries = collect_entries(scene);
    let (free_regions, regions_capped) = free_regions::free_regions(&entries)?;
    let (overlaps, overlaps_capped) = pairs::overlaps(&entries);
    Ok(SceneDigest {
        containment: pairs::containment(&entries),
        clusters: pairs::clusters(&entries),
        partial: entries.len() > PAIRWISE_MAX_ENTRIES || overlaps_capped || regions_capped,
        nodes: entries
            .into_iter()
            .enumerate()
            .map(|(z, e)| DigestNode {
                id: e.id,
                bbox: e.bbox,
                z,
                truncated: e.truncated,
                overflows: e.overflows,
            })
            .collect(),
        overlaps,
        free_regions,
    })
}

#[cfg(test)]
mod tests;
