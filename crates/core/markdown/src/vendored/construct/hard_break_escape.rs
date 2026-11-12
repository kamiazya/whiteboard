//! Hard break (escape) occurs in the  [text][] content type.
//!
//! ## Grammar
//!
//! Hard break (escape) forms with the following BNF
//! (<small>see [construct][crate::vendored::construct] for character groups</small>):
//!
//! ```bnf
//! ; Restriction: followed by a line ending  (that is part of the content
//! ; instead of ending it).
//! hard_break_escape ::= '\\'
//! ```
//!
//! It is also possible to create a hard break with a
//! [hard break (trailing)][hard_break_trailing].
//!
//! Punctuation characters can be escaped with a similar
//! construct: a [character escape][character_escape] is a backslash followed
//! by an ASCII punctuation character.
//! Arbitrary characters can be escaped with
//! [character references][character_reference].
//!
//! ## HTML
//!
//! Hard breaks in markdown relate to the HTML element `<br>`.
//! See [*§ 4.5.27 The `br` element* in the HTML spec][html] for more info.
//!
//! ## Recommendation
//!
//! Always use hard break (escape), never hard break (trailing).
//!
//! ## Tokens
//!
//! * [`HardBreakEscape`][Name::HardBreakEscape]
//!
//! ## References
//!
//! * [`hard-break-escape.js` in `micromark`](https://github.com/micromark/micromark/blob/main/packages/micromark-core-commonmark/dev/lib/hard-break-escape.js)
//! * [*§ 6.7 Hard line breaks* in `CommonMark`](https://spec.commonmark.org/0.31/#hard-line-breaks)
//!
//! [text]: crate::vendored::construct::text
//! [character_escape]: crate::vendored::construct::character_escape
//! [character_reference]: crate::vendored::construct::character_reference
//! [hard_break_trailing]: crate::vendored::construct::partial_whitespace
//! [html]: https://html.spec.whatwg.org/multipage/text-level-semantics.html#the-br-element

use crate::vendored::event::Name;
use crate::vendored::state::{Name as StateName, State};
use crate::vendored::tokenizer::Tokenizer;

/// Start of hard break (escape).
///
/// ```markdown
/// > | a\
///      ^
///   | b
/// ```
pub(crate) fn start(tokenizer: &mut Tokenizer) -> State {
    if tokenizer.parse_state.options.constructs.hard_break_escape
        && tokenizer.current == Some(b'\\')
    {
        tokenizer.enter(Name::HardBreakEscape);
        tokenizer.consume();
        State::Next(StateName::HardBreakEscapeAfter)
    } else {
        State::Nok
    }
}

/// After `\`, at eol.
///
/// ```markdown
/// > | a\
///       ^
///   | b
/// ```
pub(crate) fn after(tokenizer: &mut Tokenizer) -> State {
    match tokenizer.current {
        Some(b'\n') => {
            tokenizer.exit(Name::HardBreakEscape);
            State::Ok
        }
        _ => State::Nok,
    }
}
