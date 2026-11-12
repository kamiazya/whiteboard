//! Break opportunities per UAX #14 under CSS `line-break: strict`, as the
//! segments a text divides into, ported from `uax-segments.ts`.
//!
//! Each segment carries its own trailing whitespace. This is a reading of
//! [`segment_ends`](crate::linebreak::segment_ends), the one producer of "where
//! may a line break": the wrapper's granularity ladder and the inline junction
//! both ask it through here, so the two cannot disagree about it.

use std::ops::Range;

use crate::linebreak::segment_ends;

/// The UTF-16 range of every segment of `text`, none for the empty text. A
/// segment never splits a surrogate pair; a lone surrogate stands as one unit.
#[must_use]
pub fn uax_segment_ranges(text: &[u16]) -> Vec<Range<usize>> {
    let mut start = 0_usize;
    segment_ends(text)
        .into_iter()
        .map(|end| {
            let range = start..end;
            start = end;
            range
        })
        .collect()
}

/// The segments of `text` as slices of it, concatenating back to `text`.
#[must_use]
pub fn uax_segments(text: &str) -> Vec<&str> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut ends = segment_ends(&units).into_iter().peekable();
    let mut segments = Vec::new();
    let mut start = 0_usize;
    let mut unit = 0_usize;
    for (at, ch) in text.char_indices() {
        unit = unit.saturating_add(ch.len_utf16());
        let byte_end = at.saturating_add(ch.len_utf8());
        if ends.next_if_eq(&unit).is_some() {
            segments.extend(text.get(start..byte_end));
            start = byte_end;
        }
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_segment_carries_its_trailing_space() {
        assert_eq!(uax_segments("ab cd"), ["ab ", "cd"]);
    }

    #[test]
    fn a_closing_character_stays_with_what_precedes_it() {
        assert_eq!(uax_segments("日本。語"), ["日", "本。", "語"]);
    }

    #[test]
    fn an_astral_code_point_is_one_unit_of_the_text_and_two_of_the_ranges() {
        assert_eq!(uax_segments("𠀋𩸽"), ["𠀋", "𩸽"]);
        let units: Vec<u16> = "𠀋𩸽".encode_utf16().collect();
        assert_eq!(uax_segment_ranges(&units), [0..2, 2..4]);
    }

    #[test]
    fn nothing_has_no_segments() {
        assert!(uax_segments("").is_empty());
        assert!(uax_segment_ranges(&[]).is_empty());
    }

    #[test]
    fn a_lone_surrogate_is_a_unit_of_its_own() {
        assert_eq!(uax_segment_ranges(&[0x61, 0xd800, 0x62]), [0..1, 1..2, 2..3]);
    }
}
