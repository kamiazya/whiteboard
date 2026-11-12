//! A fixed corpus of token documents, answered with a tree or a refusal and
//! never past the bounds.
//!
//! `totality.rs` draws its documents at random, so the code a draw reaches
//! moves from run to run and so does the crate's coverage. This walks a corpus
//! of the same tokens that is the same every time: a splitmix64 stream from a
//! constant start, which is a fixed list of documents rather than a seed
//! forced onto a property. The property still looks for what the corpus
//! does not hold.

#[path = "common/tokens.rs"]
mod tokens;

use tokens::TOKENS;
use whiteboard_markdown::limits::fuel_for;
use whiteboard_markdown::parse_counting;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// splitmix64: a stream anyone can recompute.
struct Stream(u64);

impl Stream {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(bound).unwrap_or(1)).unwrap_or(0)
    }
}

const DOCUMENTS: usize = if cfg!(target_arch = "wasm32") { 3_000 } else { 20_000 };

#[test]
fn every_document_of_the_fixed_corpus_is_answered_inside_its_fuel() {
    let mut stream = Stream(0x005E_ED0F_C0DE);
    let (mut read, mut refused) = (0_usize, 0_usize);
    for _ in 0..DOCUMENTS {
        let longest = if stream.below(8) == 0 { 200 } else { 40 };
        let tokens = 1 + stream.below(longest);
        let mut text = String::new();
        for _ in 0..tokens {
            text.push_str(TOKENS[stream.below(TOKENS.len())]);
        }
        let (answer, spent) = parse_counting(&text);
        assert!(spent <= fuel_for(text.len()), "{text:?}: {spent} units");
        if answer.is_ok() {
            read += 1;
        } else {
            refused += 1;
        }
    }
    // Most are read and the long ones are sometimes refused: both arms are
    // reached by the corpus, which is the same on every run.
    assert!(read > DOCUMENTS / 2, "{read} read, {refused} refused");
}
