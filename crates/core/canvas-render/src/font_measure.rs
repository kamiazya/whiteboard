//! A measurer over font tables, ported from the Node measurer
//! (`packages/mcp-server/src/server/export/measure-text.ts`, opentype.js over
//! the vendored Roboto).
//!
//! The advance is the sum of each glyph's `hmtx` advance, unkerned and
//! unhinted, scaled by `(1 / unitsPerEm) * size` and added left to right: the
//! TypeScript's arithmetic in its order, so a double is bit-identical where the
//! same face answers. A code point whose glyph index is 0 (`.notdef`) is
//! estimated by [`estimate_advance`] instead of measured, because the face
//! does not carry it; the face is asked by glyph index and never by comparing
//! advances, since a narrow glyph can share `.notdef`'s width.
//!
//! The vertical metrics are the `hhea` table's, which is the table opentype.js
//! reads, never OS/2's typographic ones.
//!
//! Two things the TypeScript does that this does not, and a third it does that
//! this repeats:
//!
//! - opentype.js applies the face's `GSUB` `ccmp` and `liga` lookups before it
//!   sums, so a base glyph that the face replaces when a mark follows (an `i`
//!   under U+0307) is measured as the replacement there. Here each code point
//!   is its own glyph. Bold, italic and regular Roboto differ from the plain
//!   sum only for such sequences. This is a TOLERATED gap, not a bit-exact
//!   one: `font-measure.jsonl` classes those records `substituted`, and the
//!   replay holds them to a tenth of an em and fails one the port reproduces
//!   exactly, so the entry cannot outlive the gap.
//! - the family a descriptor NAMES wins, then the measurer's first family;
//!   `FontDescriptor::fallback_chain` is not consulted, as in the TypeScript,
//!   whose CSS chains match no loaded face.
//! - a run longer than 64 UTF-16 units is measured in segments whose sums are
//!   added ([`carried_run`](FontTableMeasurer)), which moves the last bits;
//!   the cuts and the additions are ported, so those records are exact.

use crate::constant_ratio::{estimate_advance, estimate_vertical};
use crate::measure::{FontDescriptor, FontStyle, Measure, VerticalMetrics, clamp_advance};
use crate::segment_joins::joins_preceding;
use crate::sfnt::{Sfnt, SfntError};

/// The weight at which CSS selects the bold face.
const BOLD_FROM: f64 = 600.0;

/// Code points per segment of a long run, and the ceiling on a segment where no
/// cut is safe; opentype.js is quadratic in the run it is handed, so the
/// TypeScript bounds it, and the additions' order is part of the answer.
const SEGMENT_CODE_POINTS: usize = 64;
const SEGMENT_CODE_POINTS_MAX: usize = 256;

/// The bytes did not parse as a font, and why.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FontError(pub SfntError);

impl core::fmt::Display for FontError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "the bytes are not a font this measurer can read: {}", self.0)
    }
}

impl core::error::Error for FontError {}

/// One face and the numbers read from it once.
#[derive(Clone)]
struct Loaded<'a> {
    face: Sfnt<'a>,
    units_per_em: f64,
}

impl Loaded<'_> {
    fn carries(&self, ch: char) -> bool {
        self.face.glyph_index(ch) != 0
    }

    /// The summed advance of code points all carried by the face.
    fn run_advance(&self, run: &str, size_px: f64) -> f64 {
        let scale = 1.0 / self.units_per_em * size_px;
        let mut x = 0.0_f64;
        for ch in run.chars() {
            let units = f64::from(self.face.advance(self.face.glyph_index(ch)));
            if units != 0.0 {
                x += units * scale;
            }
        }
        x
    }

    /// A carried run's advance, cut into segments whose sums are added once the
    /// run passes [`SEGMENT_CODE_POINTS`] UTF-16 units, as `measureCarriedRun`
    /// does: the same additions in the same order, so the last bits agree. A
    /// cut is never made before a joining code point (`segment_joins`) until a
    /// segment reaches [`SEGMENT_CODE_POINTS_MAX`].
    fn carried_run(&self, run: &str, size_px: f64) -> f64 {
        if run.encode_utf16().count() <= SEGMENT_CODE_POINTS {
            return self.run_advance(run, size_px);
        }
        let cuts: Vec<(usize, char)> = run.char_indices().collect();
        let mut advance = 0.0_f64;
        let mut start = 0_usize;
        for i in SEGMENT_CODE_POINTS..cuts.len() {
            let length = i.saturating_sub(start);
            if length < SEGMENT_CODE_POINTS {
                continue;
            }
            let Some(&(at, ch)) = cuts.get(i) else { continue };
            if length < SEGMENT_CODE_POINTS_MAX && joins_preceding(ch) {
                continue;
            }
            advance += self.run_advance(slice(run, &cuts, start, at), size_px);
            start = i;
        }
        let tail = cuts.get(start).map_or(run.len(), |&(at, _)| at);
        advance + self.run_advance(run.get(tail..).unwrap_or(""), size_px)
    }

    /// The text's advance with every code point the face lacks estimated.
    fn advance(&self, text: &str, size_px: f64, descriptor_size: f64) -> f64 {
        if text.chars().all(|ch| self.carries(ch)) {
            return self.carried_run(text, size_px);
        }
        let mut advance = 0.0_f64;
        let mut run = String::new();
        for ch in text.chars() {
            if self.carries(ch) {
                run.push(ch);
                continue;
            }
            if !run.is_empty() {
                advance += self.carried_run(&run, size_px);
                run.clear();
            }
            let mut buf = [0_u8; 4];
            advance += estimate_advance(ch.encode_utf8(&mut buf), descriptor_size);
        }
        if !run.is_empty() {
            advance += self.carried_run(&run, size_px);
        }
        advance
    }

    fn vertical(&self, size_px: f64) -> VerticalMetrics {
        let (ascender, descender, line_gap) = self.face.hhea();
        let scale = size_px / self.units_per_em;
        VerticalMetrics {
            ascent: clamp_advance(f64::from(ascender) * scale),
            descent: clamp_advance(f64::from(descender).abs() * scale),
            line_gap: clamp_advance(f64::from(line_gap) * scale),
        }
    }
}

