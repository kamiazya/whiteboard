//! Deal with content in other content.
//!
//! To deal with content in content, *you* (a `markdown-rs` contributor) add
//! info on events.
//! Events are a flat list, but they can be connected to each other with a
//! [`Link`][crate::vendored::event::Link].
//! Links must occur on [`Enter`][Kind::Enter] events only, which are void
//! (they are followed by their corresponding [`Exit`][Kind::Exit] event).
//!
//! Links will then be passed through a tokenizer for the corresponding content
//! type by `subtokenize`.
//! The subevents they result in are split up into slots for each linked event
//! and replace those links.
//!
//! Subevents are not immediately subtokenized as markdown prevents us from
//! doing so due to definitions, which can occur after references, and thus the
//! whole document needs to be parsed up to the level of definitions, before
//! any level that can include references can be parsed.

use crate::vendored::event::{Content, Event, Kind, Name};
use crate::vendored::parser::ParseState;
use crate::vendored::state::{Name as StateName, State};
use crate::vendored::tokenizer::Tokenizer;
use crate::vendored::util::{edit_map::EditMap, skip};
use alloc::{string::String, vec, vec::Vec};

#[derive(Debug)]
pub(crate) struct Subresult {
    pub(crate) done: bool,
    pub(crate) gfm_footnote_definitions: Vec<String>,
    pub(crate) definitions: Vec<String>,
}

/// Link two [`Event`][]s.
///
/// Arbitrary (void) events can be linked together.
/// This optimizes for the common case where the event at `index` is connected
/// to the previous void event.
pub(crate) fn link(events: &mut [Event], index: usize) {
    link_to(events, index - 2, index);
}

/// Link two arbitrary [`Event`][]s together.
pub(crate) fn link_to(events: &mut [Event], previous: usize, next: usize) {
    // Note: the exit of this event may not exist, so don’t check for that.

    if let Some(link) = events[previous].link.as_mut() {
        link.next = Some(next);
    }
    if let Some(link) = events[next].link.as_mut() {
        link.previous = Some(previous);
    }
}

/// Parse linked events.
///
/// Supposed to be called repeatedly, returns `true` when done.
pub(crate) fn subtokenize(
    events: &mut Vec<Event>,
    parse_state: &ParseState,
    filter: Option<&Content>,
) -> Subresult {
    let mut map = EditMap::new();
    let mut index = 0;
    let mut value = Subresult { done: true, gfm_footnote_definitions: vec![], definitions: vec![] };
    let mut acc = (0, 0);

    while index < events.len() && parse_state.budget.spend(1) {
        let event = &events[index];

        // Find each first opening chunk.
        if let Some(ref link) = event.link {
            // No need to enter linked events again.
            if link.previous.is_none() && filter.is_none_or(|filter| &link.content == filter) {
                // Index into `events` pointing to a chunk.
                let mut link_index = Some(index);
                // Subtokenizer.
                let mut tokenizer = Tokenizer::new(event.point.clone(), parse_state);
                // Substate.
                let mut state = State::Next(match link.content {
                    Content::Content => StateName::ContentDefinitionBefore,
                    Content::String => StateName::StringStart,
                    _ => StateName::TextStart,
                });

                // Check if this is the first paragraph, after zero or more
                // definitions (or a blank line), in a list item.
                // Used for GFM task list items.
                if tokenizer.parse_state.options.constructs.gfm_task_list_item
                    && index > 2
                    && events[index - 1].kind == Kind::Enter
                    && events[index - 1].name == Name::Paragraph
                {
                    let before = skip::opt_back(
                        events,
                        index - 2,
                        &[
                            Name::BlankLineEnding,
                            Name::Definition,
                            Name::LineEnding,
                            Name::SpaceOrTab,
                        ],
                    );

                    if events[before].kind == Kind::Exit
                        && events[before].name == Name::ListItemPrefix
                    {
                        tokenizer.tokenize_state.document_at_first_paragraph_of_list_item = true;
                    }
                }

                // Loop through links to pass them in order to the subtokenizer.
                while let Some(index) = link_index {
                    let enter = &events[index];
                    let Some(link_curr) = enter.link.as_ref() else {
                        break;
                    };

                    if link_curr.previous.is_some() {
                        tokenizer.define_skip(enter.point.clone());
                    }

                    let end = &events[index + 1].point;

                    state = tokenizer.push(
                        (enter.point.index, enter.point.vs),
                        (end.index, end.vs),
                        state,
                    );

                    link_index = link_curr.next;
                }

                let mut result = tokenizer.flush(state, true);
                value.gfm_footnote_definitions.append(&mut result.gfm_footnote_definitions);
                value.definitions.append(&mut result.definitions);
                value.done = false;

                acc = divide_events(&mut map, events, index, &mut tokenizer.events, acc);
            }
        }

        index += 1;
    }

    map.consume(events);

    value
}

/// Divide `child_events` over links in `events`, the first of which is at
/// `link_index`.
pub(crate) fn divide_events(
    map: &mut EditMap,
    events: &[Event],
    mut link_index: usize,
    child_events: &mut Vec<Event>,
    acc_before: (usize, usize),
) -> (usize, usize) {
    // Loop through `child_events` to figure out which parts belong where and
    // fix deep links.
    let mut child_index = 0;
    let mut slices = vec![];
    let mut slice_start = 0;
    let mut old_prev: Option<usize> = None;
    let len = child_events.len();

    while child_index < len {
        let current = &child_events[child_index].point;
        let end = &events[link_index + 1].point;

        // Find the first event that starts after the end we’re looking
        // for.
        if current.index > end.index || (current.index == end.index && current.vs > end.vs) {
            slices.push((link_index, slice_start));
            slice_start = child_index;
            link_index =
                events[link_index].link.as_ref().and_then(|link| link.next).unwrap_or(link_index);
        }

        // Fix sublinks.
        if let Some(sublink_curr) = &child_events[child_index].link
            && sublink_curr.previous.is_some()
        {
            let old_prev = old_prev.unwrap_or_default();
            let prev_event = &mut child_events[old_prev];
            // The `index` in `events` where the current link is,
            // minus one to get the previous link,
            // minus 2 events (the enter and exit) for each removed
            // link.
            let new_link = if slices.is_empty() {
                old_prev + link_index + 2
            } else {
                old_prev + link_index - (slices.len() - 1) * 2
            };
            if let Some(link) = prev_event.link.as_mut() {
                link.next = Some(new_link + acc_before.1 - acc_before.0);
            }
        }

        // If there is a `next` link in the subevents, we have to change
        // its `previous` index to account for the shifted events.
        // If it points to a next event, we also change the next event’s
        // reference back to *this* event.
        if let Some(sublink_curr) = &child_events[child_index].link
            && let Some(next) = sublink_curr.next
            && let Some(sublink_next) = child_events[next].link.as_mut()
        {
            old_prev = sublink_next.previous;

            sublink_next.previous = sublink_next
                .previous
                // The `index` in `events` where the current link is,
                // minus 2 events (the enter and exit) for each removed
                // link.
                .map(|previous| {
                    previous + link_index - (slices.len() * 2) + acc_before.1 - acc_before.0
                });
        }

        child_index += 1;
    }

    if !child_events.is_empty() {
        slices.push((link_index, slice_start));
    }

    // Finally, inject the subevents.
    let mut index = slices.len();

    while index > 0 {
        index -= 1;
        map.add(slices[index].0, 2, child_events.split_off(slices[index].1));
    }

    (acc_before.0 + (slices.len() * 2), acc_before.1 + len)
}
