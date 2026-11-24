//! What a workspace's tag library declares (`tag-library.ts`): the one lookup
//! every reader of colour-by-intent makes, so they cannot disagree about what
//! "declared" means.

use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::{Map, Value};

use crate::stencil_library::{member, sorted};
use crate::visual::{CanvasColor, TagLibrary};

/// Where a workspace keeps its tag library.
pub const TAG_LIBRARY_PATH: &str = "tags";
/// The facet a tag library is declared in.
pub const VISUAL_TAGS_KEY: &str = "visual.tags/v0";
const VISUAL_TAGS_FACET: &str = "facets/visual/visual.schema.json#/$defs/VisualTagsFacet";

/// What a library document's facets declare (`readTagLibrary`): each key's
/// declaration as the schema parses it, keys and each key's values in name
/// order; none for facets without the library facet or with one the schema
/// refuses, since a drawing must stay readable when a document elsewhere is
/// wrong.
#[must_use]
pub fn read_tag_library(facets: &Value, registry: &Registry) -> Map {
    let contracts = registry.contracts();
    let parsed = member(facets, VISUAL_TAGS_KEY)
        .zip(contracts.resolve(VISUAL_TAGS_FACET))
        .and_then(|(raw, shape)| contracts.validate(shape, raw).ok());
    let Some(Value::Map(keys)) = parsed.as_ref().and_then(|parsed| member(parsed, "keys")) else {
        return Map::new();
    };
    sorted(keys)
        .into_iter()
        .map(|(key, declaration)| {
            let Value::Map(fields) = declaration else { return (key, declaration) };
            let fields = fields
                .into_iter()
                .map(|(name, value)| match value {
                    Value::Map(values) if name == "values" => (name, Value::Map(sorted(&values))),
                    other => (name, other),
                })
                .collect();
            (key, Value::Map(fields))
        })
        .collect()
}

/// The colour the library declares for the value `value` of the key `key`
/// (`declaredColourOf`): an undeclared key, an undeclared value and a value
/// declared without a colour all answer none.
#[must_use]
pub fn declared_colour_of<'l>(
    library: &'l TagLibrary,
    key: &str,
    value: &str,
) -> Option<&'l CanvasColor> {
    let (_, declaration) = library.iter().find(|(name, _)| name == key)?;
    let (_, value) = declaration.values.as_ref()?.iter().find(|(name, _)| name == value)?;
    value.color.as_ref()
}

#[cfg(test)]
mod tests {
    use whiteboard_model::json;

    use super::{declared_colour_of, read_tag_library};
    use crate::host::visual_registry;
    use crate::visual::{TagKeyDeclaration, TagLibrary, TagValueDeclaration};

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn value(name: &str, color: Option<&str>) -> (String, TagValueDeclaration) {
        let declaration = TagValueDeclaration {
            color: color.map(str::to_owned),
            ..TagValueDeclaration::default()
        };
        (name.to_owned(), declaration)
    }

    fn library() -> TagLibrary {
        vec![
            ("open".to_owned(), TagKeyDeclaration::default()),
            (
                "health".to_owned(),
                TagKeyDeclaration {
                    values: Some(vec![value("failing", Some("1")), value("unknown", None)]),
                    ..TagKeyDeclaration::default()
                },
            ),
        ]
    }

    fn read(facets: &str) -> whiteboard_model::Map {
        let registry = visual_registry().expect("the bundled plugin");
        read_tag_library(&json::parse(facets).expect("JSON"), &registry)
    }

    #[test]
    fn a_library_reads_its_keys_and_values_in_name_order() {
        let library = read(
            r#"{"visual.tags/v0": {"keys": {"team": {}, "health": {"exclusive": true,
                "values": {"ok": {"color": "4"}, "failing": {"description": "d", "color": "1"}}}}}}"#,
        );
        let expected = json::parse(
            r#"{"health": {"exclusive": true, "values": {"failing": {"color": "1", "description": "d"},
                "ok": {"color": "4"}}}, "team": {}}"#,
        );
        assert_eq!(Some(whiteboard_model::Value::Map(library)), expected.ok());
    }

    #[test]
    fn no_library_or_one_the_schema_refuses_reads_as_none() {
        for facets in [
            r"{}",
            r#"{"visual.tags/v0": {"keys": {"Bad Key": {}}}}"#,
            r#"{"visual.tags/v0": {"keys": {"k": {"stray": 1}}}}"#,
            r#"{"visual.tags/v0": []}"#,
        ] {
            assert!(read(facets).is_empty(), "{facets}");
        }
    }

    #[test]
    fn a_declared_value_answers_its_colour() {
        assert_eq!(
            declared_colour_of(&library(), "health", "failing").map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn anything_undeclared_answers_none() {
        let library = library();
        assert_eq!(declared_colour_of(&library, "team", "failing"), None);
        assert_eq!(declared_colour_of(&library, "open", "failing"), None);
        assert_eq!(declared_colour_of(&library, "health", "ok"), None);
        assert_eq!(declared_colour_of(&library, "health", "unknown"), None);
    }
}
