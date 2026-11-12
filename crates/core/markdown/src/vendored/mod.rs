//! The vendored markdown-rs: its tokenizer, state machine, tree builder and
//! the tables they read.

#![expect(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    reason = "the tokenizer indexes events and bytes by positions it built itself; \
              the fuzz target and the totality property hold it to never reaching a panic"
)]
#![expect(
    clippy::too_many_lines,
    clippy::struct_excessive_bools,
    clippy::struct_field_names,
    clippy::to_string_trait_impl,
    clippy::enum_variant_names,
    reason = "the shapes of the upstream state machine and tree builder, kept as they are \
              so a later upstream fix can be compared against them"
)]

mod budget;
mod configuration;
mod construct;
mod event;
pub mod mdast;
mod parser;
mod resolve;
mod state;
mod subtokenize;
mod to_mdast;
mod tokenizer;
mod tree_text;
pub mod unist;
mod util;

pub(crate) use budget::Budget;
pub(crate) use configuration::ParseOptions;
pub(crate) use parser::parse;
pub(crate) use to_mdast::compile;

/// How deep the events nest: all of them, and block containers alone.
///
/// The first is the depth of the tree they will build; the second is what the
/// TypeScript tokenizer caps.
pub(crate) fn nesting(events: &[event::Event]) -> Nesting {
    let mut depth = 0_usize;
    let mut containers = 0_usize;
    let mut nesting = Nesting { events: 0, containers: 0 };
    for event in events {
        let container = matches!(
            event.name,
            event::Name::BlockQuote | event::Name::ListItem | event::Name::GfmFootnoteDefinition
        );
        if event.kind == event::Kind::Enter {
            depth = depth.saturating_add(1);
            containers = containers.saturating_add(usize::from(container));
            nesting.events = nesting.events.max(depth);
            nesting.containers = nesting.containers.max(containers);
        } else {
            depth = depth.saturating_sub(1);
            containers = containers.saturating_sub(usize::from(container));
        }
    }
    nesting
}

/// The result of [`nesting`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct Nesting {
    /// The deepest nesting of events of any kind.
    pub(crate) events: usize,
    /// The deepest nesting of block quotes, list items and footnote definitions.
    pub(crate) containers: usize,
}

/// Whether `char` is Unicode punctuation or a symbol, as the flanking rules read it.
pub(crate) fn is_punctuation(char: char) -> bool {
    char.is_ascii_punctuation() || util::unicode::PUNCTUATION.binary_search(&char).is_ok()
}
