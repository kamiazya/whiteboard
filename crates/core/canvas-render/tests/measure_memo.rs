//! The per-layout memo: it changes how often the inner measurer is asked and
//! nothing about what it answers.

use std::cell::Cell;
use std::collections::BTreeSet;

use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{
    FontDescriptor, FontStyle, Measure, VerticalMetrics, clamp_advance,
};
use whiteboard_canvas_render::measure_memo::MeasureMemo;
use whiteboard_proptest::proptest::prelude::{Just, Strategy, prop, prop_assert_eq, prop_oneof};
use whiteboard_proptest::{Floor, check};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// Answers from every field of the descriptor, so a memo that conflated two
/// fonts would return the wrong number as well as skip a call.
struct Counting {
    advances: Cell<u32>,
    verticals: Cell<u32>,
}

impl Counting {
    fn new() -> Self {
        Self { advances: Cell::new(0), verticals: Cell::new(0) }
    }
}

fn mix(font: &FontDescriptor) -> f64 {
    let style = if font.style == FontStyle::Italic { 0.5 } else { 0.0 };
    let shape = f64::from(
        u32::try_from(font.family.len() * 7 + font.fallback_chain.len() * 3).unwrap_or(0),
    );
    shape + font.weight + style + font.size_px
}

impl Measure for Counting {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        self.advances.set(self.advances.get() + 1);
        FakeMeasure::default().advance_width(text, font) + mix(font)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        self.verticals.set(self.verticals.get() + 1);
        VerticalMetrics { ascent: mix(font), descent: 1.0, line_gap: 2.0 }
    }
}

fn font(family: &str, chain: &[&str], weight: f64, style: FontStyle, size: f64) -> FontDescriptor {
    FontDescriptor {
        family: family.to_owned(),
        fallback_chain: chain.iter().map(|s| (*s).to_owned()).collect(),
        weight,
        style,
        size_px: size,
    }
}

fn base() -> FontDescriptor {
    font("Inter", &["sans-serif"], 400.0, FontStyle::Normal, 12.0)
}

#[test]
fn a_repeated_question_reaches_the_inner_measurer_once() {
    let inner = Counting::new();
    let memo = MeasureMemo::new(&inner);
    let first = memo.advance_width("hello", &base());
    let vertical = memo.vertical_metrics(&base());
    for _ in 0..5 {
        assert_eq!(memo.advance_width("hello", &base()).to_bits(), first.to_bits());
        assert_eq!(memo.vertical_metrics(&base()), vertical);
    }
    assert_eq!((inner.advances.get(), inner.verticals.get()), (1, 1));
    // A second memo shares nothing with the first: it asks again.
    let other = MeasureMemo::new(&inner);
    other.advance_width("hello", &base());
    assert_eq!(inner.advances.get(), 2);
}

#[test]
fn every_field_of_a_font_and_the_text_is_part_of_the_key() {
    let variants = [
        base(),
        font("Roboto", &["sans-serif"], 400.0, FontStyle::Normal, 12.0),
        font("Inter", &["serif"], 400.0, FontStyle::Normal, 12.0),
        font("Inter", &["sans-serif", "serif"], 400.0, FontStyle::Normal, 12.0),
        font("Inter", &["sans-serif"], 700.0, FontStyle::Normal, 12.0),
        font("Inter", &["sans-serif"], 400.0, FontStyle::Italic, 12.0),
        font("Inter", &["sans-serif"], 400.0, FontStyle::Normal, 13.0),
        font("Inter", &["sans-serif"], 400.0, FontStyle::Normal, -0.0),
        font("Inter", &["sans-serif"], 400.0, FontStyle::Normal, 0.0),
    ];
    let inner = Counting::new();
    let memo = MeasureMemo::new(&inner);
    for pass in 0..2 {
        for f in &variants {
            memo.advance_width("a", f);
            memo.advance_width("b", f);
            memo.vertical_metrics(f);
        }
        // Nothing is asked again on the second pass.
        assert_eq!(inner.advances.get(), 18, "pass {pass}");
        assert_eq!(inner.verticals.get(), 9, "pass {pass}");
    }
}

#[test]
fn the_empty_text_and_a_nan_answer_are_cached_like_any_other() {
    let nan_font = font("Inter", &[], 400.0, FontStyle::Normal, f64::NAN);
    let inner = Counting::new();
    let memo = MeasureMemo::new(&inner);
    for _ in 0..3 {
        assert_eq!(memo.advance_width("", &base()).to_bits(), mix(&base()).to_bits());
        assert!(memo.advance_width("x", &nan_font).is_nan());
    }
    assert_eq!(inner.advances.get(), 2);
    assert_eq!(clamp_advance(memo.advance_width("x", &nan_font)).to_bits(), 0.0_f64.to_bits());
}

/// A pool rather than free fields: two draws are the same font often enough
/// for the memo to be asked again, and every member differs from the first in
/// one field, `-0` and NaN sizes included.
fn arb_font() -> impl Strategy<Value = FontDescriptor> {
    let pool = vec![
        base(),
        font("Roboto", &["sans-serif"], 400.0, FontStyle::Normal, 12.0),
        font("Inter", &[], 400.0, FontStyle::Normal, 12.0),
        font("Inter", &["sans-serif"], 700.0, FontStyle::Normal, 12.0),
        font("Inter", &["sans-serif"], 400.0, FontStyle::Italic, 12.0),
        font("Inter", &["sans-serif"], 400.0, FontStyle::Normal, 0.0),
        font("Inter", &["sans-serif"], 400.0, FontStyle::Normal, -0.0),
        font("Inter", &["sans-serif"], 400.0, FontStyle::Normal, f64::NAN),
    ];
    prop::sample::select(pool)
}

fn arb_text() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(String::new()),
        Just("a".to_owned()),
        Just("\u{65e5}\u{672c}".to_owned()),
        Just("e\u{301}".to_owned()),
        "[a-b]{0,2}",
    ]
}

fn key_of(text: &str, f: &FontDescriptor) -> (String, String, Vec<String>, u64, bool, u64) {
    (
        text.to_owned(),
        f.family.clone(),
        f.fallback_chain.clone(),
        f.weight.to_bits(),
        f.style == FontStyle::Italic,
        f.size_px.to_bits(),
    )
}

#[test]
fn a_memo_answers_as_its_measurer_does_and_asks_it_once_per_distinct_key() {
    let repeated = Floor::new("a sequence that asks some key again");
    check(prop::collection::vec((arb_text(), arb_font()), 0..40), None, |asks| {
        let bare = Counting::new();
        let inner = Counting::new();
        let memo = MeasureMemo::new(&inner);
        let mut keys = BTreeSet::new();
        let mut fonts = BTreeSet::new();
        for (text, f) in &asks {
            keys.insert(key_of(text, f));
            fonts.insert(key_of("", f));
            let got = memo.measure(text, f);
            let want = bare.measure(text, f);
            prop_assert_eq!(got.advance_width.to_bits(), want.advance_width.to_bits());
            prop_assert_eq!(got.ascent.to_bits(), want.ascent.to_bits());
            prop_assert_eq!(got.descent.to_bits(), want.descent.to_bits());
            prop_assert_eq!(got.line_gap.to_bits(), want.line_gap.to_bits());
        }
        repeated.draw(keys.len() < asks.len());
        prop_assert_eq!(inner.advances.get() as usize, keys.len());
        prop_assert_eq!(inner.verticals.get() as usize, fonts.len());
        Ok(())
    });
    repeated.assert(100);
}
