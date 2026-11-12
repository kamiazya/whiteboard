//! The `cmap` table: which subtable is read, and the two formats that matter.
//!
//! The subtable is chosen as opentype.js chooses it, so the same face maps the
//! same code point to the same glyph: records are scanned from the LAST to the
//! first and the first whose platform and encoding opentype.js accepts wins.
//! Formats 4 (the BMP) and 12 (every code point) are read; any other format a
//! chosen subtable carries is refused rather than guessed at. A subtable whose
//! segments or groups are not sorted and disjoint is refused too, which is what
//! lets a lookup binary-search without allocating: opentype.js lets a later
//! entry overwrite an earlier one, and a face relying on that is not a face
//! this reader measures.

use super::SfntError;
use super::read::{index, u16_at, u32_at};

/// A parsed subtable: the bytes it reads and the counts it checked.
#[derive(Clone, Copy, Debug)]
pub(super) enum Cmap<'a> {
    /// The segments opentype.js reads: all but the last (the terminator).
    Format4 {
        data: &'a [u8],
        segments: usize,
        total: usize,
    },
    Format12 {
        groups: &'a [u8],
        count: usize,
    },
}

const FORMAT_4_HEADER: usize = 16;
const FORMAT_12_HEADER: usize = 16;
const GROUP_BYTES: usize = 12;
/// A binary search over at most `usize::MAX` entries halves at most this many
/// times; the bound is on the loop itself, so no input keeps it running.
const SEARCH_STEPS: u32 = usize::BITS;

/// Whether opentype.js reads a subtable of this platform and encoding.
fn accepted(platform: u16, encoding: u16) -> bool {
    match platform {
        3 => matches!(encoding, 0 | 1 | 10),
        0 => matches!(encoding, 0..=4 | 6),
        1 => encoding == 0,
        _ => false,
    }
}

impl<'a> Cmap<'a> {
    pub(super) fn parse(table: &'a [u8]) -> Result<Self, SfntError> {
        if u16_at(table, 0) != Some(0) {
            return Err(SfntError::BadCmap);
        }
        let count = usize::from(u16_at(table, 2).ok_or(SfntError::BadCmap)?);
        let mut chosen = None;
        // `count` is at most 65535 and each record read is bounds-checked, so
        // the scan is bounded by the table.
        for i in (0..count).rev() {
            let at = i.checked_mul(8).and_then(|n| n.checked_add(4)).ok_or(SfntError::BadCmap)?;
            let platform = u16_at(table, at).ok_or(SfntError::BadCmap)?;
            let encoding = u16_at(table, at.saturating_add(2)).ok_or(SfntError::BadCmap)?;
            if accepted(platform, encoding) {
                chosen = u32_at(table, at.saturating_add(4));
                break;
            }
        }
        let start = index(chosen.ok_or(SfntError::BadCmap)?);
        let sub = table.get(start..).ok_or(SfntError::BadCmap)?;
        match u16_at(sub, 0) {
            Some(4) => Self::format_4(sub),
            Some(12) => Self::format_12(sub),
            Some(other) => Err(SfntError::UnsupportedCmapFormat(other)),
            None => Err(SfntError::BadCmap),
        }
    }

    fn format_4(sub: &'a [u8]) -> Result<Self, SfntError> {
        let total = usize::from(u16_at(sub, 6).ok_or(SfntError::BadCmap)? >> 1);
        let arrays = total.checked_mul(8).and_then(|n| n.checked_add(FORMAT_4_HEADER));
        if arrays.is_none_or(|n| n > sub.len()) {
            return Err(SfntError::BadCmap);
        }
        let segments = total.saturating_sub(1);
        let table = Self::Format4 { data: sub, segments, total };
        let mut previous_end: Option<u16> = None;
        for i in 0..segments {
            let (start, end) = table.segment(i).ok_or(SfntError::BadCmap)?;
            let ordered = previous_end.is_none_or(|p| end > p && start > p);
            if !ordered {
                return Err(SfntError::BadCmap);
            }
            previous_end = Some(end);
        }
        Ok(table)
    }

