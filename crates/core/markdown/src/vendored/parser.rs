//! Turn bytes of markdown into events.

use crate::limits::Refusal;
use crate::vendored::ParseOptions;
use crate::vendored::budget::Budget;
use crate::vendored::event::{Event, Point};
use crate::vendored::state::{Name as StateName, State};
use crate::vendored::subtokenize::subtokenize;
use crate::vendored::tokenizer::Tokenizer;
use alloc::{string::String, vec, vec::Vec};

/// Info needed, in all content types, when parsing markdown.
///
/// Importantly, this contains a set of known definitions.
/// It also references the input value as bytes (`u8`).
#[derive(Debug)]
pub(crate) struct ParseState<'a> {
    /// Configuration.
    /// Configuration.
    pub(crate) options: &'a ParseOptions,
    /// List of chars.
    pub(crate) bytes: &'a [u8],
    /// Set of defined definition identifiers.
    pub(crate) definitions: Vec<String>,
    /// Set of defined GFM footnote definition identifiers.
    pub(crate) gfm_footnote_definitions: Vec<String>,
    /// The work this parse may still do.
    pub(crate) budget: Budget,
}

/// Rounds of subtokenization a parse makes at most.
///
/// Content becomes text and nothing nests deeper than that, so a parse needs
/// three; the bound keeps a round that never finishes from spinning.
const MAX_ROUNDS: usize = 16;

/// Turn a string of markdown into events.
///
/// Passes the bytes back so the compiler can access the source.
pub(crate) fn parse<'a>(
    value: &'a str,
    options: &'a ParseOptions,
    fuel: usize,
) -> (Vec<Event>, ParseState<'a>) {
    let bytes = value.as_bytes();

    let mut parse_state = ParseState {
        options,
        bytes,
        definitions: vec![],
        gfm_footnote_definitions: vec![],
        budget: Budget::new(fuel),
    };

    let start = Point { line: 1, column: 1, index: 0, vs: 0 };
    let mut tokenizer = Tokenizer::new(start, &parse_state);

    let state =
        tokenizer.push((0, 0), (parse_state.bytes.len(), 0), State::Next(StateName::DocumentStart));
    let mut result = tokenizer.flush(state, true);
    let mut events = tokenizer.events;

    for _ in 0..MAX_ROUNDS {
        let fn_defs = &mut parse_state.gfm_footnote_definitions;
        let defs = &mut parse_state.definitions;
        fn_defs.append(&mut result.gfm_footnote_definitions);
        defs.append(&mut result.definitions);

        if result.done || parse_state.budget.refusal().is_some() {
            return (events, parse_state);
        }

        result = subtokenize(&mut events, &parse_state, None);
    }

    parse_state.budget.refuse(Refusal::TooCostly);
    (events, parse_state)
}
