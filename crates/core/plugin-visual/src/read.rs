//! The plugin's facet readers (`data.ts`, `apply-stencil.ts`): each reads one
//! key of an object's facet bucket through the registry's compat chain, and a
//! payload that does not resolve reads as the facet's absence, so every
//! surface degrades on it the same way. They take the BUCKET, as `readSymbol`
//! does, so one reader serves a node, an edge, a line and a canvas alike.

use whiteboard_facet_engine::registry::{Registry, Resolution};
use whiteboard_model::Value;
use whiteboard_model::spatial::ExtensionFacets;

use crate::visual::{
    EdgeRoutingStyle, LineJumps, VisualEdgesFacet, VisualShapeKind, VisualStrokeWidth,
    VisualSymbolEmoji, VisualSymbolFacet, VisualSymbolIcon, VisualTextAlign,
};

pub const VISUAL_SHAPE_KEY: &str = "visual.shape/v0";
pub const VISUAL_TEXT_KEY: &str = "visual.text/v0";
pub const VISUAL_EDGES_KEY: &str = "visual.edges/v0";
pub const VISUAL_STROKE_KEY: &str = "visual.stroke/v0";
pub const VISUAL_THEME_KEY: &str = "visual.theme/v0";
pub const VISUAL_STENCIL_KEY: &str = "visual.stencil/v0";
pub const VISUAL_SYMBOL_KEY: &str = "visual.symbol/v0";
/// Which of its own facets a canvas treats as semantic axes; read raw, since a
/// stored declaration costs the axis rather than the reading.
pub const VISUAL_AXES_KEY: &str = "visual.axes/v0";

fn field<'v>(value: &'v Value, name: &str) -> Option<&'v Value> {
    let Value::Map(entries) = value else { return None };
    entries.iter().find(|(key, _)| key == name).map(|(_, found)| found)
}

fn text<'v>(value: &'v Value, name: &str) -> Option<&'v str> {
    match field(value, name)? {
        Value::String(text) => Some(text),
        _ => None,
    }
}

/// The payload stored under `key`, as its facet's current schema parses it,
/// when it resolves.
fn resolved(facets: Option<&ExtensionFacets>, key: &str, registry: &Registry) -> Option<Value> {
    let (_, stored) = facets?.iter().find(|(name, _)| name == key)?;
    match registry.resolve_facet_payload(key, stored) {
        Resolution::Resolved(value) => Some(value),
        _ => None,
    }
}

/// The text of one field of the payload stored under `key`, when it resolves.
/// The schema has already made the field a string; any other value reads as
/// none.
fn resolved_text(
    facets: Option<&ExtensionFacets>,
    key: &str,
    name: &str,
    registry: &Registry,
) -> Option<String> {
    let value = resolved(facets, key, registry)?;
    text(&value, name).map(str::to_owned)
}

/// The silhouette a node draws (`resolveNodeShape`); none is the rect.
#[must_use]
pub fn node_shape(
    facets: Option<&ExtensionFacets>,
    registry: &Registry,
) -> Option<VisualShapeKind> {
    resolved_text(facets, VISUAL_SHAPE_KEY, "kind", registry)
        .and_then(|kind| VisualShapeKind::from_wire(&kind))
}

/// Where a node's text sits (`resolveNodeTextAlign`); none is the default.
#[must_use]
pub fn node_text_align(
    facets: Option<&ExtensionFacets>,
    registry: &Registry,
) -> Option<VisualTextAlign> {
    resolved_text(facets, VISUAL_TEXT_KEY, "align", registry)
        .and_then(|align| VisualTextAlign::from_wire(&align))
}

/// What the bucket's `visual.edges/v0` says, field by field
/// (`resolveEdgeOwnStyle`, and `resolveCanvasEdgeStyle` on a canvas); a field
/// it does not say is none.
#[must_use]
pub fn edges_style(facets: Option<&ExtensionFacets>, registry: &Registry) -> VisualEdgesFacet {
    let Some(value) = resolved(facets, VISUAL_EDGES_KEY, registry) else {
        return VisualEdgesFacet::default();
    };
    VisualEdgesFacet {
        routing: text(&value, "routing").and_then(EdgeRoutingStyle::from_wire),
        line_jumps: text(&value, "lineJumps").and_then(LineJumps::from_wire),
    }
}

/// The weight a stroke draws at (`resolveStrokeWidth`); none is thin.
#[must_use]
pub fn stroke_width(
    facets: Option<&ExtensionFacets>,
    registry: &Registry,
) -> Option<VisualStrokeWidth> {
    resolved_text(facets, VISUAL_STROKE_KEY, "width", registry)
        .and_then(|width| VisualStrokeWidth::from_wire(&width))
}

/// The theme id a canvas names (`resolveCanvasTheme`); whether a theme of
/// that id is registered is the renderer's question.
#[must_use]
pub fn canvas_theme(facets: Option<&ExtensionFacets>, registry: &Registry) -> Option<String> {
    resolved_text(facets, VISUAL_THEME_KEY, "theme", registry)
}

/// The stencil a node wears (`resolveNodeStencil`), registered or not: a
/// stored id another deployment registered is data.
#[must_use]
pub fn node_stencil(facets: Option<&ExtensionFacets>, registry: &Registry) -> Option<String> {
    resolved_text(facets, VISUAL_STENCIL_KEY, "stencil", registry)
}

/// A symbol payload read by its `kind`; anything else is no symbol.
fn symbol_of(value: &Value) -> Option<VisualSymbolFacet> {
    let named = |name: &str| text(value, name).map(str::to_owned);
    match text(value, "kind") {
        Some(VisualSymbolIcon::KIND) => {
            named("name").map(|name| VisualSymbolFacet::VisualSymbolIcon(VisualSymbolIcon { name }))
        }
        Some(VisualSymbolEmoji::KIND) => named("char")
            .map(|char| VisualSymbolFacet::VisualSymbolEmoji(VisualSymbolEmoji { char })),
        _ => None,
    }
}

/// The symbol an object wears (`readSymbol`).
#[must_use]
pub fn symbol(facets: Option<&ExtensionFacets>, registry: &Registry) -> Option<VisualSymbolFacet> {
    resolved(facets, VISUAL_SYMBOL_KEY, registry).as_ref().and_then(symbol_of)
}

#[cfg(test)]
mod tests {
    use super::{symbol_of, text};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_model::Value;

    fn map(entries: &[(&str, Value)]) -> Value {
        Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
    }

    fn string(text: &str) -> Value {
        Value::String(text.to_owned())
    }

    #[test]
    fn a_field_that_is_not_a_string_of_a_mapping_has_no_text() {
        assert_eq!(text(&map(&[("kind", string("icon"))]), "kind"), Some("icon"));
        assert_eq!(text(&map(&[("kind", Value::Number(1.0))]), "kind"), None);
        assert_eq!(text(&map(&[]), "kind"), None);
        assert_eq!(text(&string("kind"), "kind"), None);
    }

    #[test]
    fn a_symbol_of_no_kind_this_plugin_draws_or_missing_its_field_is_none() {
        assert_eq!(symbol_of(&map(&[("kind", string("other")), ("name", string("x"))])), None);
        assert_eq!(symbol_of(&map(&[("kind", string("icon"))])), None);
        assert_eq!(symbol_of(&map(&[("kind", string("emoji"))])), None);
        assert_eq!(symbol_of(&map(&[("name", string("x"))])), None);
    }
}
