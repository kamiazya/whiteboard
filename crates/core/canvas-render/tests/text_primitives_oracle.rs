//! The text primitives against the recorded TypeScript answers.
//!
//! `packages/canvas-render/src/oracle/text-primitives.jsonl` holds what
//! `uaxSegments`, `longestFittingCount`, `fitToWidth` and the inline junction
//! answered, measured by the fake measurer so every width is exact: small
//! corpora string by string, and for the large ones (a seeded stream of mixed
//! strings fitted to widths on a prefix's edge, a sweep of every gallop, the
//! grapheme segmenter's census) one digest per chunk, which this test
//! regenerates from the `meta` record. Its TypeScript test fails when the file
//! no longer equals the TypeScript's answer; this replays it.

use std::cell::RefCell;
use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::inline_junction::{
    InlineJunction, LineCursor, create_inline_junction, head_character, tail_character,
};
use whiteboard_canvas_render::longest_fit::longest_fitting_count;
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure, VerticalMetrics};
use whiteboard_canvas_render::truncate::fit_to_width;
use whiteboard_canvas_render::uax_segments::{uax_segment_ranges, uax_segments};
use whiteboard_scene::{BoundingBox, RunPaint, TextRunNode};

const RECORDING: &str =
    include_str!("../../../../packages/canvas-render/src/oracle/text-primitives.jsonl");

const LINE_HEIGHT: f64 = 20.0;

/// How a code point is put in a context for the census.
type Shape = fn(char) -> String;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Record {
    Meta(Meta),
    Uax { t: String, s: Vec<String>, e: Vec<usize> },
    Uaxu { u: Vec<u16>, e: Vec<usize> },
    Grapheme { t: String, g: Vec<usize> },
    Longest { limit: usize, guess: usize, threshold: usize, r: usize, p: Vec<usize> },
    Fit(Fit),
    Edge { t: String, p: Option<String>, head: String, tail: String },
    Junction { ops: Vec<Op>, out: Vec<Value>, runs: Vec<[String; 2]>, line: Line },
    Digest { c: String, k: u32, n: usize, h: u32 },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Meta {
    mixed: Mixed,
    alphabet: Vec<u32>,
    combos: Vec<[String; 2]>,
    #[serde(rename = "graphemeReps")]
    grapheme_reps: Vec<u32>,
    #[serde(rename = "longestLimits")]
    longest_limits: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mixed {
    seed: u32,
    count: u32,
    chunk: u32,
    #[serde(rename = "minLen")]
    min_len: u32,
    #[serde(rename = "maxLen")]
    max_len: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fit {
    t: String,
    f: String,
    s: String,
    m: String,
    r: String,
    tr: bool,
    ov: bool,
    w: String,
    calls: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(tag = "o", rename_all = "lowercase", deny_unknown_fields)]
enum Op {
    Push { t: String, p: Option<String>, w: f64 },
    Placed { t: String, p: Option<String> },
    Breakable { t: String, p: Option<String> },
    Head { t: String, p: Option<String> },
    Tail { t: String, p: Option<String> },
    Allow,
    Start,
    Reloc,
}

#[derive(Deserialize)]
struct Line {
    x: String,
    index: usize,
}

struct Recording {
    meta: Meta,
    records: Vec<Record>,
    /// (corpus, chunk) -> (entries in it, digest).
    digests: BTreeMap<(String, u32), (usize, u32)>,
}

fn load() -> Result<Recording, String> {
    let mut meta = None;
    let mut records = Vec::new();
    let mut digests = BTreeMap::new();
    for (i, line) in RECORDING.lines().enumerate() {
        match serde_json::from_str::<Record>(line).map_err(|e| format!("line {i}: {e}"))? {
            Record::Meta(m) => meta = Some(m),
            Record::Digest { c, k, n, h } => {
                digests.insert((c, k), (n, h));
            }
            other => records.push(other),
        }
    }
    let meta = meta.ok_or_else(|| "no meta record".to_string())?;
    Ok(Recording { meta, records, digests })
}

/// A double from its 16 hex digits; a malformed one is NaN, which no recorded
/// answer equals bit for bit.
fn bits(hex: &str) -> f64 {
    u64::from_str_radix(hex, 16).map_or(f64::NAN, f64::from_bits)
}

fn hex(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// The UTF-16 end of every grapheme of `text`, by `unicode-segmentation`.
fn grapheme_ends(text: &str) -> Vec<usize> {
    let mut at = 0;
    text.graphemes(true)
        .map(|g| {
            at += g.encode_utf16().count();
            at
        })
        .collect()
}

fn paint(name: Option<&String>) -> Option<RunPaint> {
    name.map(|n| match n.as_str() {
        "icon" => RunPaint::Icon { name: "star".to_string() },
        _ => RunPaint::Image { src: "a.png".to_string() },
    })
}

/// FNV-1a over 32-bit words, as the TypeScript digest.
struct Digest(u32);

impl Digest {
    fn new() -> Self {
        Self(0x811c_9dc5)
    }
    fn feed(&mut self, word: u32) {
        self.0 = (self.0 ^ word).wrapping_mul(16_777_619);
    }
    fn feed_len(&mut self, n: usize) {
        self.feed(u32::try_from(n).unwrap_or(u32::MAX));
    }
    fn end(&mut self) {
        self.feed(0xffff_ffff);
    }
}

/// mulberry32, the seeded stream of the mixed corpus.
fn mulberry32(seed: u32) -> impl FnMut() -> u32 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b_79f5);
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(0x3d | t)) ^ t;
        t ^ (t >> 14)
    }
}

