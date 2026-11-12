//! A small sfnt reader: exactly the tables the font measurer needs, over bytes
//! it never copies.
//!
//! It reads the table directory, `head` (units per em), `hhea` (ascender,
//! descender, line gap, number of metrics), `maxp` (glyph count), `hmtx`
//! (advances, the last one repeating past `numberOfHMetrics`) and `cmap`
//! ([`cmap`]). A daemon reads fonts a user installed, so the input is
//! untrusted: every read is bounds-checked and answers an error or `None`,
//! every loop is bounded by a count a table's own length caps, nothing is
//! allocated, and a file over [`MAX_BYTES`] is refused before it is read
//! (`crates/input-caps.json`).

mod cmap;
mod read;

use cmap::Cmap;
use read::{i16_at, index, u16_at, u32_at};

/// The most a font file may hold. A font a user can install is a few hundred
/// KiB to tens of MiB (a CJK face); this is the ceiling the fuzz target runs at.
pub const MAX_BYTES: usize = 32 * 1024 * 1024;

/// Why a font was refused.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SfntError {
    /// More than [`MAX_BYTES`].
    TooLarge,
    /// Not a TrueType or OpenType outline font (a collection, or no magic).
    BadMagic,
    /// A table the measurer needs is not in the directory.
    MissingTable([u8; 4]),
    /// A table is shorter than its fields, or a count points outside it.
    Truncated([u8; 4]),
    /// A zero units-per-em, glyph count or metric count.
    ZeroCount,
    /// The `cmap` has no readable subtable or a malformed one.
    BadCmap,
    /// The chosen `cmap` subtable is in a format this reader does not read.
    UnsupportedCmapFormat(u16),
}

impl core::fmt::Display for SfntError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::TooLarge => f.write_str("the font is over the size cap"),
            Self::BadMagic => f.write_str("the bytes are not a TrueType or OpenType font"),
            Self::MissingTable(tag) => write!(f, "no {} table", String::from_utf8_lossy(tag)),
            Self::Truncated(tag) => {
                write!(f, "the {} table is truncated", String::from_utf8_lossy(tag))
            }
            Self::ZeroCount => f.write_str("a units-per-em, glyph or metric count is zero"),
            Self::BadCmap => f.write_str("the cmap has no readable subtable"),
            Self::UnsupportedCmapFormat(n) => write!(f, "cmap format {n} is not read"),
        }
    }
}

impl core::error::Error for SfntError {}

/// What the measurer reads of one face.
#[derive(Clone, Copy, Debug)]
pub struct Sfnt<'a> {
    units_per_em: u16,
    ascender: i16,
    descender: i16,
    line_gap: i16,
    num_glyphs: u16,
    num_metrics: u16,
    hmtx: &'a [u8],
    cmap: Cmap<'a>,
}

const TRUETYPE: u32 = 0x0001_0000;
const TRUE: u32 = 0x7472_7565;
const OTTO: u32 = 0x4F54_544F;
const DIRECTORY_RECORD: usize = 16;

impl<'a> Sfnt<'a> {
    /// # Errors
    /// [`SfntError`] for a file over the cap, one that is not an outline font,
    /// lacks or truncates a table this reads, or whose `cmap` it cannot read.
    pub fn parse(data: &'a [u8]) -> Result<Self, SfntError> {
        if data.len() > MAX_BYTES {
            return Err(SfntError::TooLarge);
        }
        if !matches!(u32_at(data, 0), Some(TRUETYPE | TRUE | OTTO)) {
            return Err(SfntError::BadMagic);
        }
        let head = table(data, *b"head")?;
        let hhea = table(data, *b"hhea")?;
        let maxp = table(data, *b"maxp")?;
        let units_per_em = u16_at(head, 18).ok_or(SfntError::Truncated(*b"head"))?;
        let truncated = SfntError::Truncated(*b"hhea");
        let ascender = i16_at(hhea, 4).ok_or(truncated)?;
        let descender = i16_at(hhea, 6).ok_or(truncated)?;
        let line_gap = i16_at(hhea, 8).ok_or(truncated)?;
        let num_metrics = u16_at(hhea, 34).ok_or(truncated)?;
        let num_glyphs = u16_at(maxp, 4).ok_or(SfntError::Truncated(*b"maxp"))?;
        if units_per_em == 0 || num_glyphs == 0 || num_metrics == 0 {
            return Err(SfntError::ZeroCount);
        }
        let hmtx = table(data, *b"hmtx")?;
        let needed = usize::from(num_metrics.min(num_glyphs)).saturating_mul(4);
        if hmtx.len() < needed {
            return Err(SfntError::Truncated(*b"hmtx"));
        }
        let cmap = Cmap::parse(table(data, *b"cmap")?)?;
        Ok(Self {
            units_per_em,
            ascender,
            descender,
            line_gap,
            num_glyphs,
            num_metrics,
            hmtx,
            cmap,
        })
    }

    #[must_use]
    pub const fn units_per_em(&self) -> u16 {
        self.units_per_em
    }

    /// The `hhea` ascender, descender (negative) and line gap, in design units.
    #[must_use]
    pub const fn hhea(&self) -> (i16, i16, i16) {
        (self.ascender, self.descender, self.line_gap)
    }

    /// The glyph index of a code point; 0, `.notdef`, when the face has none.
    #[must_use]
    pub fn glyph_index(&self, ch: char) -> u32 {
        self.cmap.glyph_index(u32::from(ch))
    }

    /// The advance of a glyph in design units. A glyph past the glyph count is
    /// `.notdef`, and one past the metrics repeats the last advance.
    #[must_use]
    pub fn advance(&self, glyph: u32) -> u16 {
        let glyph = if glyph >= u32::from(self.num_glyphs) { 0 } else { index(glyph) };
        let metric = glyph.min(usize::from(self.num_metrics).saturating_sub(1));
        u16_at(self.hmtx, metric.saturating_mul(4)).unwrap_or(0)
    }
}

/// The bytes of the first table the directory names `tag`.
fn table(data: &[u8], tag: [u8; 4]) -> Result<&[u8], SfntError> {
    let count = usize::from(u16_at(data, 4).ok_or(SfntError::Truncated(*b"sfnt"))?);
    for i in 0..count {
        let at = i
            .checked_mul(DIRECTORY_RECORD)
            .and_then(|n| n.checked_add(12))
            .ok_or(SfntError::Truncated(*b"sfnt"))?;
        let record = data.get(at..at.saturating_add(DIRECTORY_RECORD));
        let Some(record) = record else { return Err(SfntError::Truncated(*b"sfnt")) };
        if record.get(..4) != Some(&tag[..]) {
            continue;
        }
        let offset = index(u32_at(record, 8).ok_or(SfntError::Truncated(tag))?);
        let length = index(u32_at(record, 12).ok_or(SfntError::Truncated(tag))?);
        let rest = data.get(offset..).ok_or(SfntError::Truncated(tag))?;
        return Ok(rest.get(..length.min(rest.len())).unwrap_or(rest));
    }
    Err(SfntError::MissingTable(tag))
}
