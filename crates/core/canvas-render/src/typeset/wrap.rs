//! Packing a chunk of text onto successive lines, ported from `wrapAndPush`.
//!
//! A chunk is packed greedily at the break opportunities `break_segments`
//! offers, and everything landing on one line is emitted as ONE run: a run per
//! break opportunity would also fit, and would multiply the SVG's `<text>`
//! elements by the character count of every CJK paragraph. How many segments
//! join a line is SEARCHED, first guessing the previous line's count, because a
//! scan re-measuring the line per segment is quadratic in its length. A segment
//! too wide for a line of its own steps down one level of granularity at a time
//! (phrase, UAX #14 segment, code point); only a single code point wider than
//! the width is left to overflow, since there is nothing below it to split and
//! dropping it would be worse.

use crate::inline_junction::head_character;
use crate::longest_fit::longest_fitting_count;

use super::options::{Style, measure_run_width};
use super::phrasing::{Extra, InlineLayout};
use super::segments::{break_segments, finer_segments};
use super::text::{trim_end, trim_start};

/// Rounds the packing loop is allowed per byte of text. A round either advances
/// past a segment or changes state a segment at most a few times can change (it
/// moves down a line, is trimmed, is split once per level), so this is a bound
/// the loop never reaches; it exists so the loop's termination is a property of
/// its shape rather than of its arithmetic.
const ROUNDS_PER_BYTE: usize = 8;

struct Wrap<'e> {
    /// An over-wide segment is replaced IN PLACE by its finer pieces, and one
    /// that did not fit is retried at the start of the next line.
    segments: Vec<String>,
    buffered: String,
    last_fitting: usize,
    extra: &'e Extra,
    style: Style,
}

impl InlineLayout<'_> {
    pub(super) fn wrap_and_push(&mut self, text: &str, extra: &Extra, style: Style) {
        let mut wrap = Wrap {
            segments: break_segments(text),
            buffered: String::new(),
            last_fitting: 1,
            extra,
            style,
        };
        let rounds = text.len().saturating_mul(ROUNDS_PER_BYTE).saturating_add(16);
        let mut index = 0_usize;
        for _ in 0..rounds {
            if index >= wrap.segments.len() {
                break;
            }
            index = index.saturating_add(wrap.place_segments(self, index));
        }
        let rest = wrap.segments.get(index..).unwrap_or_default().concat();
        wrap.buffered.push_str(&rest);
        wrap.flush(self);
    }
}

impl Wrap<'_> {
    /// What is buffered plus the next `count` segments from `start`.
    fn joined(&self, start: usize, count: usize) -> String {
        let end = start.saturating_add(count);
        let more = self.segments.get(start..end).unwrap_or_default().concat();
        format!("{}{more}", self.buffered)
    }

    /// Trailing whitespace is a cursor advance, never glyphs: XML strips a run's
    /// boundary whitespace, so a run carrying it would paint a space-width left
    /// of where layout measured it.
    fn flush(&mut self, layout: &mut InlineLayout<'_>) {
        let painted = trim_end(&self.buffered);
        if !painted.is_empty() {
            layout.push_run(painted, self.extra, self.style, layout.body_face());
        }
        self.buffered.clear();
    }

    /// True once the preceding stretch has been MOVED down to the next line with
    /// this segment: that only happens when nothing of this node has landed yet
    /// and the segment may not open a line, and the stretch it is joined to comes
    /// down with it rather than the pair being split across the break. The order
    /// of the conjuncts is what stops the move running when the situation does
    /// not call for it.
    fn cluster_came_down(&self, layout: &mut InlineLayout<'_>, segment: &str) -> bool {
        let head = head_character(segment, self.extra.paints.as_ref());
        self.buffered.is_empty()
            && layout.line.x > 0.0
            && !layout.junction.breakable_before(head)
            && layout.junction.relocate_cluster(&mut layout.runs, &mut layout.line)
    }

    /// The first segment that did not fit: true once it is consumed.
    fn place_overflowing(&mut self, layout: &mut InlineLayout<'_>, index: usize) -> bool {
        let segment = self.segments.get(index).cloned().unwrap_or_default();
        // Retried on the new line, where it either fits or falls through to the
        // ordinary break below.
        if self.cluster_came_down(layout, &segment) {
            return false;
        }
        if !self.buffered.is_empty() || layout.line.x > 0.0 {
            self.flush(layout);
            layout.junction.start_line(&layout.runs, &mut layout.line);
            // A boundary space at the start of a line is dropped, not advanced.
            if let Some(slot) = self.segments.get_mut(index) {
                trim_start(&segment).clone_into(slot);
            }
            return false;
        }
        // Alone at the start of a line and still too wide: step down one level.
        // What cannot be stepped down is irreducible and is left to overflow.
        if let Some(finer) = finer_segments(&segment) {
            self.segments.splice(index..index.saturating_add(1), finer);
            return false;
        }
        self.buffered.push_str(&segment);
        true
    }

    /// Place every segment from `start` that fits, answering how many were.
    fn place_segments(&mut self, layout: &mut InlineLayout<'_>, start: usize) -> usize {
        let limit = self.segments.len().saturating_sub(start);
        let fitting = {
            let (this, lay) = (&*self, &*layout);
            longest_fitting_count(
                |count| {
                    let width = measure_run_width(
                        lay.opts,
                        trim_end(&this.joined(start, count)),
                        lay.font_size,
                        this.style,
                    );
                    lay.line.x + width <= lay.opts.max_width
                },
                limit,
                this.last_fitting,
            )
        };
        if fitting > 0 {
            self.last_fitting = fitting;
        }
        self.buffered = self.joined(start, fitting);
        let index = start.saturating_add(fitting);
        // The search measured `index` already, and it does not fit.
        if index >= self.segments.len() || !self.place_overflowing(layout, index) {
            return fitting;
        }
        fitting.saturating_add(1)
    }
}