/// A fake measurer that keeps the UTF-16 length of everything it measures.
struct Counting {
    inner: FakeMeasure,
    calls: RefCell<Vec<usize>>,
}

impl Measure for Counting {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        self.calls.borrow_mut().push(text.encode_utf16().count());
        self.inner.advance_width(text, font)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        self.inner.vertical_metrics(font)
    }
}

fn font(size_px: f64) -> FontDescriptor {
    FontDescriptor {
        family: "Inter".to_string(),
        fallback_chain: Vec::new(),
        weight: 400.0,
        style: FontStyle::Normal,
        size_px,
    }
}

struct FitAnswer {
    text: String,
    truncated: bool,
    overflows: bool,
    width: String,
    calls: Vec<usize>,
}

fn fit_answer(text: &str, factor: f64, size: f64, max: f64) -> FitAnswer {
    let measure = Counting { inner: FakeMeasure::new(factor), calls: RefCell::new(Vec::new()) };
    let fitted = fit_to_width(text, &font(size), &measure, max);
    let calls = measure.calls.take();
    let width = hex(measure.inner.advance_width(fitted.text, &font(size)));
    FitAnswer {
        text: fitted.text.to_string(),
        truncated: fitted.truncated,
        overflows: fitted.overflows,
        width,
        calls,
    }
}

fn feed_fit(digest: &mut Digest, answer: &FitAnswer) {
    for unit in utf16(&answer.text) {
        digest.feed(u32::from(unit));
    }
    digest.feed(u32::from(answer.truncated) | (u32::from(answer.overflows) << 1));
    for &call in &answer.calls {
        digest.feed_len(call);
    }
    digest.end();
}

/// The double just below a positive finite one; anything else unchanged.
fn next_down(value: f64) -> f64 {
    if value > 0.0 && value.is_finite() { f64::from_bits(value.to_bits() - 1) } else { value }
}

fn expect_digest(rec: &Recording, corpus: &str, k: u32, count: usize, digest: &Digest) {
    assert_eq!(
        rec.digests.get(&(corpus.to_string(), k)),
        Some(&(count, digest.0)),
        "{corpus} chunk {k}: recorded (entries, digest)"
    );
}

fn longest(limit: usize, guess: usize, threshold: usize) -> (Vec<usize>, usize) {
    let mut probes = Vec::new();
    let answer = longest_fitting_count(
        |n| {
            probes.push(n);
            n <= threshold
        },
        limit,
        guess,
    );
    (probes, answer)
}

#[test]
fn every_text_divides_into_the_segments_the_typescript_cut() {
    let rec = load().expect("the recording reads");
    let mut texts = 0;
    for record in &rec.records {
        match record {
            Record::Uax { t, s, e } => {
                texts += 1;
                assert_eq!(&uax_segments(t), s, "{t:?}");
                let ends: Vec<usize> =
                    uax_segment_ranges(&utf16(t)).iter().map(|r| r.end).collect();
                assert_eq!(&ends, e, "{t:?}");
            }
            Record::Uaxu { u, e } => {
                texts += 1;
                let ends: Vec<usize> = uax_segment_ranges(u).iter().map(|r| r.end).collect();
                assert_eq!(&ends, e, "{u:04x?}");
            }
            _ => {}
        }
    }
    assert!(texts > 80, "{texts} segmented texts");
}

#[test]
fn every_text_has_the_grapheme_ends_intl_segmenter_gave_it() {
    let rec = load().expect("the recording reads");
    let mut texts = 0;
    for record in &rec.records {
        if let Record::Grapheme { t, g } = record {
            texts += 1;
            assert_eq!(&grapheme_ends(t), g, "{t:?}");
        }
    }
    assert!(texts > 50, "{texts} segmented texts");
}

