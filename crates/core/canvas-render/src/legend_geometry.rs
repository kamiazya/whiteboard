//! How much room a legend takes, shared by the SVG backend that draws it and
//! the envelope that makes room for it, so a document's band and its panel
//! cannot disagree. Estimated rather than measured: a legend's words are short
//! identifiers and a generous glyph width keeps a long value inside the panel.

use whiteboard_det::utf16;
use whiteboard_scene::SceneLegend;

pub const LEGEND_MARGIN_PX: f64 = 12.0;
pub const LEGEND_PAD_PX: f64 = 8.0;
pub const LEGEND_ROW_PX: f64 = 18.0;
pub const LEGEND_FONT_PX: f64 = 12.0;
/// Roboto at 12px averages about 6.2px a glyph; 7 keeps a long value inside the panel.
const GLYPH_PX: f64 = 7.0;
pub const LEGEND_SWATCH_W: f64 = 16.0;
pub const LEGEND_SWATCH_H: f64 = 11.0;
pub const LEGEND_GAP_PX: f64 = 6.0;

const UNTAGGED_LABEL: &str = "untagged";

/// What a value is called in the panel; the empty value is the untagged class.
#[must_use]
pub fn legend_value_label(value: &str) -> &str {
    if value.is_empty() { UNTAGGED_LABEL } else { value }
}

/// One line of the panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegendRow {
    pub text: String,
    pub muted: bool,
}

/// The panel's lines in order: each key, its values, then the muted notes. A
/// legend listing no key has no rows at all, so the notes only ever annotate a
/// panel that already has a key.
#[must_use]
pub fn legend_rows(legend: &SceneLegend) -> Vec<LegendRow> {
    if legend.keys.is_empty() {
        return Vec::new();
    }
    let mut rows = Vec::new();
    for key in &legend.keys {
        rows.push(LegendRow { text: key.key.clone(), muted: false });
        for entry in &key.entries {
            rows.push(LegendRow {
                text: legend_value_label(&entry.value).to_string(),
                muted: false,
            });
        }
    }
    if legend.uncarried.boxes {
        rows.push(LegendRow { text: "box colour: no key carries it".to_string(), muted: true });
    }
    if legend.uncarried.edges {
        rows.push(LegendRow { text: "edge colour: no key carries it".to_string(), muted: true });
    }
    rows
}

/// The panel's own box, margin excluded; zero by zero for nothing to say.
#[must_use]
pub fn legend_panel_size(legend: &SceneLegend) -> (f64, f64) {
    let rows = legend_rows(legend);
    if rows.is_empty() {
        return (0.0, 0.0);
    }
    let longest = rows.iter().map(|row| utf16::len(&row.text)).max().unwrap_or(0);
    let widest = f64::from(u32::try_from(longest).unwrap_or(u32::MAX)) * GLYPH_PX;
    let count = f64::from(u32::try_from(rows.len()).unwrap_or(u32::MAX));
    (
        LEGEND_PAD_PX * 2.0 + LEGEND_SWATCH_W + LEGEND_GAP_PX + widest,
        LEGEND_PAD_PX * 2.0 + count * LEGEND_ROW_PX,
    )
}

#[cfg(test)]
mod tests {
    use super::{legend_panel_size, legend_rows, legend_value_label};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_scene::{
        LegendEntry, LegendKey, LegendKind, LegendSwatch, SceneLegend, Uncarried,
    };

    fn entry(value: &str) -> LegendEntry {
        LegendEntry { value: value.into(), count: 1.0, swatch: LegendSwatch::default() }
    }

    fn legend(keys: Vec<LegendKey>, boxes: bool, edges: bool) -> SceneLegend {
        SceneLegend { keys, uncarried: Uncarried { boxes, edges } }
    }

    fn key(name: &str, values: &[&str]) -> LegendKey {
        LegendKey {
            key: name.into(),
            of: LegendKind::Boxes,
            entries: values.iter().map(|v| entry(v)).collect(),
        }
    }

    #[test]
    fn the_empty_value_is_labelled_untagged() {
        assert_eq!(legend_value_label(""), "untagged");
        assert_eq!(legend_value_label("x"), "x");
    }

    #[test]
    fn rows_run_key_then_values_then_the_muted_notes() {
        let rows = legend_rows(&legend(vec![key("k", &["a", ""])], true, true));
        let texts: Vec<(&str, bool)> = rows.iter().map(|r| (r.text.as_str(), r.muted)).collect();
        assert_eq!(
            texts,
            [
                ("k", false),
                ("a", false),
                ("untagged", false),
                ("box colour: no key carries it", true),
                ("edge colour: no key carries it", true),
            ]
        );
        let only_edges = legend_rows(&legend(vec![key("k", &[])], false, true));
        assert_eq!(only_edges.len(), 2);
        let only_boxes = legend_rows(&legend(vec![key("k", &[])], true, false));
        assert_eq!(only_boxes.len(), 2);
    }

    #[test]
    fn a_legend_with_no_key_has_no_rows_whatever_it_says_is_uncarried() {
        assert!(legend_rows(&legend(vec![], true, true)).is_empty());
        assert_eq!(legend_panel_size(&legend(vec![], true, true)), (0.0, 0.0));
    }

    #[test]
    fn the_panel_is_sized_off_the_longest_row_in_utf16_units() {
        let size = legend_panel_size(&legend(vec![key("key", &["abcdef", "😀"])], false, false));
        // longest row is 6 units; 3 rows beside the key line make 4 rows.
        assert_eq!(size, (16.0 + 16.0 + 6.0 + 6.0 * 7.0, 16.0 + 3.0 * 18.0));
        let emoji = legend_panel_size(&legend(vec![key("k", &["😀"])], false, false));
        assert_eq!(emoji, (16.0 + 16.0 + 6.0 + 2.0 * 7.0, 16.0 + 2.0 * 18.0));
    }
}
