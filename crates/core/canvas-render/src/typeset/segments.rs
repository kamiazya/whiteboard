//! Where a line may break in a stretch of text: the coarsest candidates the
//! wrapper takes first, and the finer levels it steps down to when one does not
//! fit, ported from `breakSegments`, `finerSegments` and `splitFiner`.

use crate::budoux;
use crate::uax_segments::uax_segments;

/// Hiragana and katakana, the scripts the bundled `BudouX` model is trained on.
fn has_kana(text: &str) -> bool {
    text.chars().any(|c| ('\u{3040}'..='\u{30ff}').contains(&c))
}

/// Phrases where the text is Japanese, UAX #14 segments otherwise. Chinese and
/// Korean stay on UAX #14: the bundled model is Japanese alone.
///
/// A phrase boundary that would fall between the two halves of a surrogate
/// pair is not taken: the model reads UTF-16 units and may name one, which a
/// JavaScript string can hold as half a pair and a `&str` cannot.
pub(super) fn break_segments(text: &str) -> Vec<String> {
    if !has_kana(text) {
        return uax_segments(text).into_iter().map(str::to_owned).collect();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut segments = Vec::new();
    let mut start = 0_usize;
    for boundary in budoux::parse_boundaries(&units).into_iter().chain([units.len()]) {
        if splits_pair(&units, boundary) {
            continue;
        }
        if let Ok(phrase) = String::from_utf16(units.get(start..boundary).unwrap_or_default())
            && !phrase.is_empty()
        {
            segments.push(phrase);
        }
        start = boundary;
    }
    segments
}

/// True when `boundary` falls inside a surrogate pair.
fn splits_pair(units: &[u16], boundary: usize) -> bool {
    let before = boundary.checked_sub(1).and_then(|at| units.get(at));
    matches!((before, units.get(boundary)), (Some(0xd800..=0xdbff), Some(0xdc00..=0xdfff)))
}

/// One level finer than `segment`: its UAX #14 segments, or, when UAX #14
/// already calls it atomic (a long identifier, a URL with no separator left),
/// its code points, which are the floor. `None` when there is no finer level.
pub(super) fn finer_segments(segment: &str) -> Option<Vec<String>> {
    let finer: Vec<String> = uax_segments(segment).into_iter().map(str::to_owned).collect();
    if finer.len() > 1 {
        return Some(finer);
    }
    let points: Vec<String> = segment.chars().map(String::from).collect();
    (points.len() > 1).then_some(points)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn latin_text_breaks_at_uax_14_opportunities() {
        assert_eq!(break_segments("ab cd"), ["ab ", "cd"]);
    }

    #[test]
    fn kana_text_breaks_at_phrases_that_concatenate_back() {
        let text = "今日は天気がいいので、散歩に行きましょう。";
        let phrases = break_segments(text);
        assert!(phrases.len() > 1);
        assert_eq!(phrases.concat(), text);
    }

    #[test]
    fn a_boundary_inside_a_surrogate_pair_is_not_taken() {
        let units: Vec<u16> = "a😀".encode_utf16().collect();
        assert!(splits_pair(&units, 2));
        assert!(!splits_pair(&units, 1));
        assert!(!splits_pair(&units, 3));
        assert!(!splits_pair(&units, 0));
    }

    #[test]
    fn a_segment_steps_down_to_uax_segments_then_code_points() {
        assert_eq!(finer_segments("ab cd"), Some(vec!["ab ".to_owned(), "cd".to_owned()]));
        assert_eq!(
            finer_segments("abc"),
            Some(vec!["a".to_owned(), "b".to_owned(), "c".to_owned()])
        );
        assert_eq!(finer_segments("a"), None);
        assert_eq!(finer_segments(""), None);
    }
}
