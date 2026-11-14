//! The reference scanner as a property: from any cursor, `find_next_reference`
//! answers the leftmost `[[target]]`, `[[target|alias]]` or `![[…]]` the
//! grammar admits, as a direct reading of the grammar at each opener finds it.

use whiteboard_codec::references::{ReferenceMatch, find_next_reference};
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert_eq};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const TOKENS: &[&str] =
    &["[[", "]]", "[", "]", "!", "|", "#", "a", "\u{e9}", "\u{1f600}", " ", "\n"];

fn text() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(TOKENS), 0..40).prop_map(|t| t.concat())
}

/// The grammar read at the opener `[[` starting at byte `open`, quadratically:
/// a target of anything but `]` and `|`, not empty and not opening with `#`,
/// then `]]`, or `|`, an alias of anything but `]`, and `]]`.
fn at_opener(value: &str, open: usize) -> Option<ReferenceMatch<'_>> {
    let content = open + 2;
    let target_len = value[content..].find([']', '|']).unwrap_or(value.len() - content);
    let raw = &value[content..content + target_len];
    if raw.is_empty() || raw.starts_with('#') {
        return None;
    }
    let rest = &value[content + target_len..];
    let (alias, end) = if rest.starts_with("]]") {
        (None, content + target_len + 2)
    } else {
        let after = rest.strip_prefix('|')?;
        let alias_len = after.find(']')?;
        if !after[alias_len..].starts_with("]]") {
            return None;
        }
        (Some(&after[..alias_len]), content + target_len + 1 + alias_len + 2)
    };
    let (target, fragment) = match raw.split_once('#') {
        Some((target, fragment)) => (target, Some(fragment).filter(|f| !f.is_empty())),
        None => (raw, None),
    };
    let is_embed = open > 0 && value.as_bytes()[open - 1] == b'!';
    let index = if is_embed { open - 1 } else { open };
    Some(ReferenceMatch { index, full: &value[index..end], is_embed, target, alias, fragment })
}

fn naive(value: &str, cursor: usize) -> Option<ReferenceMatch<'_>> {
    (cursor..value.len())
        .filter(|&o| value.get(o..).is_some_and(|s| s.starts_with("[[")))
        .find_map(|o| at_opener(value, o))
}

#[test]
fn the_scanner_finds_what_the_grammar_reads_from_every_cursor() {
    let found = Floor::new("a text holding a reference");
    let aliased = Floor::new("a text holding an aliased reference");
    check(text(), None, |value| {
        let first = naive(&value, 0);
        found.draw(first.is_some());
        aliased.draw(first.as_ref().is_some_and(|m| m.alias.is_some()));
        for cursor in (0..=value.len()).filter(|&c| value.is_char_boundary(c)) {
            prop_assert_eq!(
                find_next_reference(&value, cursor),
                naive(&value, cursor),
                "{:?}",
                value
            );
        }
        Ok(())
    });
    found.assert(40);
    aliased.assert(5);
}
