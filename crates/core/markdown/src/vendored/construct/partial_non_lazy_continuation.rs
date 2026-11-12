//! Non-lazy continuation.
//!
//! This is a tiny helper that [flow][] constructs can use to make sure that
//! the following line is not lazy.
//! For example, [html (flow)][html_flow] and ([raw (flow)][raw_flow],
//! [indented][code_indented]), stop when the next line is lazy.
//!
//! [flow]: crate::vendored::construct::flow
//! [raw_flow]: crate::vendored::construct::raw_flow
//! [code_indented]: crate::vendored::construct::code_indented
//! [html_flow]: crate::vendored::construct::html_flow

use crate::vendored::event::Name;
use crate::vendored::state::{Name as StateName, State};
use crate::vendored::tokenizer::Tokenizer;

/// At eol, before continuation.
///
/// ```markdown
/// > | * ```js
///            ^
///   | b
/// ```
pub(crate) fn start(tokenizer: &mut Tokenizer) -> State {
    match tokenizer.current {
        Some(b'\n') => {
            tokenizer.enter(Name::LineEnding);
            tokenizer.consume();
            tokenizer.exit(Name::LineEnding);
            State::Next(StateName::NonLazyContinuationAfter)
        }
        _ => State::Nok,
    }
}

/// A continuation.
///
/// ```markdown
///   | * ```js
/// > | b
///     ^
/// ```
pub(crate) fn after(tokenizer: &mut Tokenizer) -> State {
    if tokenizer.lazy { State::Nok } else { State::Ok }
}
