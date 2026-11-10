//! The named matchers of `contracts/facets/visual`'s `x-wb-matcher` keyword:
//! what a pattern says in the generated Zod, written once more here without a
//! regex engine and held equal to it by the cases both languages' tests share.

use unicode_segmentation::UnicodeSegmentation;

/// The contract's `single_grapheme`: the text is exactly one extended grapheme
/// cluster (UAX #29), so a flag, a ZWJ family or a skin-toned hand is one and
/// two emoji are not. The empty string is none. The TypeScript twin counts with
/// `Intl.Segmenter`; both follow Unicode 17.0, which `UNICODE_VERSION` below
/// holds the table to.
pub fn single_grapheme(text: &str) -> bool {
    let mut clusters = text.graphemes(true);
    clusters.next().is_some() && clusters.next().is_none()
}

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
    // The strings `visual.contract.test.ts` takes and refuses.
    #[test]
    fn a_single_grapheme_is_one_cluster_however_many_code_points() {
        for good in [
            "\u{2705}",
            "\u{26a0}\u{fe0f}",
            "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}",
            "\u{1f1ef}\u{1f1f5}",
            "1\u{fe0f}\u{20e3}",
            "\u{1f44d}\u{1f3fd}",
            "\u{91cd}",
            "e\u{301}",
            "\u{1f3f3}\u{fe0f}\u{200d}\u{1f308}",
            "\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}",
            "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
            "\r\n",
            "\u{1100}\u{1161}\u{11a8}",
        ] {
            assert!(single_grapheme(good), "{good:?}");
        }
        for bad in [
            "",
            "ab",
            "\u{2705}\u{1f525}",
            "\u{1f1ef}\u{1f1f5}\u{1f1fa}\u{1f1f8}",
            "\u{1f44d}\u{1f44d}",
            "a\u{200b}b",
            "\n\n",
            " a",
        ] {
            assert!(!single_grapheme(bad), "{bad:?}");
        }
    }

    // QR-20b: a bump of the crate moves which strings are one symbol, so it is
    // a PR of its own; the table the TypeScript twin's `Intl.Segmenter` carries
    // under `.node-version` is the same release.
    #[test]
    fn the_grapheme_tables_are_the_unicode_release_the_oracle_follows() {
        assert_eq!(unicode_segmentation::UNICODE_VERSION, (17, 0, 0));
    }

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
