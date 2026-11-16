//! The legend as scene nodes, for a board drawn inside something else
//! (`legend/legend-scene.ts`'s `legendSceneBlock`): a note can embed several
//! boards, each with its own legend, so an embed's legend is ordinary content
//! placed under its board rather than document chrome in a corner.
//!
//! Drawn at its own size, never scaled with the miniature, with no panel of its
//! own, its words in the board's label ink and estimated rather than measured,
//! as the SVG backend's panel is ([`crate::legend_geometry`]).

use whiteboard_det::utf16;
use whiteboard_scene::{
    Appearance, BoundingBox, LegendEntry, LegendKey, LegendKind, SceneLegend, SceneNode,
    ShapeSceneNode, TextRunNode,
};

use crate::legend_geometry::{
    LEGEND_FONT_PX, LEGEND_GAP_PX, LEGEND_ROW_PX, LEGEND_SWATCH_H, LEGEND_SWATCH_W, legend_rows,
    legend_value_label,
};
use crate::typeset::empty_run;

/// The same generous estimate the panel takes: a key's words are short identifiers.
const GLYPH_PX: f64 = 7.0;
const EDGE_SWATCH_PX: f64 = 2.0;
const MUTED_OPACITY: f64 = 0.6;

/// The legend's rows from the origin down, and the extent they take.
#[derive(Debug, Clone, PartialEq)]
pub struct LegendBlock {
    pub nodes: Vec<SceneNode>,
    pub w: f64,
    pub h: f64,
}

fn shape(bbox: BoundingBox, radius: Option<f64>, appearance: Appearance) -> SceneNode {
    SceneNode::Shape(Box::new(ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: None,
        bbox,
        comment_chrome: false,
        proposal_chrome: None,
        radius,
        shape: None,
        appearance: Some(appearance),
        task_box: None,
        ink: None,
    }))
}

fn swatch(of: LegendKind, entry: &LegendEntry, row_y: f64, ink: &Appearance) -> SceneNode {
    let top = row_y + (LEGEND_ROW_PX - LEGEND_SWATCH_H) / 2.0;
    let stroke = entry.swatch.stroke.clone().or_else(|| ink.fill.clone());
    if of == LegendKind::Edges {
        let y = top + (LEGEND_SWATCH_H - EDGE_SWATCH_PX) / 2.0;
        let bbox = BoundingBox { x: 0.0, y, w: LEGEND_SWATCH_W, h: EDGE_SWATCH_PX };
        return shape(bbox, None, Appearance { fill: stroke, ..Appearance::default() });
    }
    let bbox = BoundingBox { x: 0.0, y: top, w: LEGEND_SWATCH_W, h: LEGEND_SWATCH_H };
    let fill = entry.swatch.fill.clone().unwrap_or_else(|| "none".to_owned());
    let paint =
        Appearance { fill: Some(fill), stroke, stroke_width: Some(1.0), ..Appearance::default() };
    shape(bbox, Some(2.0), paint)
}

/// How one line of words is drawn: a key in bold, a note muted.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Words {
    Key,
    Value,
    Note,
}

fn words(text: &str, x: f64, row_y: f64, ink: &Appearance, kind: Words) -> SceneNode {
    let length = f64::from(u32::try_from(utf16::len(text)).unwrap_or(u32::MAX));
    // The label ink's colour and family only: its halo would box every word.
    let appearance = Appearance {
        fill: ink.fill.clone(),
        font_family: ink.font_family.clone(),
        font_size: Some(LEGEND_FONT_PX),
        fill_opacity: (kind == Words::Note).then_some(MUTED_OPACITY),
        ..Appearance::default()
    };
    SceneNode::TextRun(Box::new(TextRunNode {
        bbox: BoundingBox { x, y: row_y, w: length * GLYPH_PX, h: LEGEND_ROW_PX },
        text: text.to_owned(),
        baseline: Some(LEGEND_FONT_PX),
        strong: kind == Words::Key,
        appearance: Some(appearance),
        ..empty_run()
    }))
}

