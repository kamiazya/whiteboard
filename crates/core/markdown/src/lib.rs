//! `CommonMark`, GFM and math markdown parsed to an [mdast][] tree.
//!
//! A vendored, trimmed and hardened copy of [markdown-rs][] 1.0.0 (MIT, see
//! `LICENSE-markdown-rs`). What was dropped: the HTML compiler, MDX, front
//! matter, the serde and logging features, and the options that selected them.
//! What was added: the cost and depth bounds in [`limits`], and totality (no
//! input reaches a panic), because a panic in a wasm instance poisons it.
//!
//! [mdast]: https://github.com/syntax-tree/mdast
//! [markdown-rs]: https://github.com/wooorm/markdown-rs

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. The tokenizer and the tree
// builder are vendored code that indexes by construction; `vendored` holds
// them to the fuzz target and the properties instead.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

extern crate alloc;

pub mod limits;

mod vendored;

pub use limits::Refusal;
pub use vendored::{mdast, unist};

use limits::{MAX_BYTES, fuel_for};

/// The tree of `text`, read as `CommonMark` with GFM and math, or why it was
/// not.
///
/// # Errors
///
/// A [`Refusal`] says which bound the text went past; see [`limits`].
pub fn parse(text: &str) -> Result<mdast::Node, Refusal> {
    parse_counting(text).0
}

/// [`parse`], and the work units it spent: the instrument the fuel figure is
/// measured with.
///
/// # Errors
///
/// As [`parse`].
pub fn parse_counting(text: &str) -> (Result<mdast::Node, Refusal>, usize) {
    if text.len() > MAX_BYTES {
        return (Err(Refusal::TooLarge), 0);
    }
    if let Err(refusal) = limits::prescan(text) {
        return (Err(refusal), 0);
    }
    let options = vendored::ParseOptions::default();
    let (events, parse_state) = vendored::parse(text, &options, fuel_for(text.len()));
    // The two passes over the finished events, the depth walk and the tree
    // builder, each visit an event once.
    parse_state.budget.spend(events.len().saturating_mul(2));
    let spent = parse_state.budget.spent();
    if let Some(refusal) = parse_state.budget.refusal() {
        return (Err(refusal), spent);
    }
    let nesting = vendored::nesting(&events);
    if nesting.events > limits::MAX_DEPTH || nesting.containers > limits::MAX_CONTAINER_DEPTH {
        return (Err(Refusal::TooDeep), spent);
    }
    (Ok(vendored::compile(&events, parse_state.bytes)), spent)
}

#[cfg(test)]
mod tests {
    use super::*;
    // On wasm32 the same tests run under Node (QR-21 layer 3).
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// How deep the events of `text` nest, as the bound reads them.
    fn nesting_of(text: &str) -> usize {
        let options = vendored::ParseOptions::default();
        let (events, _) = vendored::parse(text, &options, fuel_for(text.len()));
        vendored::nesting(&events).events
    }

    /// Emphasis opened `levels` deep, inside `quotes` block quotes: two events
    /// a level and one a quote, so both parities of the bound are reachable.
    fn nested(levels: usize, quotes: usize) -> String {
        format!("{}{}x{}", "> ".repeat(quotes), "*a ".repeat(levels), "b* ".repeat(levels))
    }

    #[test]
    fn a_text_nesting_exactly_the_depth_bound_is_read_and_one_deeper_is_refused() {
        let mut at_bound = 0;
        let mut past_bound = 0;
        for quotes in 0..2 {
            for levels in 508..=511 {
                let text = nested(levels, quotes);
                let depth = nesting_of(&text);
                if depth == limits::MAX_DEPTH {
                    at_bound += 1;
                    assert!(parse(&text).is_ok(), "{levels} levels in {quotes} quotes");
                } else if depth == limits::MAX_DEPTH + 1 {
                    past_bound += 1;
                    assert_eq!(parse(&text).err(), Some(Refusal::TooDeep));
                }
            }
        }
        assert_eq!((at_bound, past_bound), (1, 1), "the shapes reach the bound from both sides");
    }
}
