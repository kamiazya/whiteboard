//! Deal with bytes.

use crate::vendored::event::{Event, Kind, Point};
use crate::vendored::util::constant::TAB_SIZE;
use core::str;

/// A range between two points.
#[derive(Debug)]
pub(crate) struct Position<'a> {
    /// Start point.
    pub(crate) start: &'a Point,
    /// End point.
    pub(crate) end: &'a Point,
}

impl<'a> Position<'a> {
    /// Get a position from an exit event.
    ///
    /// Looks backwards for the corresponding `enter` event.
    /// This does not support nested events (such as lists in lists). With no
    /// enter event in front of it, the position starts at the first event.
    pub(crate) fn from_exit_event(events: &'a [Event], index: usize) -> Position<'a> {
        let end = &events[index].point;
        let name = &events[index].name;
        let mut index = index.saturating_sub(1);

        while index > 0 && !(events[index].kind == Kind::Enter && events[index].name == *name) {
            index -= 1;
        }

        let start = &events[index].point;

        Position { start, end }
    }
}

/// Bytes belonging to a range.
///
/// Includes info on virtual spaces before and after the bytes.
#[derive(Debug)]
pub(crate) struct Slice<'a> {
    /// Bytes.
    pub(crate) bytes: &'a [u8],
    /// Number of virtual spaces before the bytes.
    pub(crate) before: usize,
    /// Number of virtual spaces after the bytes.
    pub(crate) after: usize,
}

impl<'a> Slice<'a> {
    /// Get a slice for a position.
    pub(crate) fn from_position(bytes: &'a [u8], position: &Position) -> Slice<'a> {
        let mut before = position.start.vs;
        let mut after = position.end.vs;
        let mut start = position.start.index;
        let mut end = position.end.index;

        // If we have virtual spaces before, it means we are past the actual
        // character at that index, and those virtual spaces.
        if before > 0 {
            before = TAB_SIZE.saturating_sub(before);
            start += 1;
        }

        // If we have virtual spaces after, it means that character is included,
        // and one less virtual space.
        if after > 0 {
            after -= 1;
            end += 1;
        }

        Slice { bytes: bytes.get(start..end).unwrap_or_default(), before, after }
    }

    /// Get a slice for two indices.
    ///
    /// > 👉 **Note**: indices cannot represent virtual spaces.
    pub(crate) fn from_indices(bytes: &'a [u8], start: usize, end: usize) -> Slice<'a> {
        Slice { bytes: bytes.get(start..end).unwrap_or_default(), before: 0, after: 0 }
    }

    /// Get the size of the bytes and the virtual spaces around them.
    pub(crate) fn len(&self) -> usize {
        self.bytes.len() + self.before + self.after
    }

    /// Turn the slice into a `&str`.
    ///
    /// > 👉 **Note**: cannot represent virtual spaces.
    pub(crate) fn as_str(&self) -> &str {
        str::from_utf8(self.bytes).unwrap_or_default()
    }
}
