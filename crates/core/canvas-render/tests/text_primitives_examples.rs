//! The text primitives' rules, one example each, in the numbers a reader can
//! check by hand: the fake measurer charges 6px per UTF-16 unit at 10px.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::inline_junction::{
    LineCursor, create_inline_junction, head_character, tail_character,
};
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle};
use whiteboard_canvas_render::truncate::{FittedText, fit_to_width};
use whiteboard_scene::{BoundingBox, RunPaint, TextRunNode};

fn font() -> FontDescriptor {
    FontDescriptor {
        family: "Inter".to_string(),
        fallback_chain: Vec::new(),
        weight: 400.0,
        style: FontStyle::Normal,
        size_px: 10.0,
    }
}

fn fit(text: &str, max: f64) -> FittedText<'_> {
    fit_to_width(text, &font(), &FakeMeasure::default(), max)
}

fn kept(text: &str, max: f64) -> (&str, bool, bool) {
    let f = fit(text, max);
    (f.text, f.truncated, f.overflows)
}

#[test]
fn an_unusable_width_returns_the_text_unchanged() {
    for max in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(kept("abcdef", max), ("abcdef", false, false), "{max}");
    }
}

#[test]
fn text_that_fits_is_returned_whole_and_the_edge_fits() {
    assert_eq!(kept("abcd", 24.0), ("abcd", false, false));
    assert_eq!(kept("abcd", 100.0), ("abcd", false, false));
    assert_eq!(kept("", 6.0), ("", false, false));
}

#[test]
fn text_that_does_not_fit_is_cut_to_the_longest_prefix_that_does() {
    assert_eq!(kept("abcdef", 18.0), ("abc", true, false));
    assert_eq!(kept("abcdef", 17.9), ("ab", true, false));
    assert_eq!(kept("abcdef", 35.9), ("abcde", true, false));
}

#[test]
fn something_always_stays_and_says_it_overflows() {
    assert_eq!(kept("abcdef", 1.0), ("a", true, true));
    assert_eq!(kept("a", 1.0), ("a", false, true), "the whole text, still too wide");
}

#[test]
fn a_cut_never_parts_a_grapheme() {
    // A combining acute is two units but one grapheme, 12px wide.
    assert_eq!(kept("ae\u{301}b", 12.0), ("a", true, false));
    assert_eq!(kept("ae\u{301}b", 18.0), ("ae\u{301}", true, false));
    // A family of three people joined by ZWJ is eight units, 48px.
    let family = "👨\u{200d}👩\u{200d}👧";
    assert_eq!(kept(family, 40.0), (family, false, true));
    assert_eq!(kept("a👨\u{200d}👩b", 30.0), ("a", true, false));
    // Two regional indicators are one flag.
    assert_eq!(kept("🇯🇵🇺🇸", 30.0), ("🇯🇵", true, false));
    // A CR LF pair is one grapheme.
    assert_eq!(kept("a\r\nb", 12.0), ("a", true, false));
    assert_eq!(kept("\r\nb", 6.0), ("\r\n", true, true));
}

#[test]
fn text_without_a_cluster_is_cut_between_code_points() {
    assert_eq!(kept("日本語日本語", 30.0), ("日本語日本", true, false));
    assert_eq!(kept("a𝔸b", 18.0), ("a𝔸", true, false));
    assert_eq!(kept("a𝔸b", 12.0), ("a", true, false));
}

fn run(x: f64, text: &str) -> TextRunNode {
    TextRunNode {
        bbox: BoundingBox { x, y: 0.0, w: 10.0, h: 20.0 },
        text: text.to_string(),
        emphasis: false,
        strong: false,
        code: false,
        deleted: false,
        link: None,
        truncated: false,
        overflows: false,
        appearance: None,
        paints: None,
        backdrop: None,
        backdrop_pad_x_px: None,
        annotates: None,
        baseline: Some(16.0),
    }
}

#[test]
fn the_character_a_break_is_taken_against_is_a_code_point_or_nothing() {
    assert_eq!(head_character("layout", None), Some('l'));
    assert_eq!(tail_character("layout", None), Some('t'));
    assert_eq!(head_character("𝟙x", None), Some('𝟙'));
    assert_eq!(tail_character("x𝟙", None), Some('𝟙'));
    assert_eq!(head_character(" x", None), None);
    assert_eq!(tail_character("x ", None), None);
    assert_eq!(head_character("", None), None);
    assert_eq!(tail_character("", None), None);
}

