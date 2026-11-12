//! Heading (setext) occurs in the [flow][] content type.
//!
//! ## Grammar
//!
//! Heading (setext) forms with the following BNF
//! (<small>see [construct][crate::vendored::construct] for character groups</small>):
//!
//! ```bnf
//! heading_setext ::= paragraph eol *space_or_tab (1*'-' | 1*'=') *space_or_tab
//!
//! ; See the `paragraph` construct for the BNF of that part.
//! ```
//!
//! As this construct occurs in flow, like all flow constructs, it must be
//! followed by an eol (line ending) or eof (end of file).
//!
//! See [`paragraph`][paragraph] for grammar, notes, and recommendations on
//! that part.
//!
//! In markdown, it is also possible to create headings with a
//! [heading (atx)][heading_atx] construct.
//! The benefit of setext headings is that their text can include line endings,
//! and by extensions also hard breaks (e.g., with
//! [hard break (escape)][hard_break_escape]).
//! However, their limit is that they cannot form `<h3>` through `<h6>`
//! headings.
//!
//! [Thematic breaks][thematic_break] formed with dashes and without whitespace
//! could be interpreted as a heading (setext).
//! Which one forms depends on whether there is text directly in fron of the
//! sequence.
//!
//! > 🏛 **Background**: the word *setext* originates from a small markup
//! > language by Ian Feldman from 1991.
//! > See [*§ Setext* on Wikipedia][wiki_setext] for more info.
//! > The word *atx* originates from a tiny markup language by Aaron Swartz
//! > from 2002.
//! > See [*§ atx, the true structured text format* on `aaronsw.com`][atx] for
//! > more info.
//!
//! ## HTML
//!
//! Heading (setext) in markdown relates to the `<h1>` and `<h2>` elements in
//! HTML.
//! See [*§ 4.3.6 The `h1`, `h2`, `h3`, `h4`, `h5`, and `h6` elements* in the
//! HTML spec][html] for more info.
//!
//! ## Recommendation
//!
//! Always use heading (atx), never heading (setext).
//!
//! ## Tokens
//!
//! * [`HeadingSetext`][Name::HeadingSetext]
//! * [`HeadingSetextText`][Name::HeadingSetextText]
//! * [`HeadingSetextUnderline`][Name::HeadingSetextUnderline]
//! * [`HeadingSetextUnderlineSequence`][Name::HeadingSetextUnderlineSequence]
//!
//! ## References
//!
//! * [`setext-underline.js` in `micromark`](https://github.com/micromark/micromark/blob/main/packages/micromark-core-commonmark/dev/lib/setext-underline.js)
//! * [*§ 4.3 Setext headings* in `CommonMark`](https://spec.commonmark.org/0.31/#setext-headings)
//!
//! [flow]: crate::vendored::construct::flow
//! [paragraph]: crate::vendored::construct::paragraph
//! [heading_atx]: crate::vendored::construct::heading_atx
//! [thematic_break]: crate::vendored::construct::thematic_break
//! [hard_break_escape]: crate::vendored::construct::hard_break_escape
//! [html]: https://html.spec.whatwg.org/multipage/sections.html#the-h1,-h2,-h3,-h4,-h5,-and-h6-elements
//! [wiki_setext]: https://en.wikipedia.org/wiki/Setext
//! [atx]: http://www.aaronsw.com/2002/atx/

use crate::vendored::construct::partial_space_or_tab::{space_or_tab, space_or_tab_min_max};
use crate::vendored::event::{Content, Event, Kind, Link, Name};
use crate::vendored::resolve::Name as ResolveName;
use crate::vendored::state::{Name as StateName, State};
use crate::vendored::subtokenize::Subresult;
use crate::vendored::tokenizer::Tokenizer;
use crate::vendored::util::{constant::TAB_SIZE, skip};
use alloc::{vec, vec::Vec};

