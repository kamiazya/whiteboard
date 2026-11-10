//! The named matchers of `contracts/facets/engine`'s `x-wb-matcher` keyword:
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

/// `^#[0-9a-fA-F]{6}$`: the pattern of the contract's `HexColor`, a `#` and
/// exactly six hex digits of either case.
pub fn hex_color(text: &str) -> bool {
    text.strip_prefix('#')
        .is_some_and(|digits| digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    // The strings `engine.contract.test.ts` takes and refuses.
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
            "\u{e9}.b",
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

    #[test]
    fn a_hex_colour_is_a_hash_and_six_hex_digits_of_either_case() {
        for good in ["#000000", "#ffffff", "#ABCDEF", "#1a2B3c", "#0a0a0a"] {
            assert!(hex_color(good), "{good}");
        }
        for bad in [
            "",
            "#",
            "000000",
            "#fff",
            "#ffffff0",
            "#ffffff00",
            "#gggggg",
            "#ffff f",
            "#ffffff\n",
            "\n#ffffff",
            " #ffffff",
            "##ffffff",
            "#fffff\u{e9}",
            "oklch(0.98 0 0)",
        ] {
            assert!(!hex_color(bad), "{bad:?}");
        }
    }
}
