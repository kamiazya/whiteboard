//! The line breaker against the recorded TypeScript answers.
//!
//! `packages/canvas-render/src/oracle/linebreak.jsonl` holds what `uaxSegments`
//! (`css-line-break` 2.1.0, `strict`, `normal`) answered: the interior break
//! offsets, in UTF-16 units, of every small text, and for the large corpora one
//! digest per chunk of answers. Its test fails when the file no longer equals
//! the TypeScript's answer; this replays it. The large corpora are not stored
//! but regenerated here from the `meta` record: every ordered triple of class
//! representatives, a seeded stream of mixed strings, the table's census over
//! U+0020-1FFFF between two kanji and between two Latin letters, and the raw
//! class of every code point.

use std::collections::BTreeMap;

use serde::Deserialize;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::linebreak::{raw_class, segment_ends};

const RECORDING: &str =
    include_str!("../../../../packages/canvas-render/src/oracle/linebreak.jsonl");

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Record {
    Meta {
        version: String,
        reps: Vec<u32>,
        alphabet: Vec<u32>,
        mixed: Mixed,
        kanji: u32,
        latin: [u32; 2],
    },
    Text {
        c: String,
        t: Option<String>,
        u: Option<Vec<u16>>,
        b: Vec<usize>,
    },
    Digest {
        c: String,
        k: u32,
        n: usize,
        h: u32,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mixed {
    seed: u32,
    count: u32,
    #[serde(rename = "minLen")]
    min_len: u32,
    #[serde(rename = "maxLen")]
    max_len: u32,
    chunk: u32,
}

struct Recording {
    version: String,
    reps: Vec<u32>,
    alphabet: Vec<u32>,
    mixed: Mixed,
    kanji: u32,
    latin: [u32; 2],
    texts: Vec<(String, Vec<u16>, Vec<usize>)>,
    /// (corpus, chunk) -> (strings or code points in it, digest).
    digests: BTreeMap<(String, u32), (usize, u32)>,
}

fn load() -> Result<Recording, String> {
    let mut meta = None;
    let mut texts = Vec::new();
    let mut digests = BTreeMap::new();
    for (i, line) in RECORDING.lines().enumerate() {
        match serde_json::from_str::<Record>(line).map_err(|e| format!("line {i}: {e}"))? {
            Record::Meta { version, reps, alphabet, mixed, kanji, latin } => {
                meta = Some((version, reps, alphabet, mixed, kanji, latin));
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
    let (version, reps, alphabet, mixed, kanji, latin) =
        meta.ok_or_else(|| "no meta record".to_string())?;
    Ok(Recording { version, reps, alphabet, mixed, kanji, latin, texts, digests })
}

/// The interior breaks: every segment end but the last.
fn breaks(units: &[u16]) -> Vec<usize> {
    let mut ends = segment_ends(units);
    ends.pop();
    ends
}

/// A text of code points as UTF-16 units: a pair above U+FFFF, else one unit
/// (a lone surrogate included).
fn units_of(code_points: &[u32]) -> Vec<u16> {
    let mut units = Vec::new();
    for &cp in code_points {
        if cp > 0xffff {
            let v = cp - 0x1_0000;
            units.push(0xd800 + u16::try_from(v >> 10).unwrap_or(0));
            units.push(0xdc00 + u16::try_from(v & 0x3ff).unwrap_or(0));
        } else {
            units.push(u16::try_from(cp).unwrap_or(0));
        }
    }
    units
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
    fn answer(&mut self, code_points: &[u32]) {
        for b in breaks(&units_of(code_points)) {
            self.feed(u32::try_from(b).unwrap_or(u32::MAX));
        }
        self.feed(0xffff_ffff);
    }
}

fn expect_digest(rec: &Recording, corpus: &str, k: u32, count: usize, digest: &Digest) {
    let recorded = rec.digests.get(&(corpus.to_string(), k));
    assert_eq!(
        recorded,
        Some(&(count, digest.0)),
        "{corpus} chunk {k}: recorded (strings, digest)"
    );
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

/// The code points of census block `k` (`cp >> 12`).
fn census_range(k: u32) -> Option<(u32, u32)> {
    let first = k << 12;
    match k {
        0..=0x1f => Some((first.max(0x20), first + 0xfff)),
        0xe0 => Some((0xe_0000, 0xe_01ff)),
        _ => None,
    }
}

#[test]
fn the_table_comes_from_the_trie_the_recording_was_taken_with() {
    let rec = load().expect("the recording reads");
    assert_eq!(rec.version, whiteboard_canvas_render::linebreak::SOURCE_VERSION);
    assert!(rec.reps.len() > 60, "{} representatives", rec.reps.len());
}

#[test]
fn every_recorded_text_breaks_where_the_typescript_broke_it() {
    let rec = load().expect("the recording reads");
    assert!(rec.texts.len() > 4500, "the recording holds {} texts", rec.texts.len());
    let failures: Vec<String> = rec
        .texts
        .iter()
        .filter(|(_, units, b)| &breaks(units) != b)
        .map(|(c, units, b)| {
            format!("{c} {units:04x?}: recorded {b:?}, answered {:?}", breaks(units))
        })
        .collect();
    assert!(failures.is_empty(), "{} texts differ; first:\n{}", failures.len(), failures[0]);
}

#[test]
fn every_ordered_pair_of_class_representatives_breaks_as_recorded() {
    let rec = load().expect("the recording reads");
    let pairs = rec.texts.iter().filter(|(c, ..)| c == "pairs").count();
    assert_eq!(pairs, rec.reps.len() * rec.reps.len());
}

#[test]
fn every_ordered_triple_of_class_representatives_breaks_as_recorded() {
    let rec = load().expect("the recording reads");
    for (k, &a) in rec.reps.iter().enumerate() {
        let mut digest = Digest::new();
        for &b in &rec.reps {
            for &c in &rec.reps {
                digest.answer(&[a, b, c]);
            }
        }
        expect_digest(
            &rec,
            "triples",
            u32::try_from(k).unwrap_or(0),
            rec.reps.len() * rec.reps.len(),
            &digest,
        );
    }
}

#[test]
fn a_seeded_stream_of_mixed_strings_breaks_as_recorded() {
    let rec = load().expect("the recording reads");
    let Mixed { seed, count, min_len, max_len, chunk } = rec.mixed;
    assert!(count >= 200_000, "{count} mixed strings");
    for k in 0..count / chunk {
        let mut next = mulberry32(seed.wrapping_add(k));
        let mut digest = Digest::new();
        for _ in 0..chunk {
            let length = min_len + next() % (max_len - min_len + 1);
            let text: Vec<u32> = (0..length)
                .map(|_| {
                    rec.alphabet.get((next() as usize) % rec.alphabet.len()).copied().unwrap_or(0)
                })
                .collect();
            digest.answer(&text);
        }
        expect_digest(&rec, "mixed", k, chunk as usize, &digest);
    }
}

#[test]
fn every_code_point_between_two_kanji_or_two_latin_letters_breaks_as_recorded() {
    let rec = load().expect("the recording reads");
    let around = [("census-kanji", [rec.kanji, rec.kanji]), ("census-latin", rec.latin)];
    let mut chunks = 0;
    for (corpus, [before, after]) in around {
        for k in 0..=0x0010_ffff_u32 >> 12 {
            let Some((first, last)) = census_range(k) else { continue };
            let mut digest = Digest::new();
            for cp in first..=last {
                digest.answer(&[before, cp, after]);
            }
            expect_digest(&rec, corpus, k, (last - first + 1) as usize, &digest);
            chunks += 1;
        }
    }
    assert_eq!(chunks, 66);
}

#[test]
fn every_code_point_has_the_raw_class_the_trie_gave_it() {
    let rec = load().expect("the recording reads");
    for k in 0..=0x0010_ffff_u32 >> 12 {
        let mut digest = Digest::new();
        for cp in (k << 12)..=((k << 12) + 0xfff).min(0x10_ffff) {
            digest.feed(u32::from(raw_class(cp)));
        }
        expect_digest(
            &rec,
            "raw",
            k,
            (((k << 12) + 0xfff).min(0x10_ffff) - (k << 12) + 1) as usize,
            &digest,
        );
    }
}
