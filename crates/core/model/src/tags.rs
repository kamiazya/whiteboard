//! The scoped-tag grammar (`packages/model/src/tags.ts`, ADR-0040 decision 1):
//! a tag is `key:value` when both halves are lowercase identifiers and there is
//! exactly one colon, and a plain tag otherwise, preserved and never read.

/// `^[a-z][a-z0-9-]*$`, the facet-name grammar a scoped tag's halves follow.
fn identifier(text: &str) -> bool {
    let mut bytes = text.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `(key, value)` for a well-formed scoped tag (`parseScopedTag`), none for a
/// plain one: `Machine Learning`, `v1.2`, `foo:Bar` and `a:b:c` alike.
#[must_use]
pub fn parse_scoped_tag(tag: &str) -> Option<(&str, &str)> {
    let (key, value) = tag.split_once(':')?;
    (!value.contains(':') && identifier(key) && identifier(value)).then_some((key, value))
}

#[cfg(test)]
mod tests {
    use super::parse_scoped_tag;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_scoped_tag_is_two_identifiers_around_one_colon() {
        assert_eq!(parse_scoped_tag("health:failing"), Some(("health", "failing")));
        assert_eq!(parse_scoped_tag("a1-b:c-2"), Some(("a1-b", "c-2")));
    }

    #[test]
    fn anything_else_is_a_plain_tag() {
        for plain in [
            "Machine Learning",
            "v1.2",
            "foo:Bar",
            "Foo:bar",
            "a:b:c",
            ":b",
            "a:",
            "1a:b",
            "a:-b",
            "a_b:c",
            "a:b c",
            "",
        ] {
            assert_eq!(parse_scoped_tag(plain), None, "{plain:?}");
        }
    }
}
