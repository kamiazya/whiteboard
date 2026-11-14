//! The passage highlights against the recorded TypeScript answers
//! (`passage-highlight.jsonl`): the model's occurrence search, the scored
//! range and the anchor's resolution, the loose search over squashed
//! whitespace, and the highlights drawn over runs — each box compared by its
//! bits, with every question put to the measurer.

use std::cell::RefCell;

use serde::Deserialize;
use whiteboard_canvas_render::comments::loose::loose_occurrences;
use whiteboard_canvas_render::comments::passage::{
    NodePassage, PassagePaint, PlacedRun, compose_passage_highlights,
};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure, VerticalMetrics};
use whiteboard_model::text_anchor::{
    TextAnchor, TextQuote, resolve_text_anchor, scored_occurrence_range, text_occurrences,
};
use whiteboard_scene::{Appearance, BoundingBox, SceneNode, TextRunNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuoteWire {
    prefix: Option<String>,
    exact: String,
    suffix: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RunWire {
    text: String,
    bbox: [String; 4],
    emphasis: bool,
    strong: bool,
    paint: Option<PaintWire>,
    /// What enclosing list items and table cells shift the run by; absent is 0.
    offset_x: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PaintWire {
    family: Option<String>,
    size: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PassageWire {
    thread_id: String,
    quote: QuoteWire,
    start: usize,
    end: usize,
    resolved: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Drawn {
    shapes: Vec<(String, [String; 4], Option<String>)>,
    calls: Vec<Call>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Record {
    Occurrences {
        haystack: String,
        needle: String,
        answer: Vec<usize>,
    },
    Scored {
        sorted: Vec<usize>,
        around: usize,
        max: usize,
        answer: (usize, usize),
    },
    Resolve {
        body: String,
        quote: QuoteWire,
        start: usize,
        end: usize,
        answer: Option<(usize, usize)>,
    },
    Loose {
        text: String,
        quote: String,
        answer: Vec<(usize, usize)>,
    },
    Highlights {
        runs: Vec<RunWire>,
        passages: Vec<PassageWire>,
        source: String,
        measure: String,
        answer: Drawn,
    },
}

type Res<T> = Result<T, String>;

/// One measurer question: text, family, size's bits, weight and slant.
type Call = (String, String, String, f64, String);

fn f64_of(hex: &str) -> Res<f64> {
    u64::from_str_radix(hex, 16).map(f64::from_bits).map_err(|e| format!("{hex}: {e}"))
}

fn hex(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn quote_of(wire: &QuoteWire) -> TextQuote {
    TextQuote {
        prefix: wire.prefix.clone(),
        exact: wire.exact.clone(),
        suffix: wire.suffix.clone(),
    }
}

/// What enclosing list items and table cells shift a run by; absent is 0.
fn offset_of(wire: &RunWire) -> Res<f64> {
    wire.offset_x.as_deref().map_or(Ok(0.0), f64_of)
}

fn run_of(wire: &RunWire) -> Res<TextRunNode> {
    let [x, y, w, h] = &wire.bbox;
    let appearance = match &wire.paint {
        None => None,
        Some(paint) => Some(Appearance {
            font_family: paint.family.clone(),
            font_size: paint.size.as_deref().map(f64_of).transpose()?,
            ..Appearance::default()
        }),
    };
    Ok(TextRunNode {
        bbox: BoundingBox { x: f64_of(x)?, y: f64_of(y)?, w: f64_of(w)?, h: f64_of(h)? },
        text: wire.text.clone(),
        emphasis: wire.emphasis,
        strong: wire.strong,
        code: false,
        deleted: false,
        link: None,
        truncated: false,
        overflows: false,
        appearance,
        paints: None,
        backdrop: None,
        backdrop_pad_x_px: None,
        annotates: None,
        baseline: None,
    })
}

/// The recording's measurers, noting each question.
struct Asking {
    odd: bool,
    base: FakeMeasure,
    asked: RefCell<Vec<Call>>,
}

impl Measure for Asking {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        let style = match font.style {
            FontStyle::Normal => "normal",
            FontStyle::Italic => "italic",
        };
        self.asked.borrow_mut().push((
            text.to_owned(),
            font.family.clone(),
            hex(font.size_px),
            font.weight,
            style.to_owned(),
        ));
        if !self.odd {
            return self.base.advance_width(text, font);
        }
        if text.contains('b') {
            return f64::NAN;
        }
        let length = f64::from(u32::try_from(units(text).len()).unwrap_or(u32::MAX));
        length * 7.0 - if text.contains('z') { 1000.0 } else { 0.0 }
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        self.base.vertical_metrics(font)
    }
}

fn differ<T: PartialEq + std::fmt::Debug>(what: &str, got: &T, want: &T) -> Res<()> {
    if got == want { Ok(()) } else { Err(format!("{what}: got {got:?}, recorded {want:?}")) }
}

fn replay_highlights(
    runs: &[RunWire],
    passages: &[PassageWire],
    source: &str,
    measure: &str,
    want: &Drawn,
) -> Res<()> {
    let offsets = runs.iter().map(offset_of).collect::<Res<Vec<_>>>()?;
    let runs = runs.iter().map(run_of).collect::<Res<Vec<_>>>()?;
    let anchors: Vec<TextAnchor> = passages
        .iter()
        .map(|p| TextAnchor {
            node_id: Some("n".to_owned()),
            quote: quote_of(&p.quote),
            start: p.start,
            end: p.end,
        })
        .collect();
    let passages: Vec<NodePassage<'_>> = passages
        .iter()
        .zip(&anchors)
        .map(|(p, anchor)| NodePassage { thread_id: &p.thread_id, anchor, resolved: p.resolved })
        .collect();
    let open = Appearance { fill: Some("#ff0".to_owned()), ..Appearance::default() };
    let resolved = Appearance { fill: Some("#888".to_owned()), ..Appearance::default() };
    let paint = PassagePaint { open: Some(&open), resolved: Some(&resolved) };
    let measure = Asking {
        odd: measure == "odd",
        base: FakeMeasure::default(),
        asked: RefCell::new(Vec::new()),
    };
    let refs: Vec<PlacedRun<'_>> =
        runs.iter().zip(offsets).map(|(run, offset_x)| PlacedRun { run, offset_x }).collect();
    let drawn = compose_passage_highlights(&passages, &refs, &measure, paint, &units(source));
    let mut shapes = Vec::new();
    for node in &drawn {
        let SceneNode::Shape(shape) = node else { return Err(format!("{node:?}")) };
        differ("comment chrome", &(shape.comment_chrome, shape.radius), &(true, Some(2.0)))?;
        let look = match &shape.appearance {
            Some(a) if *a == open => Some("open".to_owned()),
            Some(a) if *a == resolved => Some("resolved".to_owned()),
            _ => None,
        };
        let b = &shape.bbox;
        shapes.push((shape.id.clone().unwrap_or_default(), [b.x, b.y, b.w, b.h].map(hex), look));
    }
    differ("shapes", &shapes, &want.shapes)?;
    differ("measurer calls", &*measure.asked.borrow(), &want.calls)
}

fn replay(record: &Record) -> Res<()> {
    match record {
        Record::Occurrences { haystack, needle, answer } => {
            differ("occurrences", &text_occurrences(&units(haystack), &units(needle)), answer)
        }
        Record::Scored { sorted, around, max, answer } => {
            let range = scored_occurrence_range(sorted, *around, *max);
            differ("scored range", &(range.from, range.to), answer)
        }
        Record::Resolve { body, quote, start, end, answer } => {
            let anchor =
                TextAnchor { node_id: None, quote: quote_of(quote), start: *start, end: *end };
            let placed = resolve_text_anchor(&units(body), &anchor).map(|p| (p.start, p.end));
            differ("resolution", &placed, answer)
        }
        Record::Loose { text, quote, answer } => {
            let spans: Vec<(usize, usize)> = loose_occurrences(&units(text), &units(quote))
                .iter()
                .map(|span| (span.start, span.end))
                .collect();
            differ("loose occurrences", &spans, answer)
        }
        Record::Highlights { runs, passages, source, measure, answer } => {
            replay_highlights(runs, passages, source, measure, answer)
        }
    }
}

#[test]
fn every_recorded_passage_answer_is_reproduced_to_the_last_bit() {
    let text =
        include_str!("../../../../packages/canvas-render/src/oracle/passage-highlight.jsonl");
    let mut failures = Vec::new();
    let mut count = 0;
    for (at, line) in text.lines().enumerate() {
        count += 1;
        let outcome = serde_json::from_str::<Record>(line)
            .map_err(|e| e.to_string())
            .and_then(|record| replay(&record));
        if let Err(e) = outcome {
            failures.push(format!("line {}: {e}", at + 1));
        }
    }
    assert!(count > 1000, "{count} records");
    assert!(
        failures.is_empty(),
        "{} differ, the first in full:\n{}\n{}",
        failures.len(),
        failures.first().map_or("", String::as_str),
        failures
            .iter()
            .map(|f| f.chars().take(160).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    );
}