#[test]
fn a_run_that_paints_answers_the_object_replacement_character() {
    let icon = RunPaint::Icon { name: "star".to_string() };
    assert_eq!(head_character(" ", Some(&icon)), Some('\u{fffc}'));
    assert_eq!(tail_character(" ", Some(&icon)), Some('\u{fffc}'));
}

#[test]
fn ecmascript_whitespace_is_not_unicode_whitespace() {
    // U+FEFF is `\s` in ECMAScript and not White_Space; U+0085 is the reverse.
    assert_eq!(head_character("\u{feff}a", None), None);
    assert_eq!(head_character("\u{85}a", None), Some('\u{85}'));
    for edge in [
        '\t', '\u{b}', '\u{c}', '\r', '\u{a0}', '\u{1680}', '\u{200a}', '\u{2028}', '\u{2029}',
        '\u{202f}', '\u{205f}', '\u{3000}',
    ] {
        assert_eq!(head_character(&edge.to_string(), None), None, "{edge:?}");
    }
    for edge in [
        '\u{200b}', '\u{180e}', '\u{2060}', '\u{8}', '\u{e}', '\u{1fff}', '\u{200b}', '\u{3001}',
        '\u{2010}',
    ] {
        assert_eq!(head_character(&edge.to_string(), None), Some(edge), "{edge:?}");
    }
}

fn after(text: &str) -> whiteboard_canvas_render::inline_junction::InlineJunction {
    let mut junction = create_inline_junction(20.0);
    junction.placed(text, None, &[], &LineCursor { x: 0.0, index: 0 });
    junction
}

#[test]
fn a_closing_mark_may_not_open_a_line_after_a_letter_and_may_after_a_space() {
    assert!(!after("t").breakable_before(Some('。')));
    assert!(!after("t").breakable_before(Some('、')));
    assert!(after("t ").breakable_before(Some('。')));
    assert!(after("t").breakable_before(None));
    assert!(after("").breakable_before(Some('。')));
}

#[test]
fn an_opening_mark_may_not_end_a_line_and_two_ideographs_may_part() {
    assert!(!after("「").breakable_before(Some('日')));
    assert!(after("日").breakable_before(Some('本')));
    assert!(!after("a").breakable_before(Some('b')));
}

#[test]
fn a_picture_forbids_a_closing_mark_after_it_but_not_a_letter() {
    let icon = RunPaint::Icon { name: "star".to_string() };
    let mut junction = create_inline_junction(20.0);
    junction.placed(" ", Some(&icon), &[], &LineCursor { x: 0.0, index: 0 });
    assert!(!junction.breakable_before(Some('。')));
    assert!(junction.breakable_before(Some('a')));
}

#[test]
fn a_forbidden_break_moves_the_stretch_down_and_starts_a_line() {
    let mut line = LineCursor { x: 0.0, index: 0 };
    let mut junction = create_inline_junction(20.0);
    let mut runs = vec![run(0.0, "ab")];
    line.x = 10.0;
    junction.placed("ab", None, &runs, &line);
    // Nothing allowed a break before the first run, so the stretch IS the line.
    assert!(!junction.relocate_cluster(&mut runs, &mut line));
    junction.start_line(&runs, &mut line);
    assert_eq!((line.x, line.index), (0.0, 1));
    runs.push(run(0.0, "cd"));
    line.x = 10.0;
    junction.placed("cd", None, &runs, &line);
    runs.push(run(10.0, "ef"));
    line.x = 20.0;
    junction.placed("ef", None, &runs, &line);
    // A break was allowed at the start of the second line, so the whole line is one stretch.
    assert!(!junction.relocate_cluster(&mut runs, &mut line));
    junction.allow_break_here(&runs, &line);
    runs.push(run(20.0, "。"));
    line.x = 30.0;
    junction.placed("。", None, &runs, &line);
    assert!(junction.relocate_cluster(&mut runs, &mut line));
    assert_eq!((line.x, line.index), (10.0, 2));
    let moved = runs.get(3).map(|r| (r.bbox.x, r.bbox.y));
    assert_eq!(moved, Some((0.0, 20.0)));
    assert_eq!(runs.get(2).map(|r| r.bbox.x), Some(10.0), "the run before the cluster stays");
}
