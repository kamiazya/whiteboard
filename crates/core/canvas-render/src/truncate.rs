//! Cutting a text to a width between graphemes, ported from `truncate.ts`.

use std::str::CharIndices;

use unicode_segmentation::{GraphemeIndices, UnicodeSegmentation};

use crate::longest_fit::longest_fitting_count;
use crate::measure::{FontDescriptor, Measure, clamp_advance};

/// What [`fit_to_width`] kept of a text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FittedText<'a> {
    pub text: &'a str,
    /// Something was DROPPED: `text` is a strict prefix of the input.
    pub truncated: bool,
    /// What is RETURNED is still wider than `max_width`: the never-empty rule
    /// kept one grapheme that does not fit, because nothing narrower exists.
    ///
    /// Separate from `truncated` because the two readers of "this did not fit"
    /// want opposite halves of it: the SVG fade and the scene digest mean
    /// "there is more of this than you can see", while a snapshot's `overflows`
    /// means "this does not fit its box". A single grapheme too wide for its box
    /// satisfies the second and not the first.
    pub overflows: bool,
}

/// Could this text hold a cluster at all?
///
/// Nothing below U+0300 joins the character before it, with exactly one
/// exception, LF after CR, which is why CR is named beside the threshold. CR
/// rather than LF, because a lone LF is ordinary in a body while a lone CR is
/// not, so keying on the leader leaves LF-only text on the cheap path.
///
/// Only one direction of error exists: answering `true` for text that holds no
/// cluster costs a slower walk over the same units, while answering `false` for
/// text that holds one cuts it in half. So the threshold may only ever be made
/// MORE eager. Deliberately coarse: it sends Japanese, Chinese and Korean down
/// the segmenter path, since only the segmenter can say whether a string HAS a
/// cluster, which is the work being avoided.
fn may_cluster(text: &str) -> bool {
    text.chars().any(|c| u32::from(c) >= 0x0300 || c == '\r')
}

/// The units a cut may fall between, as the byte offset each one ends at,
/// iterated LAZILY: the walk stops at the first unit that does not fit, and
/// segmenting the tail past it is work nobody reads.
enum Units<'a> {
    CodePoints(CharIndices<'a>),
    Graphemes(GraphemeIndices<'a>),
}

impl Units<'_> {
    fn next_end(&mut self) -> Option<usize> {
        match self {
            Self::CodePoints(it) => it.next().map(|(at, c)| at.saturating_add(c.len_utf8())),
            Self::Graphemes(it) => it.next().map(|(at, g)| at.saturating_add(g.len())),
        }
    }
}

/// The ends pulled so far, `ends[n]` being where the first `n` units stop.
struct Cuts<'a> {
    units: Units<'a>,
    ends: Vec<usize>,
}

impl<'a> Cuts<'a> {
    fn new(text: &'a str) -> Self {
        let units = if may_cluster(text) {
            Units::Graphemes(text.grapheme_indices(true))
        } else {
            Units::CodePoints(text.char_indices())
        };
        Self { units, ends: vec![0] }
    }

    /// Where the first `count` units end, or `None` past the last unit.
    /// Stopping at `count` is laziness, not correctness: segmenting the whole
    /// text up front yields the same ends.
    fn end_of(&mut self, count: usize) -> Option<usize> {
        while self.ends.len() <= count {
            let Some(end) = self.units.next_end() else { break };
            self.ends.push(end);
        }
        self.ends.get(count).copied()
    }
}

/// The longest prefix of `text` that fits `max_width`, plus whether anything was
/// dropped and whether what came back still does not fit. Used wherever the text
/// CANNOT wrap (a node label, an atomic run), so cutting is the only way left to
/// keep it inside its box.
///
/// Never returns the empty string for non-empty input: one glyph over the edge
/// still says a label is there, and nothing at all does not. That glyph is a
/// whole GRAPHEME: a lone 👨 is not a narrower family emoji, it is a different
/// picture. A non-finite or non-positive `max_width` means "no width to fit
/// against" and returns the text unchanged, as layout treats an unusable wrap
/// width everywhere else.
///
/// The prefix is found by [`longest_fitting_count`], not a unit-by-unit scan:
/// the scan re-measured the whole kept prefix once per unit, which is quadratic
/// in what fits.
///
/// A `&str` holds no lone surrogate, which a JS string can; the TypeScript's
/// answer for one is not reproduced here.
pub fn fit_to_width<'a>(
    text: &'a str,
    font: &FontDescriptor,
    measure: &(impl Measure + ?Sized),
    max_width: f64,
) -> FittedText<'a> {
    let whole = FittedText { text, truncated: false, overflows: false };
    if !max_width.is_finite() || max_width <= 0.0 {
        return whole;
    }
    if clamp_advance(measure.advance_width(text, font)) <= max_width {
        return whole;
    }
    let mut cuts = Cuts::new(text);
    // The whole text was measured above and does not fit, so a probe reaching
    // it is answered without measuring it again.
    let fits = |count: usize| {
        let Some(end) = cuts.end_of(count) else { return false };
        if end >= text.len() {
            return false;
        }
        text.get(..end)
            .is_some_and(|prefix| clamp_advance(measure.advance_width(prefix, font)) <= max_width)
    };
    // The limit is the UTF-16 length, as the TypeScript's `text.length`: it
    // bounds the gallop's probes, so it decides which prefixes get measured.
    let count = longest_fitting_count(fits, text.encode_utf16().count(), 1);
    let fitted = cuts.ends.get(count).and_then(|&end| text.get(..end)).unwrap_or_default();
    let kept = if fitted.is_empty() {
        cuts.end_of(1).and_then(|end| text.get(..end)).unwrap_or_default()
    } else {
        fitted
    };
    FittedText { text: kept, truncated: kept.len() != text.len(), overflows: fitted.is_empty() }
}
