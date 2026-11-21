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

    /// The unit offset of the char boundary `byte`. A backwards ask has no
    /// slice ahead of the last offset, so it counts again from the start.
    pub fn at(&mut self, byte: usize) -> usize {
        self.unit = match self.text.get(self.byte..byte) {
            Some(ahead) => self.unit.saturating_add(utf16::len(ahead)),
            None => self.text.get(..byte).map_or(0, utf16::len),
        };
        self.byte = byte;
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
