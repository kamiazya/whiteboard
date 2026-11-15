//! A layout measured by the host's own measurer, through the one import.

use std::cell::RefCell;

use serde_json::{Value as Json, json};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure};

use super::host_measure::{Host, HostMeasure, font_key};
use super::layout_with_host;
use super::tests::{board, m, request};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A host that answers as `createFakeMeasure(0.6)` would, the empty text with
/// no ascent at all as the browser's measurer answers it, and records each ask.
#[derive(Default)]
struct Recording {
    asked: RefCell<Vec<(String, String)>>,
    refuse: bool,
}

/// What a font key spells, read back as the JavaScript side reads it.
fn descriptor_of(key: &str) -> FontDescriptor {
    let fields: Json = serde_json::from_str(key).unwrap_or(Json::Null);
    let text = |at: usize| fields.get(at).and_then(Json::as_str).unwrap_or_default().to_owned();
    let number = |at: usize| fields.get(at).and_then(Json::as_f64).unwrap_or(f64::NAN);
    let chain = fields.get(1).and_then(Json::as_array).cloned().unwrap_or_default();
    FontDescriptor {
        family: text(0),
        fallback_chain: chain.iter().filter_map(Json::as_str).map(str::to_owned).collect(),
        weight: number(2),
        style: if text(3) == "italic" { FontStyle::Italic } else { FontStyle::Normal },
        size_px: number(4),
    }
}

impl Host for Recording {
    fn measure(&self, text: &str, font: &str) -> Option<[f64; 4]> {
        self.asked.borrow_mut().push((text.to_owned(), font.to_owned()));
        if self.refuse {
            return None;
        }
        let metrics = FakeMeasure::new(0.6).measure(text, &descriptor_of(font));
        let ascent = if text.is_empty() { 0.0 } else { metrics.ascent };
        Some([metrics.advance_width, ascent, metrics.descent, metrics.line_gap])
    }
}

fn host() -> Json {
    m(&[("kind", json!("host"))])
}

fn answer(request: &str, host: Option<&dyn Host>) -> Json {
    serde_json::from_str(&layout_with_host(request, host)).unwrap_or(Json::Null)
}

const BODY: &str = "# Plan\n\nShip the *core*, then measure it.\n\n- one\n- two\n- one";

#[test]
fn a_host_measured_layout_is_the_layout_its_measurer_would_give() {
    let recording = Recording::default();
    let hosted = answer(&request(board(BODY), &[("measure", host())]), Some(&recording));
    let fake = answer(&request(board(BODY), &[]), None);
    assert_eq!(hosted.get(0), Some(&json!("ok")), "{hosted}");
    assert_eq!(hosted, fake);
}

#[test]
fn the_host_is_asked_once_per_text_and_font() {
    let recording = Recording::default();
    answer(&request(board(BODY), &[("measure", host())]), Some(&recording));
    let asked = recording.asked.borrow();
    let mut distinct = asked.clone();
    distinct.sort();
    distinct.dedup();
    assert!(asked.len() > 3, "{asked:?}");
    assert_eq!(asked.len(), distinct.len(), "{asked:?}");
}

#[test]
fn a_layout_with_no_host_or_a_host_that_fails_is_declined() {
    let hosted = request(board("hello"), &[("measure", host())]);
    assert_eq!(answer(&hosted, None), json!(["declined", "host-measure"]));
    let refusing = Recording { refuse: true, ..Recording::default() };
    assert_eq!(answer(&hosted, Some(&refusing)), json!(["declined", "host-measure"]));
    assert_eq!(answer(&request(board("hello"), &[]), Some(&refusing)).get(0), Some(&json!("ok")));
}

#[test]
fn a_host_measurer_names_no_handle() {
    let named = m(&[("kind", json!("host")), ("handle", json!(1))]);
    let got = answer(&request(board("hello"), &[("measure", named)]), None);
    assert_eq!(got, json!(["refused", "malformed", "request"]));
}

fn font(family: &str, size_px: f64) -> FontDescriptor {
    FontDescriptor {
        family: family.to_owned(),
        fallback_chain: vec!["Noto Sans".to_owned(), "sans-serif".to_owned()],
        weight: 600.0,
        style: FontStyle::Italic,
        size_px,
    }
}

fn key(font: &FontDescriptor) -> String {
    font_key(font).unwrap_or_default()
}

#[test]
fn a_font_key_reads_back_as_its_descriptor() {
    for descriptor in [font("Roboto", 14.5), font("Sketch \"Hand\"\u{1}", 0.0)] {
        assert_eq!(descriptor_of(&key(&descriptor)), descriptor);
    }
    let upright = FontDescriptor { style: FontStyle::Normal, ..font("Roboto", 14.0) };
    assert_eq!(descriptor_of(&key(&upright)), upright);
    assert_ne!(key(&font("Roboto", 14.0)), key(&font("Roboto", 15.0)));
    assert!(key(&font("Roboto", -0.0)).ends_with(",-0]"));
}

#[test]
fn a_font_json_cannot_spell_is_no_key_and_measures_nothing() {
    for size_px in [f64::NAN, f64::INFINITY] {
        assert_eq!(font_key(&font("Roboto", size_px)), None);
        let unspellable = FontDescriptor { weight: f64::NAN, ..font("Roboto", 10.0) };
        assert_eq!(font_key(&unspellable), None);
        let recording = Recording::default();
        let measure = HostMeasure::new(&recording);
        let nothing = measure.measure("word", &font("Roboto", size_px)).advance_width;
        assert_eq!(nothing.to_bits(), 0.0_f64.to_bits());
        assert!(measure.failed());
        assert!(recording.asked.borrow().is_empty());
    }
}

#[test]
fn every_metric_is_the_hosts_answer_for_that_text() {
    let recording = Recording::default();
    let measure = HostMeasure::new(&recording);
    let at = font("Roboto", 10.0);
    let word = measure.measure("word", &at);
    assert_eq!(word, FakeMeasure::new(0.6).measure("word", &at));
    assert_eq!(measure.advance_width("word", &at).to_bits(), word.advance_width.to_bits());
    let empty = measure.measure("", &at);
    assert_eq!((empty.advance_width, empty.ascent), (0.0, 0.0));
    let vertical = measure.vertical_metrics(&at);
    assert_eq!((vertical.ascent, vertical.descent), (empty.ascent, empty.descent));
    assert_eq!(recording.asked.borrow().len(), 2);
    assert!(!measure.failed());
}

#[test]
fn a_failed_answer_measures_nothing_and_is_remembered() {
    let refusing = Recording { refuse: true, ..Recording::default() };
    let measure = HostMeasure::new(&refusing);
    assert!(!measure.failed());
    let got = measure.measure("word", &font("Roboto", 10.0));
    assert_eq!((got.advance_width, got.ascent, got.descent, got.line_gap), (0.0, 0.0, 0.0, 0.0));
    assert!(measure.failed());
}
