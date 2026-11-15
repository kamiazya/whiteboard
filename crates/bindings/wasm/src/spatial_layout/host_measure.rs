//! The host's own measurer, asked through the one import the bindings make
//! (ADR-0054 step 7, owner decision q77): the browser measures with a canvas
//! context, which no table of font bytes repeats, so a layout naming
//! `{kind: 'host'}` asks the host for each text it measures, synchronously,
//! from inside the layout.
//!
//! The host answers a whole `TextMetrics` per text, because the browser's
//! vertical metrics are not the font's alone (it answers no ascent for the
//! empty text). So every method here reads the host's answer for its own
//! text, and nothing splits it into a per-font half.
//!
//! Each distinct (text, font) is asked once per layout: the memo lives with
//! the value, one layout long, since a face that loads between two layouts
//! changes what the host answers.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use wasm_bindgen::prelude::{JsValue, wasm_bindgen};
use whiteboard_canvas_render::measure::{
    FontDescriptor, FontStyle, Measure, TextMetrics, VerticalMetrics,
};
use whiteboard_canvas_render::scene_wire::Tree;

/// What measures for a layout named `{kind: 'host'}`: the four numbers of
/// `TextMetrics` (advance, ascent, descent, line gap) for `text` in the font
/// `font` keys ([`font_key`]), or nothing when it cannot answer. An answer
/// holding a number that is not finite is taken as nothing.
pub trait Host {
    fn measure(&self, text: &str, font: &str) -> Option<[f64; 4]>;
}

#[wasm_bindgen]
extern "C" {
    /// The measurer the shim hands a layout: an object whose `measure(text,
    /// fontKey)` answers the four numbers.
    pub type HostMeasurer;

    #[wasm_bindgen(method, structural, catch, js_name = measure)]
    fn measure_in_host(this: &HostMeasurer, text: &str, font: &str) -> Result<Vec<f64>, JsValue>;
}

impl Host for HostMeasurer {
    /// A throw, or an answer that is not four numbers, is no answer.
    fn measure(&self, text: &str, font: &str) -> Option<[f64; 4]> {
        self.measure_in_host(text, font).ok()?.try_into().ok()
    }
}

/// `font` as the host reads it back: `[family, fallbackChain, weight, style,
/// sizePx]` in JSON, every number spelled so it parses to the same double;
/// nothing for a weight or size JSON cannot spell.
#[must_use]
pub fn font_key(font: &FontDescriptor) -> Option<String> {
    let style = match font.style {
        FontStyle::Normal => "normal",
        FontStyle::Italic => "italic",
    };
    let chain = font.fallback_chain.iter().map(|name| Tree::Text(name.clone())).collect();
    Tree::List(vec![
        Tree::Text(font.family.clone()),
        Tree::List(chain),
        Tree::Number(font.weight),
        Tree::Text(style.to_owned()),
        Tree::Number(font.size_px),
    ])
    .to_json()
    .ok()
}

const NOTHING: TextMetrics =
    TextMetrics { advance_width: 0.0, ascent: 0.0, descent: 0.0, line_gap: 0.0 };

/// A font a layout measured in: its key, and where what the host answered
/// for each text sits in `answers`.
struct Font {
    descriptor: FontDescriptor,
    key: Option<String>,
    // An index rather than the metrics: this map type is already linked, and
    // one holding the metrics cost the artifact 10 KB of its own B-tree.
    texts: BTreeMap<String, usize>,
}

/// One layout's measurer over `host`, each (font, text) asked once.
pub(crate) struct HostMeasure<'a> {
    host: &'a dyn Host,
    /// Searched in order: a layout measures in a handful of fonts.
    fonts: RefCell<Vec<Font>>,
    answers: RefCell<Vec<TextMetrics>>,
    failed: Cell<bool>,
}

impl<'a> HostMeasure<'a> {
    pub(crate) fn new(host: &'a dyn Host) -> Self {
        Self {
            host,
            fonts: RefCell::new(Vec::new()),
            answers: RefCell::new(Vec::new()),
            failed: Cell::new(false),
        }
    }

    /// Whether the host failed to answer once, which makes the whole layout
    /// one the core cannot vouch for.
    pub(crate) fn failed(&self) -> bool {
        self.failed.get()
    }

    /// What the host answers for `text` in `font`, asked at most once.
    fn answer(&self, text: &str, font: &FontDescriptor) -> Option<TextMetrics> {
        let mut fonts = self.fonts.borrow_mut();
        if !fonts.iter().any(|held| held.descriptor == *font) {
            let key = font_key(font);
            fonts.push(Font { descriptor: font.clone(), key, texts: BTreeMap::new() });
        }
        let held = fonts.iter_mut().find(|held| held.descriptor == *font)?;
        let mut answers = self.answers.borrow_mut();
        if let Some(hit) = held.texts.get(text) {
            return answers.get(*hit).copied();
        }
        // A number that is not finite is no answer: the TypeScript's measurer
        // clamps its own, so laying one out would part from it silently.
        let [advance_width, ascent, descent, line_gap] = self
            .host
            .measure(text, held.key.as_deref()?)
            .filter(|numbers| numbers.iter().all(|n| n.is_finite()))?;
        let metrics = TextMetrics { advance_width, ascent, descent, line_gap };
        held.texts.insert(text.to_owned(), answers.len());
        answers.push(metrics);
        Some(metrics)
    }
}

impl Measure for HostMeasure<'_> {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        self.measure(text, font).advance_width
    }

    /// The host's answer for the empty text: no measurer the host has
    /// answers a font's metrics apart from a text.
    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        let TextMetrics { ascent, descent, line_gap, .. } = self.measure("", font);
        VerticalMetrics { ascent, descent, line_gap }
    }

    fn measure(&self, text: &str, font: &FontDescriptor) -> TextMetrics {
        self.answer(text, font).unwrap_or_else(|| {
            self.failed.set(true);
            NOTHING
        })
    }
}
