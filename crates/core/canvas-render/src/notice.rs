//! The notice a surface draws where a layout was refused: one box and its
//! words, wrapped greedily, which is all a message needs. The core draws it so
//! no surface needs a second renderer for it; the WORDS stay the caller's
//! (they are shared with the HTML notice and the server's note), so this takes
//! the title and the detail it is handed and only lays out and draws the box.
//!
//! A measurer that fails, or answers a non-finite advance or ascent anywhere,
//! draws the whole notice by the ratio estimate instead: a `host-measure`
//! refusal is drawn because the host's measurer failed, so its notice cannot
//! depend on it, and one measurer for the whole box keeps its lines consistent.

use std::cell::Cell;

use whiteboard_det::math::{js_max, js_min};
use whiteboard_scene::{Appearance, BoundingBox, Scene, SceneNode, ScenePoint};
use whiteboard_scene::{ShapeSceneNode, TextRunNode};

use crate::constant_ratio::ConstantRatioMeasure;
use crate::measure::{
    FontDescriptor, FontStyle, Measure, TextMetrics, VerticalMetrics, clamp_advance,
};
use crate::theme::font::SPATIAL_THEME_FONT_FAMILY;
use crate::theme::mode::SpatialThemeMode;
use crate::theme::palette::SpatialPalette;
use crate::typeset::empty_run;

/// The widest a notice is drawn, and the width it has by default.
pub const NOTICE_WIDTH_PX: f64 = 480.0;
const PADDING_PX: f64 = 16.0;
const GAP_PX: f64 = 6.0;
const TITLE_SIZE_PX: f64 = 16.0;
const DETAIL_SIZE_PX: f64 = 14.0;
const LINE_HEIGHT: f64 = 1.4;

/// How a notice is drawn: the mode, the width there is (default and most
/// [`NOTICE_WIDTH_PX`]), and the point its top-left corner sits at (default the
/// origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoticeOptions {
    pub mode: SpatialThemeMode,
    pub max_width: Option<f64>,
    pub at: Option<ScenePoint>,
}

/// `measure`, noting any answer this notice cannot place.
struct Trusted<'a> {
    inner: &'a dyn Measure,
    doubted: Cell<bool>,
}

impl Measure for Trusted<'_> {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        self.measure(text, font).advance_width
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        let TextMetrics { ascent, descent, line_gap, .. } = self.measure("", font);
        VerticalMetrics { ascent, descent, line_gap }
    }

    fn measure(&self, text: &str, font: &FontDescriptor) -> TextMetrics {
        let metrics = self.inner.measure(text, font);
        if !metrics.advance_width.is_finite() || !metrics.ascent.is_finite() {
            self.doubted.set(true);
        }
        metrics
    }
}

fn font(size_px: f64, weight: f64) -> FontDescriptor {
    FontDescriptor {
        family: SPATIAL_THEME_FONT_FAMILY.to_owned(),
        fallback_chain: Vec::new(),
        weight,
        style: FontStyle::Normal,
        size_px,
    }
}