    fn format_12(sub: &'a [u8]) -> Result<Self, SfntError> {
        let count = index(u32_at(sub, 12).ok_or(SfntError::BadCmap)?);
        let bytes = count.checked_mul(GROUP_BYTES).ok_or(SfntError::BadCmap)?;
        let end = bytes.checked_add(FORMAT_12_HEADER).ok_or(SfntError::BadCmap)?;
        let groups = sub.get(FORMAT_12_HEADER..end).ok_or(SfntError::BadCmap)?;
        let table = Self::Format12 { groups, count };
        let mut previous_end: Option<u32> = None;
        for i in 0..count {
            let (start, end, _) = table.group(i).ok_or(SfntError::BadCmap)?;
            if start > end || previous_end.is_some_and(|p| start <= p) {
                return Err(SfntError::BadCmap);
            }
            previous_end = Some(end);
        }
        Ok(table)
    }

    /// Segment `i`'s start and end codes.
    fn segment(&self, i: usize) -> Option<(u16, u16)> {
        let Self::Format4 { data, total, .. } = *self else { return None };
        let end = u16_at(data, FORMAT_4_HEADER.checked_sub(2)?.checked_add(i.checked_mul(2)?)?)?;
        let start_at =
            FORMAT_4_HEADER.checked_add(total.checked_mul(2)?)?.checked_add(i.checked_mul(2)?)?;
        Some((u16_at(data, start_at)?, end))
    }

    fn group(&self, i: usize) -> Option<(u32, u32, u32)> {
        let Self::Format12 { groups, .. } = *self else { return None };
        let at = i.checked_mul(GROUP_BYTES)?;
        Some((
            u32_at(groups, at)?,
            u32_at(groups, at.checked_add(4)?)?,
            u32_at(groups, at.checked_add(8)?)?,
        ))
    }

    /// The glyph index of `code`, 0 when the face has none.
    pub(super) fn glyph_index(&self, code: u32) -> u32 {
        match *self {
            Self::Format4 { .. } => u16::try_from(code).ok().map_or(0, |c| self.format_4_glyph(c)),
            Self::Format12 { count, .. } => self.format_12_glyph(code, count),
        }
    }

    fn format_12_glyph(&self, code: u32, count: usize) -> u32 {
        let (mut low, mut high) = (0_usize, count);
        for _ in 0..SEARCH_STEPS {
            if low >= high {
                break;
            }
            let mid = low.saturating_add(high.saturating_sub(low) / 2);
            let Some((start, end, glyph)) = self.group(mid) else { return 0 };
            if code < start {
                high = mid;
            } else if code > end {
                low = mid.saturating_add(1);
            } else {
                return glyph.saturating_add(code.saturating_sub(start));
            }
        }
        0
    }

    fn format_4_glyph(&self, code: u16) -> u32 {
        let Self::Format4 { data, segments, total } = *self else { return 0 };
        let (mut low, mut high) = (0_usize, segments);
        for _ in 0..SEARCH_STEPS {
            if low >= high {
                break;
            }
            let mid = low.saturating_add(high.saturating_sub(low) / 2);
            let Some((start, end)) = self.segment(mid) else { return 0 };
            if code > end {
                low = mid.saturating_add(1);
                continue;
            }
            if code < start {
                high = mid;
                continue;
            }
            return Self::format_4_mapped(data, total, mid, start, code);
        }
        0
    }

    /// The glyph segment `i` maps `code` to, per the spec's `idRangeOffset` rule.
    fn format_4_mapped(data: &[u8], total: usize, i: usize, start: u16, code: u16) -> u32 {
        let width = total.saturating_mul(2);
        let delta_at = FORMAT_4_HEADER.saturating_add(width.saturating_mul(2));
        let offsets_at = FORMAT_4_HEADER.saturating_add(width.saturating_mul(3));
        let own = i.saturating_mul(2);
        let Some(delta) = u16_at(data, delta_at.saturating_add(own)) else { return 0 };
        let entry = offsets_at.saturating_add(own);
        let Some(range_offset) = u16_at(data, entry) else { return 0 };
        if range_offset == 0 {
            return u32::from(code.wrapping_add(delta));
        }
        let within = usize::from(code.saturating_sub(start)).saturating_mul(2);
        let at = entry.saturating_add(usize::from(range_offset)).saturating_add(within);
        match u16_at(data, at) {
            Some(0) | None => 0,
            Some(glyph) => u32::from(glyph.wrapping_add(delta)),
        }
    }
}
