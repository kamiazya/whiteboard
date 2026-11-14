//! What a workspace's tag library declares (`tag-library.ts`): the one lookup
//! every reader of colour-by-intent makes, so they cannot disagree about what
//! "declared" means.

use crate::visual::{CanvasColor, TagLibrary};

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
    use super::declared_colour_of;
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
