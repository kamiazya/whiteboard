//! The named checks of `contracts/model`'s `x-wb-check` and `x-wb-matcher`
//! keywords: what a schema cannot state, written once here and once in
//! `packages/model/src/contract-checks.ts` under the camelCase name, and held
//! equal by the differential.

use crate::Map;

/// The characters `String.prototype.trim` strips: ECMAScript's `WhiteSpace`
/// and `LineTerminator`. Not `char::is_whitespace`, which counts U+0085 and
/// misses U+FEFF.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// An actor is a single line with no surrounding whitespace
/// (`okfActor`: `value.trim() === value && !/[\r\n]/.test(value)`).
pub fn okf_actor(actor: &str) -> bool {
    !actor.starts_with(is_js_space)
        && !actor.ends_with(is_js_space)
        && !actor.contains(['\r', '\n'])
}

/// Consumes `count` ASCII digits from the front of `rest`.
fn digits(rest: &mut &[u8], count: usize) -> bool {
    match rest.split_at_checked(count) {
        Some((head, tail)) if head.iter().all(u8::is_ascii_digit) => {
            *rest = tail;
            true
        }
        _ => false,
    }
}

/// Consumes `byte` from the front of `rest`.
fn byte(rest: &mut &[u8], want: u8) -> bool {
    match rest.split_first() {
        Some((&got, tail)) if got == want => {
            *rest = tail;
            true
        }
        _ => false,
    }
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`: the
/// pattern of the contract's `OkfTimestamp`, matched without a regex engine.
pub fn okf_timestamp(text: &str) -> bool {
    let mut rest = text.as_bytes();
    let date_and_time = digits(&mut rest, 4)
        && byte(&mut rest, b'-')
        && digits(&mut rest, 2)
        && byte(&mut rest, b'-')
        && digits(&mut rest, 2)
        && byte(&mut rest, b'T')
        && digits(&mut rest, 2)
        && byte(&mut rest, b':')
        && digits(&mut rest, 2)
        && byte(&mut rest, b':')
        && digits(&mut rest, 2);
    if !date_and_time {
        return false;
    }
    if byte(&mut rest, b'.') {
        let fraction = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if fraction == 0 {
            return false;
        }
        rest = rest.get(fraction..).unwrap_or_default();
    }
    if byte(&mut rest, b'Z') {
        return rest.is_empty();
    }
    (byte(&mut rest, b'+') || byte(&mut rest, b'-'))
        && digits(&mut rest, 2)
        && byte(&mut rest, b':')
        && digits(&mut rest, 2)
        && rest.is_empty()
}

/// Whether `key` is `{namespace}.{name}/v{n}`:
/// `^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$`.
fn is_extension_facet_key(key: &str) -> bool {
    let name = |part: &str| {
        part.starts_with(|c: char| c.is_ascii_lowercase())
            && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    let Some((namespace, rest)) = key.split_once('.') else { return false };
    let Some((facet, version)) = rest.split_once("/v") else { return false };
    name(namespace)
        && name(facet)
        && !version.is_empty()
        && version.bytes().all(|b| b.is_ascii_digit())
}

/// The keys of an extension-facet bucket that are not `{namespace}.{name}/v{n}`,
/// in written order (`extensionFacetKeys`). Empty is valid.
pub fn extension_facet_keys(facets: &Map) -> Vec<&str> {
    facets.iter().map(|(key, _)| key.as_str()).filter(|key| !is_extension_facet_key(key)).collect()
}

/// The root keys a document models itself (`RESERVED_ROOT_KEYS`), which
/// `facetsRaw` therefore may not hold.
pub const RESERVED_ROOT_KEYS: [&str; 9] =
    ["type", "title", "description", "resource", "tags", "view", "facets", "generated", "verified"];

/// The keys of a `facetsRaw` bucket that are reserved, in written order
/// (`facetsRawKeys`). Empty is valid.
pub fn facets_raw_keys(raw: &Map) -> Vec<&str> {
    raw.iter().map(|(key, _)| key.as_str()).filter(|key| RESERVED_ROOT_KEYS.contains(key)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Value;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn map(keys: &[&str]) -> Map {
        keys.iter().map(|k| ((*k).to_owned(), Value::Null)).collect()
    }

    #[test]
    fn an_actor_is_one_line_with_no_edge_whitespace_as_javascript_trims_it() {
        for ok in ["human:alice", "a/1", "a b", "\u{85}x", "team:ga4-docs"] {
            assert!(okf_actor(ok), "{ok:?}");
        }
        for bad in [" a", "a ", "a\nb", "a\rb", "\u{feff}a", "a\u{2028}", "\u{a0}", "\tx"] {
            assert!(!okf_actor(bad), "{bad:?}");
        }
        for space in [
            '\u{1680}', '\u{2000}', '\u{2005}', '\u{200a}', '\u{2029}', '\u{202f}', '\u{205f}',
            '\u{3000}',
        ] {
            assert!(!okf_actor(&format!("{space}x")), "{space:?}");
            assert!(!okf_actor(&format!("x{space}")), "{space:?}");
        }
    }

    #[test]
    fn a_timestamp_is_an_iso_datetime_with_an_explicit_offset() {
        for ok in [
            "2026-11-09T12:00:00Z",
            "2026-11-09T12:00:00.5Z",
            "2026-11-09T12:00:00.123456+09:00",
            "2026-11-09T12:00:00-05:30",
        ] {
            assert!(okf_timestamp(ok), "{ok}");
        }
        for bad in [
            "",
            "2026-11-09",
            "2026-11-09T12:00:00",
            "2026-11-09T12:00:00z",
            "2026-11-09T12:00:00.Z",
            "2026-11-09T12:00:00ZZ",
            "2026-11-09T12:00:00+0900",
            "2026-11-09T12:00:00+09:0",
            "2026-11-09T12:00:00Z\n",
            "26-11-09T12:00:00Z",
            "2026-11-09 12:00:00Z",
            "2026-11-09T12:00:00.5",
            "2026-1x-09T12:00:00Z",
            "2026-11-09T12:0x:00Z",
            "2026-11-09T12:00:00+09:x0",
            "2026-11-09T1\u{0662}:00:00Z",
        ] {
            assert!(!okf_timestamp(bad), "{bad:?}");
        }
    }

    #[test]
    fn extension_facet_keys_name_the_malformed_keys_in_written_order() {
        assert!(extension_facet_keys(&map(&["visual.shape/v0", "a-b.c-d/v12"])).is_empty());
        let bad = [
            "visual",
            "Visual.shape/v0",
            "v.s/v",
            "v.s/vx",
            "v.s/",
            "1v.s/v0",
            "v.1s/v0",
            "v.s/v0x",
        ];
        assert_eq!(extension_facet_keys(&map(&bad)), bad);
        assert_eq!(extension_facet_keys(&map(&["z", "visual.shape/v0", "a"])), ["z", "a"]);
    }

    #[test]
    fn a_reserved_root_key_is_named_wherever_it_sits_in_facets_raw() {
        assert!(facets_raw_keys(&map(&["x-extra", "Type", "other"])).is_empty());
        assert_eq!(facets_raw_keys(&map(&["a", "tags", "b", "verified"])), ["tags", "verified"]);
        for key in RESERVED_ROOT_KEYS {
            assert_eq!(facets_raw_keys(&map(&[key])), [key]);
        }
    }
}
