//! Where a line may be cut, carried ACROSS inline nodes, ported from
//! `inline-junction.ts`.
//!
//! The wrapper decides breaks one inline node at a time, so without this the
//! junction between two of them is a break opportunity by accident: `` `code` ``
//! followed by `。`, or `**強調**` followed by it, put a closing character at the
//! start of a line however firmly UAX #14 forbids it. The junction is asked of
//! [`uax_segment_ranges`], never of a character table of this crate's own:
//! deciding where a line may break is delegated to UAX #14, and the boundary
//! between two inline nodes is the same question as the boundary inside one.
//!
//! The TypeScript closes over the wrapper's run list and cursor; here the
//! wrapper owns both, so every method is handed the ones it reads or moves.

use whiteboard_scene::{RunPaint, TextRunNode};

use crate::uax_segments::uax_segment_ranges;

/// U+FFFC OBJECT REPLACEMENT CHARACTER: what a run that PAINTS rather than
/// spells (an icon, an alt-less image) answers when a break decision is taken
/// against it. Its UAX #14 class is CB, which makes the answer right in both
/// directions: `。` may still not open a line after it (LB13 outranks CB), and
/// an ordinary character may. The placeholder these runs carry is an EM SPACE,
/// so asking UAX #14 about the text would say a picture is a space and a break
/// after a space is always allowed.
const OBJECT_REPLACEMENT: char = '\u{FFFC}';

/// ECMAScript `\s`, which is not Unicode `White_Space`: it takes U+FEFF and
/// leaves U+0085 out.
fn is_js_space(c: char) -> bool {
    matches!(
        u32::from(c),
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

/// `None` for whitespace and for nothing: a break is already allowed there.
fn edge(c: Option<char>) -> Option<char> {
    c.filter(|&c| !is_js_space(c))
}

/// The character a break decision on this run's left edge is taken against.
/// `None` means a break is already allowed there.
#[must_use]
pub fn head_character(text: &str, paints: Option<&RunPaint>) -> Option<char> {
    if paints.is_some() {
        return Some(OBJECT_REPLACEMENT);
    }
    edge(text.chars().next())
}

/// The same, on its right edge.
#[must_use]
pub fn tail_character(text: &str, paints: Option<&RunPaint>) -> Option<char> {
    if paints.is_some() {
        return Some(OBJECT_REPLACEMENT);
    }
    edge(text.chars().next_back())
}

/// The wrapper's horizontal cursor and line counter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineCursor {
    pub x: f64,
    pub index: usize,
}

/// State: `tail` is the character the next break decision is taken against
/// (`None` once a break is already allowed here); `cluster_run`/`cluster_x` are
/// the first run of the unbreakable stretch ending at that character and the x
/// it began at, which is what a forbidden break moves down instead of splitting;
/// `line_run` is the first run on the current line, so a stretch that IS the
/// whole line is recognised as having nowhere to go.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InlineJunction {
    tail: Option<char>,
    cluster_run: usize,
    cluster_x: f64,
    line_run: usize,
    line_height_px: f64,
}

/// A junction at the start of a paragraph, where a break is allowed.
#[must_use]
pub const fn create_inline_junction(line_height_px: f64) -> InlineJunction {
    InlineJunction { tail: None, cluster_run: 0, cluster_x: 0.0, line_run: 0, line_height_px }
}

impl InlineJunction {
    /// True when a line may be cut between what is placed and `head`.
    #[must_use]
    pub fn breakable_before(&self, head: Option<char>) -> bool {
        let (Some(tail), Some(head)) = (self.tail, head) else { return true };
        let mut pair = String::new();
        pair.push(tail);
        pair.push(head);
        let units: Vec<u16> = pair.encode_utf16().collect();
        uax_segment_ranges(&units).len() > 1
    }

    /// Record that a break is allowed at the cursor, starting a new cluster.
    pub fn allow_break_here(&mut self, runs: &[TextRunNode], line: &LineCursor) {
        self.tail = None;
        self.cluster_run = runs.len();
        self.cluster_x = line.x;
    }

    /// Record what a run just placed leaves the cursor sitting against.
    pub fn placed(
        &mut self,
        text: &str,
        paints: Option<&RunPaint>,
        runs: &[TextRunNode],
        line: &LineCursor,
    ) {
        match tail_character(text, paints) {
            None => self.allow_break_here(runs, line),
            next => self.tail = next,
        }
    }

    /// Move to the next line: the cursor, the cluster and the tail all reset.
    pub fn start_line(&mut self, runs: &[TextRunNode], line: &mut LineCursor) {
        line.x = 0.0;
        line.index = line.index.saturating_add(1);
        self.line_run = runs.len();
        self.allow_break_here(runs, line);
    }

    /// Move the stretch that the incoming text may not be parted from onto a
    /// line of its own, so the text can follow it there. Answers false when that
    /// stretch is the whole line: there is nowhere to move it to, and the
    /// caller's ordinary break stands rather than looping.
    pub fn relocate_cluster(&mut self, runs: &mut [TextRunNode], line: &mut LineCursor) -> bool {
        if self.cluster_run <= self.line_run {
            return false;
        }
        let dx = self.cluster_x;
        for run in runs.iter_mut().skip(self.cluster_run) {
            run.bbox.x -= dx;
            run.bbox.y += self.line_height_px;
        }
        line.x -= dx;
        line.index = line.index.saturating_add(1);
        self.line_run = self.cluster_run;
        self.cluster_x = 0.0;
        true
    }
}