#[test]
fn every_recorded_search_probes_and_answers_as_the_typescript_did() {
    let rec = load().expect("the recording reads");
    let mut searches = 0;
    for record in &rec.records {
        if let Record::Longest { limit, guess, threshold, r, p } = record {
            searches += 1;
            assert_eq!(
                longest(*limit, *guess, *threshold),
                (p.clone(), *r),
                "{limit} {guess} {threshold}"
            );
        }
    }
    assert!(searches > 150, "{searches} searches");
}

#[test]
fn every_gallop_up_to_the_sweep_limit_probes_as_recorded() {
    let rec = load().expect("the recording reads");
    for limit in 0..=rec.meta.longest_limits {
        let mut digest = Digest::new();
        let mut count = 0;
        for guess in 0..=limit + 3 {
            for threshold in 0..=limit {
                let (probes, answer) = longest(limit, guess, threshold);
                for probe in probes {
                    digest.feed_len(probe);
                }
                digest.feed_len(answer);
                digest.end();
                count += 1;
            }
        }
        expect_digest(&rec, "longest-sweep", u32::try_from(limit).expect("small"), count, &digest);
    }
}

#[test]
fn every_recorded_fit_keeps_the_text_the_typescript_kept() {
    let rec = load().expect("the recording reads");
    let mut fits = 0;
    for record in &rec.records {
        let Record::Fit(f) = record else { continue };
        fits += 1;
        let got = fit_answer(&f.t, bits(&f.f), bits(&f.s), bits(&f.m));
        assert_eq!(
            (&got.text, got.truncated, got.overflows, &got.width, &got.calls),
            (&f.r, f.tr, f.ov, &f.w, &f.calls),
            "{:?} fitted to {} (factor {}, size {})",
            f.t,
            bits(&f.m),
            bits(&f.f),
            bits(&f.s)
        );
    }
    assert!(fits > 900, "{fits} fits");
}

#[test]
fn a_seeded_stream_of_mixed_strings_fits_as_recorded() {
    let rec = load().expect("the recording reads");
    let Mixed { seed, count, chunk, min_len, max_len } = rec.meta.mixed;
    assert!(count >= 20_000, "{count} strings");
    let alphabet: Vec<char> =
        rec.meta.alphabet.iter().map(|&cp| char::from_u32(cp).expect("a scalar value")).collect();
    for k in 0..count / chunk {
        let mut next = mulberry32(seed.wrapping_add(k));
        let mut digest = Digest::new();
        for _ in 0..chunk {
            let length = min_len + next() % (max_len - min_len + 1);
            let text: String =
                (0..length).map(|_| alphabet[next() as usize % alphabet.len()]).collect();
            let combo = &rec.meta.combos[next() as usize % rec.meta.combos.len()];
            let (factor, size) = (bits(&combo[0]), bits(&combo[1]));
            let units = text.encode_utf16().count();
            let exact =
                f64::from(next() % u32::try_from(units + 2).expect("small")) * factor * size;
            let max = match next() % 3 {
                0 => exact,
                1 => next_down(exact),
                _ => exact + (factor * size) / 2.0,
            };
            feed_fit(&mut digest, &fit_answer(&text, factor, size, max));
        }
        expect_digest(&rec, "fit-mixed", k, chunk as usize, &digest);
    }
}

fn digest_of_joined(entries: &[String]) -> Digest {
    let mut digest = Digest::new();
    for end in grapheme_ends(&entries.join("\u{0}")) {
        digest.feed_len(end);
    }
    digest.end();
    digest
}

#[test]
fn every_ordered_triple_of_grapheme_representatives_segments_as_recorded() {
    let rec = load().expect("the recording reads");
    let reps = &rec.meta.grapheme_reps;
    assert_eq!(reps.len(), 60);
    for (k, &a) in reps.iter().enumerate() {
        let entries: Vec<String> = reps
            .iter()
            .flat_map(|&b| reps.iter().map(move |&c| [a, b, c]))
            .map(|cps| cps.iter().filter_map(|&cp| char::from_u32(cp)).collect())
            .collect();
        let digest = digest_of_joined(&entries);
        expect_digest(
            &rec,
            "grapheme-triples",
            u32::try_from(k).expect("small"),
            entries.len(),
            &digest,
        );
    }
}