/// At start of heading (setext) underline.
///
/// ```markdown
///   | aa
/// > | ==
///     ^
/// ```
pub(crate) fn start(tokenizer: &mut Tokenizer) -> State {
    if tokenizer.parse_state.options.constructs.heading_setext
        && !tokenizer.lazy
        && !tokenizer.pierce
        // Require a paragraph before.
        && (!tokenizer.events.is_empty()
            && matches!(tokenizer.events[skip::opt_back(
                &tokenizer.events,
                tokenizer.events.len() - 1,
                &[Name::LineEnding, Name::SpaceOrTab],
            )]
            .name, Name::Content | Name::HeadingSetextUnderline))
    {
        tokenizer.enter(Name::HeadingSetextUnderline);

        if matches!(tokenizer.current, Some(b'\t' | b' ')) {
            tokenizer.attempt(State::Next(StateName::HeadingSetextBefore), State::Nok);
            State::Retry(space_or_tab_min_max(
                tokenizer,
                0,
                if tokenizer.parse_state.options.constructs.code_indented {
                    TAB_SIZE - 1
                } else {
                    usize::MAX
                },
            ))
        } else {
            State::Retry(StateName::HeadingSetextBefore)
        }
    } else {
        State::Nok
    }
}

/// After optional whitespace, at `-` or `=`.
///
/// ```markdown
///   | aa
/// > | ==
///     ^
/// ```
pub(crate) fn before(tokenizer: &mut Tokenizer) -> State {
    match tokenizer.current {
        Some(b'-' | b'=') => {
            tokenizer.tokenize_state.marker = tokenizer.current.unwrap_or_default();
            tokenizer.enter(Name::HeadingSetextUnderlineSequence);
            State::Retry(StateName::HeadingSetextInside)
        }
        _ => State::Nok,
    }
}

/// In sequence.
///
/// ```markdown
///   | aa
/// > | ==
///     ^
/// ```
pub(crate) fn inside(tokenizer: &mut Tokenizer) -> State {
    if tokenizer.current == Some(tokenizer.tokenize_state.marker) {
        tokenizer.consume();
        State::Next(StateName::HeadingSetextInside)
    } else {
        tokenizer.tokenize_state.marker = 0;
        tokenizer.exit(Name::HeadingSetextUnderlineSequence);

        if matches!(tokenizer.current, Some(b'\t' | b' ')) {
            tokenizer.attempt(State::Next(StateName::HeadingSetextAfter), State::Nok);
            State::Retry(space_or_tab(tokenizer))
        } else {
            State::Retry(StateName::HeadingSetextAfter)
        }
    }
}

/// After sequence, after optional whitespace.
///
/// ```markdown
///   | aa
/// > | ==
///       ^
/// ```
pub(crate) fn after(tokenizer: &mut Tokenizer) -> State {
    match tokenizer.current {
        None | Some(b'\n') => {
            // Feel free to interrupt.
            tokenizer.interrupt = false;
            tokenizer.register_resolver(ResolveName::HeadingSetext);
            tokenizer.exit(Name::HeadingSetextUnderline);
            State::Ok
        }
        _ => State::Nok,
    }
}

/// Resolve heading (setext).
pub(crate) fn resolve(tokenizer: &mut Tokenizer) -> Option<Subresult> {
    let mut enter = skip::to(&tokenizer.events, 0, &[Name::HeadingSetextUnderline]);
    // `(old, new)`: the paragraph enter an underline swallowed into its own
    // enter, so a later underline over that paragraph finds the live one.
    let mut merged: Vec<(usize, usize)> = vec![];

    while enter < tokenizer.events.len() {
        let exit = skip::to(&tokenizer.events, enter + 1, &[Name::HeadingSetextUnderline]);

        // Find paragraph before
        let paragraph_exit_before = skip::opt_back(
            &tokenizer.events,
            enter.saturating_sub(1),
            &[Name::SpaceOrTab, Name::LineEnding, Name::BlockQuotePrefix],
        );

        // There’s a paragraph before: this is a setext heading.
        if tokenizer.events[paragraph_exit_before].name == Name::Paragraph {
            underline_paragraph(tokenizer, &merged, paragraph_exit_before, exit);
        } else if is_thematic_break(tokenizer, enter, exit) {
            // No paragraph to underline (a heading or a definition came
            // first), and the line reads as a thematic break.
            retype_as_thematic_break(tokenizer, enter, exit);
        } else if exit + 4 < tokenizer.events.len()
            && tokenizer.events[exit + 1].name == Name::LineEnding
            && tokenizer.events[exit + 3].name == Name::Paragraph
        {
            // There’s a following paragraph, move this underline inside it.
            merge_into_following_paragraph(tokenizer, enter, exit);
            merged.push((exit + 3, enter));
        } else {
            underline_as_text(tokenizer, enter, exit);
        }

        enter = skip::to(&tokenizer.events, exit + 1, &[Name::HeadingSetextUnderline]);
    }

    tokenizer.map.consume(&mut tokenizer.events);
    None
}