/// `text` broken at spaces into lines no wider than `width`; a word wider than
/// it keeps a line of its own.
fn wrap(text: &str, width: f64, measure: &dyn Measure, at: &FontDescriptor) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split(' ') {
        let tried = if line.is_empty() { word.to_owned() } else { format!("{line} {word}") };
        if !line.is_empty() && clamp_advance(measure.measure(&tried, at).advance_width) > width {
            lines.push(std::mem::take(&mut line));
            word.clone_into(&mut line);
        } else {
            line = tried;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

fn box_of(left: f64, top: f64, width: f64, height: f64, palette: &SpatialPalette) -> SceneNode {
    SceneNode::Shape(Box::new(ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: None,
        bbox: BoundingBox { x: left, y: top, w: width, h: height },
        comment_chrome: false,
        proposal_chrome: None,
        radius: Some(palette.corner_radius_px),
        shape: None,
        appearance: Some(Appearance {
            fill: Some(palette.node.file.fill.clone()),
            stroke: Some(palette.node.file.stroke.clone()),
            stroke_width: Some(1.0),
            ..Appearance::default()
        }),
        task_box: None,
        ink: None,
    }))
}

fn drawn(title: &str, detail: &str, options: &NoticeOptions, measure: &dyn Measure) -> Scene {
    let palette = match options.mode {
        SpatialThemeMode::Dark => SpatialPalette::dark(),
        SpatialThemeMode::Light => SpatialPalette::light(),
    };
    let width = js_min(options.max_width.unwrap_or(NOTICE_WIDTH_PX), NOTICE_WIDTH_PX);
    // A width too narrow for the padding leaves no room, never a negative one.
    let inner = js_max(width - 2.0 * PADDING_PX, 0.0);
    let ScenePoint { x: left, y: top } = options.at.unwrap_or(ScenePoint { x: 0.0, y: 0.0 });
    let mut runs: Vec<SceneNode> = Vec::new();
    let mut y = PADDING_PX;
    let mut set = |y: &mut f64, text: &str, size_px: f64, strong: bool| {
        let at = font(size_px, if strong { 700.0 } else { 400.0 });
        let line_height = size_px * LINE_HEIGHT;
        for line in wrap(text, inner, measure, &at) {
            let metrics = measure.measure(&line, &at);
            runs.push(SceneNode::TextRun(Box::new(TextRunNode {
                bbox: BoundingBox {
                    x: left + PADDING_PX,
                    y: top + *y,
                    w: js_min(clamp_advance(metrics.advance_width), inner),
                    h: line_height,
                },
                text: line,
                strong,
                baseline: Some(metrics.ascent + (line_height - size_px) / 2.0),
                appearance: Some(Appearance {
                    fill: Some(palette.label_fill.clone()),
                    font_family: Some(SPATIAL_THEME_FONT_FAMILY.to_owned()),
                    font_size: Some(size_px),
                    ..Appearance::default()
                }),
                ..empty_run()
            })));
            *y += line_height;
        }
    };
    set(&mut y, title, TITLE_SIZE_PX, true);
    y += GAP_PX;
    set(&mut y, detail, DETAIL_SIZE_PX, false);
    let box_node = box_of(left, top, width, y + PADDING_PX, &palette);
    let mut nodes = vec![box_node];
    nodes.extend(runs);
    Scene { nodes, legend: None }
}

/// A notice saying `title` and then `detail`, as one box and its words, drawn
/// by `measure`; by the ratio estimate when `measure` answered a number no
/// placement can use.
#[must_use]
pub fn notice_scene(
    title: &str,
    detail: &str,
    options: &NoticeOptions,
    measure: &dyn Measure,
) -> Scene {
    let trusted = Trusted { inner: measure, doubted: Cell::new(false) };
    let scene = drawn(title, detail, options, &trusted);
    if trusted.doubted.get() { drawn(title, detail, options, &ConstantRatioMeasure) } else { scene }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_measure::FakeMeasure;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn lines(text: &str, width: f64) -> Vec<String> {
        wrap(text, width, &FakeMeasure::default(), &font(14.0, 400.0))
    }

    // The fake advance is 0.6 em a UTF-16 unit: 8.4px a character at 14px.
    #[test]
    fn a_word_wider_than_the_line_keeps_a_line_of_its_own() {
        assert_eq!(lines("a bbbbbbbbbbbbbbbbbbbb c", 50.0), ["a", "bbbbbbbbbbbbbbbbbbbb", "c"]);
    }

    #[test]
    fn a_line_exactly_as_wide_as_the_width_is_kept() {
        let exact = FakeMeasure::default().advance_width("abcde f", &font(14.0, 400.0));
        assert_eq!(lines("abcde f", exact), ["abcde f"]);
        assert_eq!(lines("abcde f", exact - 0.01), ["abcde", "f"]);
    }

    #[test]
    fn empty_text_and_empty_words_follow_the_split() {
        assert!(lines("", 100.0).is_empty());
        assert_eq!(lines("a  b", 100.0), ["a  b"]);
        // An empty first word leaves the line empty, so the next word starts it.
        assert_eq!(lines(" a", 100.0), ["a"]);
        assert_eq!(lines("a ", 100.0), ["a "]);
    }

    fn options(max_width: Option<f64>) -> NoticeOptions {
        NoticeOptions { mode: SpatialThemeMode::Light, max_width, at: None }
    }

    #[test]
    fn the_box_is_drawn_first_and_holds_the_runs() {
        let scene =
            notice_scene("Title", "some words here", &options(None), &FakeMeasure::default());
        let [SceneNode::Shape(shape), SceneNode::TextRun(title), SceneNode::TextRun(detail)] =
            scene.nodes.as_slice()
        else {
            panic!("one box then two runs: {:?}", scene.nodes);
        };
        assert!(title.strong && !detail.strong);
        assert_eq!(shape.bbox.w.to_bits(), NOTICE_WIDTH_PX.to_bits());
        // padding, a 22.4px title line, the gap, a 19.6px detail line, padding.
        assert_eq!(shape.bbox.h.to_bits(), (16.0 + 22.4 + 6.0 + 19.6 + 16.0_f64).to_bits());
    }

    #[test]
    fn the_width_is_capped_and_a_point_moves_the_box() {
        let at = Some(ScenePoint { x: 10.0, y: 20.0 });
        let wide = NoticeOptions { max_width: Some(900.0), at, ..options(None) };
        let scene = notice_scene("T", "d", &wide, &FakeMeasure::default());
        let Some(SceneNode::Shape(shape)) = scene.nodes.first() else { panic!("no box") };
        assert_eq!((shape.bbox.x, shape.bbox.y, shape.bbox.w), (10.0, 20.0, NOTICE_WIDTH_PX));
    }

    /// A text run as the notice draws it, built from the numbers alone.
    fn run(x: f64, y: f64, w: f64, text: &str, size: f64, strong: bool, fill: &str) -> SceneNode {
        let line_height = size * 1.4;
        SceneNode::TextRun(Box::new(TextRunNode {
            bbox: BoundingBox { x, y, w, h: line_height },
            text: text.to_owned(),
            strong,
            baseline: Some(size * 0.8 + (line_height - size) / 2.0),
            appearance: Some(Appearance {
                fill: Some(fill.to_owned()),
                font_family: Some("Roboto".to_owned()),
                font_size: Some(size),
                ..Appearance::default()
            }),
            ..empty_run()
        }))
    }

    #[test]
    fn draws_every_field_of_a_wrapped_notice_where_it_is_placed() {
        // 200px wide at (10, 20): 168px for the words. The fake advance is
        // 0.6 em a unit, so a 14px detail line holds 20 characters.
        for (mode, palette) in [
            (SpatialThemeMode::Light, SpatialPalette::light()),
            (SpatialThemeMode::Dark, SpatialPalette::dark()),
        ] {
            let placed = NoticeOptions {
                mode,
                max_width: Some(200.0),
                at: Some(ScenePoint { x: 10.0, y: 20.0 }),
            };
            let scene =
                notice_scene("Title", "aaaa bbbb cccc dddd eeee", &placed, &FakeMeasure::default());
            let fill = palette.label_fill.as_str();
            let title_line = 16.0 * 1.4;
            let detail_line = 14.0 * 1.4;
            let detail_top = 20.0 + 16.0 + title_line + 6.0;
            let want = vec![
                SceneNode::Shape(Box::new(ShapeSceneNode {
                    truncated: false,
                    overflows: false,
                    id: None,
                    bbox: BoundingBox {
                        x: 10.0,
                        y: 20.0,
                        w: 200.0,
                        h: 16.0 + title_line + 6.0 + 2.0 * detail_line + 16.0,
                    },
                    comment_chrome: false,
                    proposal_chrome: None,
                    radius: Some(palette.corner_radius_px),
                    shape: None,
                    appearance: Some(Appearance {
                        fill: Some(palette.node.file.fill.clone()),
                        stroke: Some(palette.node.file.stroke.clone()),
                        stroke_width: Some(1.0),
                        ..Appearance::default()
                    }),
                    task_box: None,
                    ink: None,
                })),
                run(26.0, 36.0, 5.0 * 9.6, "Title", 16.0, true, fill),
                run(26.0, detail_top, 19.0 * 8.4, "aaaa bbbb cccc dddd", 14.0, false, fill),
                run(26.0, detail_top + detail_line, 4.0 * 8.4, "eeee", 14.0, false, fill),
            ];
            assert_eq!(scene.nodes, want, "{mode:?}");
        }
    }

    #[test]
    fn a_line_wider_than_the_room_is_drawn_no_wider_than_the_room() {
        // 100px leaves 68px; "bbbbbbbbbbbbbbbbbbbb" is 168px at 14px.
        let scene = notice_scene(
            "T",
            "bbbbbbbbbbbbbbbbbbbb",
            &options(Some(100.0)),
            &FakeMeasure::default(),
        );
        let widths: Vec<f64> = scene
            .nodes
            .iter()
            .filter_map(|n| match n {
                SceneNode::TextRun(r) => Some(r.bbox.w),
                _ => None,
            })
            .collect();
        assert_eq!(widths, [9.6, 68.0]);
    }

    #[test]
    fn a_width_that_cannot_hold_the_padding_draws_runs_of_no_width() {
        let scene = notice_scene("T", "d", &options(Some(20.0)), &FakeMeasure::default());
        for node in &scene.nodes {
            if let SceneNode::TextRun(run) = node {
                assert_eq!(run.bbox.w.to_bits(), 0.0_f64.to_bits(), "{}", run.text);
            }
        }
    }

    #[test]
    fn the_trusted_measurer_answers_what_it_is_handed() {
        let fake = FakeMeasure::default();
        let trusted = Trusted { inner: &fake, doubted: Cell::new(false) };
        let at = font(14.0, 400.0);
        assert_eq!(
            trusted.advance_width("abc", &at).to_bits(),
            fake.advance_width("abc", &at).to_bits()
        );
        assert_eq!(trusted.vertical_metrics(&at), fake.vertical_metrics(&at));
        assert!(!trusted.doubted.get());
    }

    struct Broken(f64);

    impl Measure for Broken {
        fn advance_width(&self, _: &str, _: &FontDescriptor) -> f64 {
            self.0
        }
        fn vertical_metrics(&self, _: &FontDescriptor) -> VerticalMetrics {
            VerticalMetrics { ascent: 1.0, descent: 1.0, line_gap: 0.0 }
        }
    }

    /// A measurer whose advance is good and whose ascent is not.
    struct NoAscent;

    impl Measure for NoAscent {
        fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
            FakeMeasure::default().advance_width(text, font)
        }
        fn vertical_metrics(&self, _: &FontDescriptor) -> VerticalMetrics {
            VerticalMetrics { ascent: f64::NAN, descent: 1.0, line_gap: 0.0 }
        }
    }

    #[test]
    fn a_measurer_with_no_finite_ascent_is_replaced_by_the_ratio_estimate() {
        let got = notice_scene("Title", "some words", &options(None), &NoAscent);
        let ratio = notice_scene("Title", "some words", &options(None), &ConstantRatioMeasure);
        assert_eq!(got, ratio);
    }

    #[test]
    fn a_measurer_with_no_finite_advance_is_replaced_by_the_ratio_estimate() {
        let got =
            notice_scene("Title", "some words here", &options(Some(200.0)), &Broken(f64::NAN));
        let want =
            notice_scene("Title", "some words here", &options(Some(200.0)), &ConstantRatioMeasure);
        assert_eq!(got, want);
        let infinite = notice_scene("Title", "some words", &options(None), &Broken(f64::INFINITY));
        let ratio = notice_scene("Title", "some words", &options(None), &ConstantRatioMeasure);
        assert_eq!(infinite, ratio);
    }
}