fn key_rows(key: &LegendKey, row: &mut f64, ink: &Appearance, nodes: &mut Vec<SceneNode>) {
    nodes.push(words(&key.key, 0.0, *row * LEGEND_ROW_PX, ink, Words::Key));
    *row += 1.0;
    for entry in &key.entries {
        let row_y = *row * LEGEND_ROW_PX;
        nodes.push(swatch(key.of, entry, row_y, ink));
        let label = legend_value_label(&entry.value);
        nodes.push(words(label, LEGEND_SWATCH_W + LEGEND_GAP_PX, row_y, ink, Words::Value));
        *row += 1.0;
    }
}

/// The legend's rows from the origin down, or `None` when it has nothing to
/// say, so the caller lays the board out exactly as it would with no legend.
#[must_use]
pub fn legend_scene_block(legend: &SceneLegend, ink: &Appearance) -> Option<LegendBlock> {
    let rows = legend_rows(legend);
    let widest = rows.iter().map(|line| utf16::len(&line.text)).max()?;
    let mut nodes = Vec::new();
    let mut row = 0.0;
    for key in &legend.keys {
        key_rows(key, &mut row, ink, &mut nodes);
    }
    for line in rows.iter().filter(|line| line.muted) {
        nodes.push(words(&line.text, 0.0, row * LEGEND_ROW_PX, ink, Words::Note));
        row += 1.0;
    }
    let count = |n: usize| f64::from(u32::try_from(n).unwrap_or(u32::MAX));
    Some(LegendBlock {
        nodes,
        w: LEGEND_SWATCH_W + LEGEND_GAP_PX + count(widest) * GLYPH_PX,
        h: count(rows.len()) * LEGEND_ROW_PX,
    })
}

#[cfg(test)]
mod tests {
    use super::{LegendBlock, legend_scene_block};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_scene::{
        Appearance, BoundingBox, LegendEntry, LegendKey, LegendKind, LegendSwatch, SceneLegend,
        SceneNode, Uncarried,
    };

    fn ink() -> Appearance {
        Appearance {
            fill: Some("#111".into()),
            font_family: Some("Roboto".into()),
            halo: Some("#fff".into()),
            ..Appearance::default()
        }
    }

    fn key(of: LegendKind, swatch: LegendSwatch) -> LegendKey {
        LegendKey {
            key: "health".into(),
            of,
            entries: vec![LegendEntry { value: String::new(), count: 2.0, swatch }],
        }
    }

    fn block(keys: Vec<LegendKey>, boxes: bool) -> LegendBlock {
        let legend = SceneLegend { keys, uncarried: Uncarried { boxes, edges: false } };
        legend_scene_block(&legend, &ink()).unwrap_or_else(|| panic!("a block"))
    }

    fn shape(node: &SceneNode) -> (BoundingBox, Option<f64>, Option<Appearance>) {
        match node {
            SceneNode::Shape(s) => (s.bbox, s.radius, s.appearance.clone()),
            other => panic!("{other:?}"),
        }
    }

    fn run(node: &SceneNode) -> (BoundingBox, &str, bool, Option<Appearance>) {
        match node {
            SceneNode::TextRun(r) => (r.bbox, r.text.as_str(), r.strong, r.appearance.clone()),
            other => panic!("{other:?}"),
        }
    }