/// Make the paragraph that ends at `paragraph_exit` the text of a heading
/// that ends at the underline’s `exit`.
fn underline_paragraph(
    tokenizer: &mut Tokenizer,
    merged: &[(usize, usize)],
    paragraph_exit: usize,
    exit: usize,
) {
    let mut paragraph_enter =
        skip::to_back(&tokenizer.events, paragraph_exit.saturating_sub(1), &[Name::Paragraph]);
    if let Some((_, live)) = merged.iter().find(|(old, _)| *old == paragraph_enter) {
        paragraph_enter = *live;
    }

    // Change types of Enter:Paragraph, Exit:Paragraph.
    tokenizer.events[paragraph_enter].name = Name::HeadingSetextText;
    tokenizer.events[paragraph_exit].name = Name::HeadingSetextText;

    // Add Enter:HeadingSetext, Exit:HeadingSetext.
    let mut heading_enter = tokenizer.events[paragraph_enter].clone();
    heading_enter.name = Name::HeadingSetext;
    tokenizer.map.add(paragraph_enter, 0, vec![heading_enter]);
    let mut heading_exit = tokenizer.events[exit].clone();
    heading_exit.name = Name::HeadingSetext;
    tokenizer.map.add(exit + 1, 0, vec![heading_exit]);
}

/// Turn the underline from `enter` to `exit` into the first line of the
/// paragraph that follows it.
fn merge_into_following_paragraph(tokenizer: &mut Tokenizer, enter: usize, exit: usize) {
    // Swap type, HeadingSetextUnderline:Enter -> Paragraph:Enter.
    tokenizer.events[enter].name = Name::Paragraph;
    // Swap type, LineEnding -> Data.
    tokenizer.events[exit + 1].name = Name::Data;
    tokenizer.events[exit + 2].name = Name::Data;
    // Move new data (was line ending) back to include whole line,
    // and link data together.
    tokenizer.events[exit + 1].point = tokenizer.events[enter].point.clone();
    tokenizer.events[exit + 1].link =
        Some(Link { previous: None, next: Some(exit + 4), content: Content::Text });
    if let Some(link) = tokenizer.events[exit + 4].link.as_mut() {
        link.previous = Some(exit + 1);
    }
    // Remove *including* HeadingSetextUnderline:Exit, until the line ending.
    tokenizer.map.add(enter + 1, exit - enter, vec![]);
    // Remove old Paragraph:Enter.
    tokenizer.map.add(exit + 3, 1, vec![]);
}

/// Turn the underline from `enter` to `exit` into a paragraph of its own text.
fn underline_as_text(tokenizer: &mut Tokenizer, enter: usize, exit: usize) {
    // Swap type.
    tokenizer.events[enter].name = Name::Paragraph;
    tokenizer.events[exit].name = Name::Paragraph;
    // Replace what’s inside the underline (whitespace, sequence).
    tokenizer.map.add(
        enter + 1,
        exit - enter - 1,
        vec![
            Event {
                name: Name::Data,
                kind: Kind::Enter,
                point: tokenizer.events[enter].point.clone(),
                link: Some(Link { previous: None, next: None, content: Content::Text }),
            },
            Event {
                name: Name::Data,
                kind: Kind::Exit,
                point: tokenizer.events[exit].point.clone(),
                link: None,
            },
        ],
    );
}

/// Whether the underline entered at `enter` is a run of three or more `-`,
/// which a line with no paragraph above it reads as a thematic break.
fn is_thematic_break(tokenizer: &Tokenizer, enter: usize, exit: usize) -> bool {
    let events = &tokenizer.events;
    let sequence = (enter..exit).find(|at| {
        events[*at].kind == Kind::Enter && events[*at].name == Name::HeadingSetextUnderlineSequence
    });
    let Some(start) = sequence else {
        return false;
    };
    let end = events[start + 1].point.index;
    let begin = events[start].point.index;
    tokenizer.parse_state.bytes.get(begin) == Some(&b'-') && end.saturating_sub(begin) >= 3
}

/// Rename an underline’s events to the thematic break they now spell.
fn retype_as_thematic_break(tokenizer: &mut Tokenizer, enter: usize, exit: usize) {
    for event in &mut tokenizer.events[enter..=exit] {
        event.name = match event.name {
            Name::HeadingSetextUnderline => Name::ThematicBreak,
            Name::HeadingSetextUnderlineSequence => Name::ThematicBreakSequence,
            _ => continue,
        };
    }
}
