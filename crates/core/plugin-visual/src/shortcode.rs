//! The two shortcode vocabularies a drawn body reads: `:rocket:` read as its
//! character (`expandEmojiShortcodes`) and `:icon-star:` drawn as the vendored
//! icon (`iconShortcodeRanges`).
//!
//! A candidate is what the TypeScript's global regex finds, `:[a-z0-9_]+:` and
//! `:icon-[a-z0-9-]+:` respectively, scanned left to right without overlap
//! whether or not its name resolves: what protects prose such as `10:30:` is
//! the lookup failing and the text standing, and a failed candidate still
//! consumes its closing colon. Every byte a candidate holds is ASCII, so the
//! scan runs over UTF-8 and only the ranges an icon answers are counted in
//! UTF-16 code units, as the typesetter is handed them.

use std::sync::OnceLock;

use whiteboard_model::Value;
use whiteboard_model::json;

/// The emoji table, `shortcode<TAB>character` per catalog row in catalog order,
/// generated beside the catalog the TypeScript reads and held to it there.
const EMOJI_SHORTCODES: &str =
    include_str!("../../../../packages/plugin-visual/src/emoji/emoji-shortcodes.tsv");

/// One icon shortcode a text holds: the UTF-16 range of the colon pair and the
/// vendored icon's name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconShortcodeRange {
    pub from: usize,
    pub to: usize,
    pub name: String,
}

/// One candidate: its byte range in the text, and the name between its colons.
struct Candidate<'t> {
    from: usize,
    to: usize,
    name: &'t str,
}

/// The name a candidate starting at the head of `rest` holds: `prefix`, then a
/// non-empty run of `allowed` bytes closed by a colon. A colon is never
/// allowed, so the run is exactly what precedes the first colon.
fn candidate_name<'t>(rest: &'t str, prefix: &str, allowed: fn(u8) -> bool) -> Option<&'t str> {
    let (name, _) = rest.strip_prefix(prefix)?.split_once(':')?;
    (!name.is_empty() && name.bytes().all(allowed)).then_some(name)
}

/// Every candidate in `text`, leftmost first and without overlap.
fn candidates<'t>(
    text: &'t str,
    prefix: &'static str,
    allowed: fn(u8) -> bool,
) -> Vec<Candidate<'t>> {
    let mut found = Vec::new();
    let mut resume = 0_usize;
    for (from, _) in text.match_indices(':') {
        if from < resume {
            continue;
        }
        let Some(name) = text.get(from..).and_then(|rest| candidate_name(rest, prefix, allowed))
        else {
            continue;
        };
        let to = from.saturating_add(prefix.len()).saturating_add(name.len()).saturating_add(1);
        found.push(Candidate { from, to, name });
        resume = to;
    }
    found
}

const fn emoji_byte(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'
}

const fn icon_byte(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
}

/// The character the shortcode `wanted` names in `table`: its first row, as
/// the TypeScript's map keeps the first one it meets.
///
/// ponytail: a linear walk over ~1.9k rows per candidate; an index built once
/// if colon-dense bodies ever show in a profile.
fn emoji_in<'t>(table: &'t str, wanted: &str) -> Option<&'t str> {
    table.lines().find_map(|row| {
        let (name, char) = row.split_once('\t')?;
        (name == wanted).then_some(char)
    })
}

fn expand_with(table: &str, text: &str) -> String {
    let mut expanded = String::with_capacity(text.len());
    let mut at = 0_usize;
    for candidate in candidates(text, ":", emoji_byte) {
        let Some(char) = emoji_in(table, candidate.name) else { continue };
        expanded.push_str(text.get(at..candidate.from).unwrap_or_default());
        expanded.push_str(char);
        at = candidate.to;
    }
    expanded.push_str(text.get(at..).unwrap_or_default());
    expanded
}

/// `expandEmojiShortcodes`: every `:name:` naming an emoji replaced by its
/// character, everything else as written.
#[must_use]
pub fn expand_emoji_shortcodes(text: &str) -> String {
    expand_with(EMOJI_SHORTCODES, text)
}

/// The names `table` (an icon asset file) holds, whatever each entry is: the
/// nameable set is the vendored file's keys (`BUILT_IN_ICON_NAMES`), not every
/// icon the plugin registers.
fn icon_names(table: &str) -> Vec<String> {
    match json::parse(table) {
        Ok(Value::Map(entries)) => entries.into_iter().map(|(name, _)| name).collect(),
        _ => Vec::new(),
    }
}

/// The vendored file's names, parsed once: the file is a constant, and parsing
/// it is the whole of a call's cost.
fn lucide_names() -> &'static [String] {
    static NAMES: OnceLock<Vec<String>> = OnceLock::new();
    NAMES.get_or_init(|| icon_names(crate::render::LUCIDE))
}

fn icon_ranges_with(names: &[String], text: &str) -> Vec<IconShortcodeRange> {
    let found = candidates(text, ":icon-", icon_byte);
    if found.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    // Byte offsets rise through the candidates, so one walk counts the units.
    let (mut byte, mut unit) = (0_usize, 0_usize);
    let mut units_to = |to: usize| {
        let step = text.get(byte..to).map_or(0, |part| part.encode_utf16().count());
        unit = unit.saturating_add(step);
        byte = to;
        unit
    };
    for candidate in found {
        let from = units_to(candidate.from);
        let to = units_to(candidate.to);
        if names.iter().any(|name| name == candidate.name) {
            ranges.push(IconShortcodeRange { from, to, name: candidate.name.to_owned() });
        }
    }
    ranges
}

/// `iconShortcodeRanges`: every `:icon-name:` naming a vendored icon, in
/// order, as UTF-16 ranges of the text.
#[must_use]
pub fn icon_shortcode_ranges(text: &str) -> Vec<IconShortcodeRange> {
    icon_ranges_with(lucide_names(), text)
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

    #[test]
    fn the_first_row_of_a_shortcode_answers_it() {
        let table = "junk\nstar\tA\nstar\tB\nmoon\tC\n";
        assert_eq!(expand_with(table, ":star: :moon: :sun: :junk:"), "A C :sun: :junk:");
    }

    #[test]
    fn an_icon_name_is_a_key_of_the_vendored_file_whatever_its_entry() {
        let table = r#"{"odd": 1, "star": {"geometry": []}}"#;
        let names = |text| {
            icon_ranges_with(&icon_names(table), text)
                .into_iter()
                .map(|r| r.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(names(":icon-odd: :icon-star: :icon-sun:"), ["odd", "star"]);
        assert!(icon_ranges_with(&icon_names("[]"), ":icon-star:").is_empty());
    }

    #[test]
    fn a_failed_candidate_consumes_its_closing_colon() {
        assert_eq!(expand_emoji_shortcodes(":not_one:rocket:"), ":not_one:rocket:");
        assert_eq!(expand_emoji_shortcodes(":rocket::fire:"), "🚀🔥");
    }

    #[test]
    fn icon_offsets_count_utf16_code_units() {
        let ranges = icon_shortcode_ranges("😀:icon-star:é:icon-lock:");
        let spans: Vec<(usize, usize)> = ranges.iter().map(|r| (r.from, r.to)).collect();
        assert_eq!(spans, [(2, 13), (14, 25)]);
    }
}