#[test]
fn every_code_point_between_letters_or_after_a_conjunct_segments_as_recorded() {
    let rec = load().expect("the recording reads");
    let shapes: [(&str, Shape); 2] = [
        ("grapheme-census-between", |c| format!("a{c}a")),
        ("grapheme-census-conjunct", |c| format!("\u{915}\u{94d}{c}")),
    ];
    for (corpus, shape) in shapes {
        for k in 0..=0x10_ffff_u32 >> 12 {
            let last = (k * 4096 + 4095).min(0x10_ffff);
            let entries: Vec<String> =
                (k * 4096..=last).filter_map(char::from_u32).map(shape).collect();
            expect_digest(&rec, corpus, k, entries.len(), &digest_of_joined(&entries));
        }
    }
}

#[test]
fn every_head_and_tail_is_the_character_the_typescript_took() {
    let rec = load().expect("the recording reads");
    let mut edges = 0;
    for record in &rec.records {
        let Record::Edge { t, p, head, tail } = record else { continue };
        edges += 1;
        let paints = paint(p.as_ref());
        let name = |c: Option<char>| c.map(String::from).unwrap_or_default();
        assert_eq!(name(head_character(t, paints.as_ref())), *head, "head of {t:?} {p:?}");
        assert_eq!(name(tail_character(t, paints.as_ref())), *tail, "tail of {t:?} {p:?}");
    }
    assert!(edges > 100, "{edges} edges");
}

fn run(text: &str, paints: Option<RunPaint>, cursor: &LineCursor, width: f64) -> TextRunNode {
    TextRunNode {
        bbox: BoundingBox {
            x: cursor.x,
            y: f64::from(u32::try_from(cursor.index).unwrap_or(u32::MAX)) * LINE_HEIGHT,
            w: width,
            h: LINE_HEIGHT,
        },
        text: text.to_string(),
        emphasis: false,
        strong: false,
        code: false,
        deleted: false,
        link: None,
        truncated: false,
        overflows: false,
        appearance: None,
        paints,
        backdrop: None,
        backdrop_pad_x_px: None,
        annotates: None,
        baseline: Some(16.0),
    }
}

/// A junction with the wrapper's side of the state it reads and moves.
struct Driver {
    runs: Vec<TextRunNode>,
    line: LineCursor,
    junction: InlineJunction,
}

fn character(c: Option<char>) -> Value {
    Value::String(c.map(String::from).unwrap_or_default())
}

impl Driver {
    fn new() -> Self {
        Self {
            runs: Vec::new(),
            line: LineCursor { x: 0.0, index: 0 },
            junction: create_inline_junction(LINE_HEIGHT),
        }
    }

    /// One operation, answered as the recording writes an answer.
    fn apply(&mut self, op: &Op) -> Value {
        match op {
            Op::Push { t, p, w } => {
                self.runs.push(run(t, paint(p.as_ref()), &self.line, *w));
                self.line.x += *w;
                Value::Null
            }
            Op::Placed { t, p } => {
                self.junction.placed(t, paint(p.as_ref()).as_ref(), &self.runs, &self.line);
                Value::Null
            }
            Op::Breakable { t, p } => Value::Bool(
                self.junction.breakable_before(head_character(t, paint(p.as_ref()).as_ref())),
            ),
            Op::Head { t, p } => character(head_character(t, paint(p.as_ref()).as_ref())),
            Op::Tail { t, p } => character(tail_character(t, paint(p.as_ref()).as_ref())),
            Op::Allow => {
                self.junction.allow_break_here(&self.runs, &self.line);
                Value::Null
            }
            Op::Start => {
                self.junction.start_line(&self.runs, &mut self.line);
                Value::Null
            }
            Op::Reloc => {
                Value::Bool(self.junction.relocate_cluster(&mut self.runs, &mut self.line))
            }
        }
    }
}

#[test]
fn every_recorded_junction_sequence_ends_where_the_typescript_left_it() {
    let rec = load().expect("the recording reads");
    let mut sequences = 0;
    for record in &rec.records {
        let Record::Junction { ops, out, runs: want_runs, line: want_line } = record else {
            continue;
        };
        sequences += 1;
        let mut driver = Driver::new();
        let got: Vec<Value> = ops.iter().map(|op| driver.apply(op)).collect();
        assert_eq!(&got, out, "answers of {} ops", ops.len());
        let positions: Vec<[String; 2]> =
            driver.runs.iter().map(|r| [hex(r.bbox.x), hex(r.bbox.y)]).collect();
        assert_eq!(&positions, want_runs);
        assert_eq!((hex(driver.line.x), driver.line.index), (want_line.x.clone(), want_line.index));
    }
    assert_eq!(sequences, 153);
}