fn slice<'t>(run: &'t str, cuts: &[(usize, char)], start: usize, end: usize) -> &'t str {
    let from = cuts.get(start).map_or(run.len(), |&(at, _)| at);
    run.get(from..end).unwrap_or("")
}

/// The four faces CSS weight and style select among, by the slot that
/// [`face_slot`] picks. A missing slot answers with Regular.
#[derive(Clone, Default)]
struct Family<'a> {
    name: String,
    slots: [Option<Loaded<'a>>; 4],
}

impl<'a> Family<'a> {
    fn face(&self, slot: usize) -> Option<&Loaded<'a>> {
        self.slots.get(slot).and_then(Option::as_ref).or_else(|| self.slots.iter().flatten().next())
    }
}

/// CSS-style face selection: 600 and over is bold. A NaN weight is not.
fn face_slot(bold: bool, style: FontStyle) -> usize {
    match (bold, style) {
        (false, FontStyle::Normal) => 0,
        (true, FontStyle::Normal) => 1,
        (false, FontStyle::Italic) => 2,
        (true, FontStyle::Italic) => 3,
    }
}

fn slot_of(font: &FontDescriptor) -> usize {
    face_slot(font.weight >= BOLD_FROM, font.style)
}

/// Measures text from the font bytes it is given, with no I/O.
///
/// It borrows the bytes, so the root decides where they come from (a file on
/// Node, a fetched asset in a browser). With no face at all it answers as
/// [`ConstantRatioMeasure`](crate::constant_ratio::ConstantRatioMeasure) does,
/// the degraded path the TypeScript takes when its asset is missing.
#[derive(Clone, Default)]
pub struct FontTableMeasurer<'a> {
    families: Vec<Family<'a>>,
}

impl<'a> FontTableMeasurer<'a> {
    #[must_use]
    pub const fn new() -> Self {
        Self { families: Vec::new() }
    }

    /// Adds a face under `family`. The first family added is the one a
    /// descriptor naming no known family is measured in.
    ///
    /// # Errors
    /// [`FontError`] when `data` is not a parseable font. A face already held
    /// in the same slot is replaced.
    pub fn with_face(
        mut self,
        family: &str,
        bold: bool,
        style: FontStyle,
        data: &'a [u8],
    ) -> Result<Self, FontError> {
        let face = Sfnt::parse(data).map_err(FontError)?;
        let units_per_em = f64::from(face.units_per_em());
        let loaded = Loaded { face, units_per_em };
        let slot = face_slot(bold, style);
        let entry = if let Some(i) = self.families.iter().position(|f| f.name == family) {
            self.families.get_mut(i)
        } else {
            self.families.push(Family { name: family.to_owned(), slots: Default::default() });
            self.families.last_mut()
        };
        if let Some(target) = entry.and_then(|f| f.slots.get_mut(slot)) {
            *target = Some(loaded);
        }
        Ok(self)
    }

    /// The face a descriptor is measured in, or `None` when no face is held.
    fn resolve(&self, font: &FontDescriptor) -> Option<&Loaded<'a>> {
        let slot = slot_of(font);
        self.families
            .iter()
            .find(|f| f.name == font.family)
            .and_then(|f| f.face(slot))
            .or_else(|| self.families.first().and_then(|f| f.face(slot)))
    }
}

impl Measure for FontTableMeasurer<'_> {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        let Some(loaded) = self.resolve(font) else {
            return estimate_advance(text, font.size_px);
        };
        // The TypeScript returns 0 early for an empty text or a size of 0; both
        // sum to +0 here (an empty run is 0, and `0 + -0` is `+0`), so the early
        // return is not ported.
        let size = clamp_advance(font.size_px);
        clamp_advance(loaded.advance(text, size, font.size_px))
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        match self.resolve(font) {
            Some(loaded) => loaded.vertical(clamp_advance(font.size_px)),
            None => estimate_vertical(font.size_px),
        }
    }
}