    /// The key in bold, then each value's swatch and its label a gap to the
    /// right, a row each; the words in the ink's fill and family, never its halo.
    #[test]
    fn a_box_key_draws_its_name_then_a_framed_swatch_and_label_per_value() {
        let drawn = block(vec![key(LegendKind::Boxes, LegendSwatch::default())], false);
        let [name, swatch, label] = drawn.nodes.as_slice() else { panic!("{drawn:?}") };
        let words = Appearance {
            fill: Some("#111".into()),
            font_family: Some("Roboto".into()),
            font_size: Some(12.0),
            ..Appearance::default()
        };
        assert_eq!(
            run(name),
            (BoundingBox { x: 0.0, y: 0.0, w: 42.0, h: 18.0 }, "health", true, Some(words.clone()))
        );
        let frame = Appearance {
            fill: Some("none".into()),
            stroke: Some("#111".into()),
            stroke_width: Some(1.0),
            ..Appearance::default()
        };
        assert_eq!(
            shape(swatch),
            (BoundingBox { x: 0.0, y: 21.5, w: 16.0, h: 11.0 }, Some(2.0), Some(frame))
        );
        assert_eq!(
            run(label),
            (BoundingBox { x: 22.0, y: 18.0, w: 56.0, h: 18.0 }, "untagged", false, Some(words))
        );
        assert_eq!((drawn.w, drawn.h), (22.0 + 8.0 * 7.0, 36.0));
    }

    /// An edge key's swatch is a line in the value's stroke; a box swatch
    /// with a fill and stroke of its own wears them.
    #[test]
    fn an_edge_swatch_is_a_line_in_the_value_stroke() {
        let stroke = LegendSwatch { fill: None, stroke: Some("#c00".into()) };
        let drawn = block(vec![key(LegendKind::Edges, stroke.clone())], false);
        let line = Appearance { fill: Some("#c00".into()), ..Appearance::default() };
        assert_eq!(
            shape(&drawn.nodes[1]),
            (BoundingBox { x: 0.0, y: 26.0, w: 16.0, h: 2.0 }, None, Some(line))
        );
        let own = LegendSwatch { fill: Some("#0c0".into()), stroke: Some("#00c".into()) };
        let boxed = block(vec![key(LegendKind::Boxes, own)], false);
        let paint = shape(&boxed.nodes[1]).2.unwrap_or_default();
        assert_eq!((paint.fill, paint.stroke), (Some("#0c0".into()), Some("#00c".into())));
    }

    /// A colour no key carries is said under the keys, muted.
    #[test]
    fn an_uncarried_colour_is_a_muted_note_under_the_keys() {
        let drawn = block(vec![key(LegendKind::Boxes, LegendSwatch::default())], true);
        let (bbox, text, strong, paint) = run(&drawn.nodes[3]);
        assert_eq!((bbox.y, text, strong), (36.0, "box colour: no key carries it", false));
        assert_eq!(paint.and_then(|p| p.fill_opacity), Some(0.6));
        assert_eq!((drawn.w, drawn.h), (22.0 + 29.0 * 7.0, 54.0));
    }

    /// Each key opens its own row under the last value of the one before,
    /// and each muted note takes a row of its own after the keys.
    #[test]
    fn keys_and_notes_each_take_the_next_row_down() {
        let keys = vec![
            key(LegendKind::Boxes, LegendSwatch::default()),
            key(LegendKind::Edges, LegendSwatch::default()),
        ];
        let legend = SceneLegend { keys, uncarried: Uncarried { boxes: true, edges: true } };
        let drawn = legend_scene_block(&legend, &ink()).unwrap_or_else(|| panic!("a block"));
        let rows: Vec<(f64, &str)> = drawn
            .nodes
            .iter()
            .filter(|node| matches!(node, SceneNode::TextRun(_)))
            .map(|node| {
                let (bbox, text, _, _) = run(node);
                (bbox.y, text)
            })
            .collect();
        assert_eq!(
            rows,
            [
                (0.0, "health"),
                (18.0, "untagged"),
                (36.0, "health"),
                (54.0, "untagged"),
                (72.0, "box colour: no key carries it"),
                (90.0, "edge colour: no key carries it"),
            ]
        );
        assert_eq!((drawn.w, drawn.h), (22.0 + 30.0 * 7.0, 108.0));
    }

    #[test]
    fn a_legend_with_nothing_to_key_draws_no_block() {
        let legend =
            SceneLegend { keys: vec![], uncarried: Uncarried { boxes: true, edges: true } };
        assert_eq!(legend_scene_block(&legend, &ink()), None);
    }
}
