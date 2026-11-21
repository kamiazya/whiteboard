//! Byte offsets of a text as the UTF-16 code-unit offsets a JavaScript caller
//! counts.

use whiteboard_det::utf16;

/// Converts non-decreasing byte offsets of one text into unit offsets, so
/// converting every match of a scan costs one pass over the text. An offset
/// before the last one starts over from the beginning rather than answering
/// wrongly.
#[derive(Debug)]
pub struct UnitOffsets<'a> {
    text: &'a str,
    byte: usize,
    unit: usize,
}

impl<'a> UnitOffsets<'a> {
    #[must_use]
    pub const fn new(text: &'a str) -> Self {
        Self { text, byte: 0, unit: 0 }
    }

    /// The unit offset of the char boundary `byte`.
    pub fn at(&mut self, byte: usize) -> usize {
        if byte < self.byte {
            self.byte = 0;
            self.unit = 0;
        }
        let step = self.text.get(self.byte..byte).map_or(0, utf16::len);
        self.byte = byte;
        self.unit = self.unit.saturating_add(step);
        self.unit
    }
}

#[cfg(test)]
mod tests {
    use super::UnitOffsets;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn astral_characters_count_two_units_and_a_backwards_ask_starts_over() {
        let text = "a😀é";
        let mut offsets = UnitOffsets::new(text);
        assert_eq!(offsets.at(1), 1);
        assert_eq!(offsets.at(5), 3);
        assert_eq!(offsets.at(7), 4);
        assert_eq!(offsets.at(1), 1);
        assert_eq!(offsets.at(0), 0);
    }
}
