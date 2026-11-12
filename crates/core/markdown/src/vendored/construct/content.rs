//! Content occurs in the [flow][] content type.
//!
//! Content contains zero or more [definition][definition]s, followed by zero
//! or one [paragraph][].
//!
//! The constructs found in flow are:
//!
//! * [Definition][crate::vendored::construct::definition]
//! * [Paragraph][crate::vendored::construct::paragraph]
//!
//! ## Tokens
//!
//! * [`Content`][Name::Content]
//!
//! > 👉 **Note**: while parsing, [`Content`][Name::Content]
//! > is used, which is later compiled away.
//!
//! ## References
//!
//! * [`content.js` in `micromark`](https://github.com/micromark/micromark/blob/main/packages/micromark-core-commonmark/dev/lib/content.js)
//!
//! [flow]: crate::vendored::construct::flow
//! [definition]: crate::vendored::construct::definition
//! [paragraph]: crate::vendored::construct::paragraph

use crate::vendored::event::{Content, Kind, Link, Name};
use crate::vendored::resolve::Name as ResolveName;
use crate::vendored::state::{Name as StateName, State};
use crate::vendored::subtokenize::{Subresult, subtokenize};
use crate::vendored::tokenizer::Tokenizer;
use alloc::vec;

/// Before a content chunk.
///
/// ```markdown
/// > | abc
///     ^
/// ```
pub(crate) fn chunk_start(tokenizer: &mut Tokenizer) -> State {
    match tokenizer.current {
        None | Some(b'\n') => State::Nok,
        _ => {
            tokenizer.enter_link(
                Name::Content,
                Link { previous: None, next: None, content: Content::Content },
            );
            State::Retry(StateName::ContentChunkInside)
        }
    }
}

/// In a content chunk.
///
/// ```markdown
/// > | abc
///     ^^^
/// ```
pub(crate) fn chunk_inside(tokenizer: &mut Tokenizer) -> State {
    match tokenizer.current {
        None | Some(b'\n') => {
            tokenizer.exit(Name::Content);
            tokenizer.register_resolver_before(ResolveName::Content);
            // You’d be interrupting.
            tokenizer.interrupt = true;
            State::Ok
        }
        _ => {
            tokenizer.consume();
            State::Next(StateName::ContentChunkInside)
        }
    }
}

/// Before a definition.
///
/// ```markdown
/// > | [a]: b
///     ^
/// ```
pub(crate) fn definition_before(tokenizer: &mut Tokenizer) -> State {
    tokenizer.attempt(
        State::Next(StateName::ContentDefinitionAfter),
        State::Next(StateName::ParagraphStart),
    );
    State::Retry(StateName::DefinitionStart)
}

/// After a definition.
///
/// ```markdown
/// > | [a]: b
///           ^
///   | c
/// ```
pub(crate) fn definition_after(tokenizer: &mut Tokenizer) -> State {
    if tokenizer.current.is_none() {
        State::Ok
    } else {
        tokenizer.enter(Name::LineEnding);
        tokenizer.consume();
        tokenizer.exit(Name::LineEnding);
        State::Next(StateName::ContentDefinitionBefore)
    }
}

/// Merge `Content` chunks, which currently span a single line, into actual
/// `Content`s that span multiple lines.
pub(crate) fn resolve(tokenizer: &mut Tokenizer) -> Subresult {
    let mut index = 0;

    while index < tokenizer.events.len() {
        let event = &tokenizer.events[index];

        if event.kind == Kind::Enter && event.name == Name::Content {
            // Exit:Content
            let mut exit_index = index + 1;

            loop {
                let mut enter_index = exit_index + 1;

                if enter_index == tokenizer.events.len()
                    || tokenizer.events[enter_index].name != Name::LineEnding
                {
                    break;
                }

                // Skip past line ending.
                enter_index += 2;

                // Skip past prefix.
                while enter_index < tokenizer.events.len() {
                    let event = &tokenizer.events[enter_index];

                    if event.name != Name::SpaceOrTab
                        && event.name != Name::BlockQuotePrefix
                        && event.name != Name::BlockQuoteMarker
                    {
                        break;
                    }

                    enter_index += 1;
                }

                if enter_index == tokenizer.events.len()
                    || tokenizer.events[enter_index].name != Name::Content
                {
                    break;
                }

                // Set Exit:Content point to Exit:LineEnding.
                tokenizer.events[exit_index].point = tokenizer.events[exit_index + 2].point.clone();
                // Remove Enter:LineEnding, Exit:LineEnding.
                tokenizer.map.add(exit_index + 1, 2, vec![]);

                // Link Enter:Content to Enter:Content on this line and vice versa.
                if let Some(link) = tokenizer.events[exit_index - 1].link.as_mut() {
                    link.next = Some(enter_index);
                }
                if let Some(link) = tokenizer.events[enter_index].link.as_mut() {
                    link.previous = Some(exit_index - 1);
                }

                // Potential next start.
                exit_index = enter_index + 1;
            }

            // Move to `Exit:Content`.
            index = exit_index;
        }

        index += 1;
    }

    tokenizer.map.consume(&mut tokenizer.events);

    subtokenize(&mut tokenizer.events, tokenizer.parse_state, Some(&Content::Content))
}
