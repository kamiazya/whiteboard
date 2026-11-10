//! The named matchers of `contracts/facets/visual`'s `x-wb-matcher` keyword:
//! what a pattern says in the generated Zod, written once more here without a
//! regex engine and held equal to it by the cases both languages' tests share.

/// `[a-z][a-z0-9-]*`: one segment of a facet key.
fn segment(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$`: the pattern of the contract's
/// `NamespacedId`. Byte for byte, so a trailing newline is no match, as in
/// JavaScript.
pub fn namespaced_id(text: &str) -> bool {
    text.split_once('.').is_some_and(|(plugin, name)| segment(plugin) && segment(name))
}

/// `^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$`: the pattern of the
/// contract's `FacetKey`.
pub fn facet_key(text: &str) -> bool {
    let Some((plugin, rest)) = text.split_once('.') else { return false };
    let Some((name, version)) = rest.split_once('/') else { return false };
    segment(plugin)
        && segment(name)
        && version
            .strip_prefix('v')
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    // The same strings `visual.contract.test.ts` refuses and takes.
    #[test]
    fn a_namespaced_id_is_two_key_segments_and_nothing_else() {
        for good in ["visual.sketch", "a-b.c-d", "visual.x1", "z.a9-"] {
            assert!(namespaced_id(good), "{good}");
        }
        for bad in [
            "Visual.sketch",
            "sketch",
            "a.b.c",
            "1a.b",
            "a.b\n",
            "a.",
            ".b",
            "",
            "a.-b",
            "a b.c",
            "é.b",
        ] {
            assert!(!namespaced_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_facet_key_is_a_namespaced_name_and_a_numbered_version() {
        for good in ["visual.shape/v0", "a.b/v12", "a-1.b-2/v007"] {
            assert!(facet_key(good), "{good}");
        }
        for bad in [
            "visual.shape",
            "visual.shape/v",
            "a/v0",
            "A.b/v0",
            "a.b/v0\n",
            "a.b/V0",
            "a.b/v0x",
            "a.b/v-1",
            "a.b/c/v0",
            "a.b.c/v0",
            "",
        ] {
            assert!(!facet_key(bad), "{bad:?}");
        }
    }
}
