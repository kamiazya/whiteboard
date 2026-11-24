//! A workspace's stencil library as its document declares it
//! (`readStencilLibrary`, ADR-0034 decision 4): the stencils of its
//! `visual.stencils/v0` facet, each judged on its own, so one the schema
//! refuses takes none of the others with it.

use whiteboard_facet_engine::checks::facet_segment;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::{Map, Value};

/// Where a workspace keeps its stencil library.
pub const STENCIL_LIBRARY_PATH: &str = "stencils";
/// The facet a stencil library is declared in.
pub const VISUAL_STENCILS_KEY: &str = "visual.stencils/v0";
/// How many stencils a library holds at most.
const MAX_STENCILS_PER_LIBRARY: usize = 256;
const LIBRARY_STENCIL: &str = "facets/visual/visual.schema.json#/$defs/LibraryStencil";

pub(crate) fn member<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Map(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, held)| held),
        _ => None,
    }
}

/// `entries` in UTF-16 code-unit order (`compareCodeUnit`).
pub(crate) fn sorted(entries: &Map) -> Map {
    let mut sorted = entries.clone();
    sorted.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    sorted
}

/// The library's stencils by bare name, in name order, each as the schema
/// parses it; none for facets without the library facet or with one of
/// another shape. A library past the cap keeps its first stencils by name,
/// so every read keeps the same ones.
#[must_use]
pub fn read_stencil_library(facets: &Value, registry: &Registry) -> Map {
    let contracts = registry.contracts();
    let (Some(Value::Map(stencils)), Some(shape)) = (
        member(facets, VISUAL_STENCILS_KEY).and_then(|raw| member(raw, "stencils")),
        contracts.resolve(LIBRARY_STENCIL),
    ) else {
        return Map::new();
    };
    let mut valid = Map::new();
    for (name, stencil) in sorted(stencils) {
        if valid.len() == MAX_STENCILS_PER_LIBRARY {
            break;
        }
        if !facet_segment(&name) {
            continue;
        }
        if let Ok(parsed) = contracts.validate(shape, &stencil) {
            valid.push((name, parsed));
        }
    }
    valid
}

#[cfg(test)]
mod tests;
