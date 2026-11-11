//! The `BudouX` phrase breaker against the recorded TypeScript answers.
//!
//! `packages/canvas-render/src/oracle/budoux.jsonl` holds what the vendored
//! parser answered: the boundary offsets, in UTF-16 units, of every small text
//! (the hand-written corpora and one string aimed at each of the model's 1,678
//! entries), and one digest per text for every prefix of each real text, and one
//! per chunk of a seeded stream of strings over the model's own key units. Its
//! test fails when the file no longer equals the TypeScript's answer; this
//! replays it, regenerating the prefixes and the stream from what is recorded.

use std::collections::BTreeMap;

use serde::Deserialize;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::budoux::{parse, parse_boundaries};

const RECORDING: &str = include_str!("../../../../packages/canvas-render/src/oracle/budoux.jsonl");

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Record {
    Meta { model: String, entries: usize, alphabet: Vec<u16>, stream: Stream },
    Text { c: String, t: Option<String>, u: Option<Vec<u16>>, b: Vec<usize> },
    Digest { c: String, k: u32, n: usize, h: u32 },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Stream {
    seed: u32,
    count: u32,
    #[serde(rename = "minLen")]
    min_len: u32,
    #[serde(rename = "maxLen")]
    max_len: u32,
    chunk: u32,
}

struct Recording {
    model: String,
    entries: usize,
    alphabet: Vec<u16>,
    stream: Stream,
    texts: Vec<(String, Vec<u16>, Vec<usize>)>,
    /// (corpus, k) -> (strings in it, digest).
    digests: BTreeMap<(String, u32), (usize, u32)>,
}

fn load() -> Result<Recording, String> {
    let mut meta = None;
    let mut texts = Vec::new();
    let mut digests = BTreeMap::new();
    for (i, line) in RECORDING.lines().enumerate() {
        match serde_json::from_str::<Record>(line).map_err(|e| format!("line {i}: {e}"))? {
            Record::Meta { model, entries, alphabet, stream } => {
                meta = Some((model, entries, alphabet, stream));
            }
            Record::Text { c, t, u, b } => {
                let units = u.unwrap_or_else(|| t.unwrap_or_default().encode_utf16().collect());
                texts.push((c, units, b));
            }
            Record::Digest { c, k, n, h } => {
                digests.insert((c, k), (n, h));
            }
        }
    }
    let (model, entries, alphabet, stream) = meta.ok_or_else(|| "no meta record".to_string())?;
    Ok(Recording { model, entries, alphabet, stream, texts, digests })
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
    fn answer(&mut self, units: &[u16]) {
        for b in parse_boundaries(units) {
            self.feed(u32::try_from(b).unwrap_or(u32::MAX));
        }
        self.feed(0xffff_ffff);
    }
}

fn expect_digest(rec: &Recording, corpus: &str, k: u32, count: usize, digest: &Digest) {
    assert_eq!(
        rec.digests.get(&(corpus.to_string(), k)),
        Some(&(count, digest.0)),
        "{corpus} {k}: recorded (strings, digest)"
    );
}

/// mulberry32, the seeded stream of the generated corpus.
fn mulberry32(seed: u32) -> impl FnMut() -> u32 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b_79f5);
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(0x3d | t)) ^ t;
        t ^ (t >> 14)
    }
}

#[test]
fn the_recording_is_of_the_model_the_tables_were_generated_from() {
    let rec = load().expect("the recording reads");
    assert_eq!(rec.model, "budoux@0.9.0 ja");
    assert_eq!(rec.entries, 1678);
    assert!(rec.alphabet.len() > 300, "{} units in the alphabet", rec.alphabet.len());
}

#[test]
fn every_recorded_text_is_cut_where_the_typescript_cut_it() {
    let rec = load().expect("the recording reads");
    assert!(rec.texts.len() > 1700, "the recording holds {} texts", rec.texts.len());
    let failures: Vec<String> = rec
        .texts
        .iter()
        .filter(|(_, units, b)| &parse_boundaries(units) != b)
        .map(|(c, units, b)| {
            format!("{c} {units:04x?}: recorded {b:?}, answered {:?}", parse_boundaries(units))
        })
        .collect();
    assert!(failures.is_empty(), "{} texts differ; first:\n{}", failures.len(), failures[0]);
}

#[test]
fn every_recorded_text_is_split_into_phrases_the_boundaries_describe() {
    let rec = load().expect("the recording reads");
    for (c, units, b) in &rec.texts {
        let lengths: Vec<usize> = parse(units).iter().map(|phrase| phrase.len()).collect();
        let mut cuts = vec![0];
        cuts.extend(b);
        cuts.push(units.len());
        let gaps: Vec<usize> = cuts.windows(2).map(|w| w[1] - w[0]).collect();
        assert_eq!(lengths, if units.is_empty() { vec![] } else { gaps }, "{c} {units:04x?}");
    }
}

#[test]
fn every_prefix_of_every_real_text_is_cut_as_recorded() {
    let rec = load().expect("the recording reads");
    let real: Vec<&Vec<u16>> =
        rec.texts.iter().filter(|(c, ..)| c == "real").map(|t| &t.1).collect();
    assert!(real.len() >= 30, "{} real texts", real.len());
    for (k, units) in real.iter().enumerate() {
        let mut digest = Digest::new();
        for end in 0..=units.len() {
            digest.answer(&units[..end]);
        }
        expect_digest(&rec, "prefixes", u32::try_from(k).unwrap_or(0), units.len() + 1, &digest);
    }
}

#[test]
fn a_seeded_stream_over_the_key_units_is_cut_as_recorded() {
    let rec = load().expect("the recording reads");
    let Stream { seed, count, min_len, max_len, chunk } = rec.stream;
    assert!(count >= 100_000, "{count} strings in the stream");
    for k in 0..count / chunk {
        let mut next = mulberry32(seed.wrapping_add(k));
        let mut digest = Digest::new();
        for _ in 0..chunk {
            let length = min_len + next() % (max_len - min_len + 1);
            let text: Vec<u16> = (0..length)
                .map(|_| {
                    rec.alphabet.get((next() as usize) % rec.alphabet.len()).copied().unwrap_or(0)
                })
                .collect();
            digest.answer(&text);
        }
        expect_digest(&rec, "stream", k, chunk as usize, &digest);
    }
}
