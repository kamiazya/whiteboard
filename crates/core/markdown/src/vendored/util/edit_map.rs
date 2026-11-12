//! Deal with several changes in events, batching them together.
//!
//! Preferably, changes should be kept to a minimum.
//! Sometimes, it’s needed to change the list of events, because parsing can be
//! messy, and it helps to expose a cleaner interface of events to the compiler
//! and other users.
//! It can also help to merge many adjacent similar events.
//! And, in other cases, it’s needed to parse subcontent: pass some events
//! through another tokenizer and inject the result.

use crate::vendored::event::Event;
use alloc::{collections::BTreeMap, vec::Vec};

/// Shift `previous` and `next` links according to `jumps`.
///
/// This fixes links in case there are events removed or added between them.
fn shift_links(events: &mut [Event], jumps: &[(usize, usize, usize)]) {
    let mut jump_index = 0;
    let mut index = 0;
    let mut add = 0;
    let mut rm = 0;

    while index < events.len() {
        let rm_curr = rm;

        while jump_index < jumps.len() && jumps[jump_index].0 <= index {
            add = jumps[jump_index].2;
            rm = jumps[jump_index].1;
            jump_index += 1;
        }

        // Ignore items that will be removed.
        if rm > rm_curr {
            index += rm - rm_curr;
        } else {
            if let Some(link) = &events[index].link
                && let Some(next) = link.next
            {
                if let Some(link) = events[next].link.as_mut() {
                    link.previous = Some(index + add - rm);
                }

                while jump_index < jumps.len() && jumps[jump_index].0 <= next {
                    add = jumps[jump_index].2;
                    rm = jumps[jump_index].1;
                    jump_index += 1;
                }

                if let Some(link) = events[index].link.as_mut() {
                    link.next = Some(next + add - rm);
                }
                index = next;
                continue;
            }

            index += 1;
        }
    }
}

/// Tracks a bunch of edits.
///
/// Keyed by position, so adding an edit costs a lookup rather than a scan of
/// every edit so far: a body with many headings, rows or links adds tens of
/// thousands of them.
#[derive(Debug)]
pub(crate) struct EditMap {
    /// Record of changes: position to what is removed there and what replaces it.
    map: BTreeMap<usize, (usize, Vec<Event>)>,
}

impl EditMap {
    /// Create a new edit map.
    pub(crate) fn new() -> EditMap {
        EditMap { map: BTreeMap::new() }
    }
    /// Create an edit: a remove and/or add at a certain place.
    pub(crate) fn add(&mut self, index: usize, remove: usize, add: Vec<Event>) {
        add_impl(self, index, remove, add, false);
    }
    /// Create an edit: but insert `add` before existing additions.
    pub(crate) fn add_before(&mut self, index: usize, remove: usize, add: Vec<Event>) {
        add_impl(self, index, remove, add, true);
    }
    /// Done, change the events.
    pub(crate) fn consume(&mut self, events: &mut Vec<Event>) {
        if self.map.is_empty() {
            return;
        }

        // Calculate jumps: where items in the current list move to.
        let mut jumps = Vec::with_capacity(self.map.len());
        let mut add_acc = 0;
        let mut remove_acc = 0;
        for (at, (remove, add)) in &self.map {
            remove_acc += remove;
            add_acc += add.len();
            jumps.push((*at, remove_acc, add_acc));
        }

        shift_links(events, &jumps);

        let mut vecs = Vec::with_capacity(self.map.len() * 2 + 1);
        for (at, (remove, add)) in self.map.iter_mut().rev() {
            vecs.push(events.split_off(*at + *remove));
            vecs.push(add.split_off(0));
            events.truncate(*at);
        }
        vecs.push(events.split_off(0));

        while let Some(mut slice) = vecs.pop() {
            events.append(&mut slice);
        }

        self.map.clear();
    }
}

/// Create an edit.
fn add_impl(edit_map: &mut EditMap, at: usize, remove: usize, mut add: Vec<Event>, before: bool) {
    if remove == 0 && add.is_empty() {
        return;
    }

    let edit = edit_map.map.entry(at).or_insert_with(|| (0, Vec::new()));
    edit.0 += remove;
    if before {
        add.append(&mut edit.1);
        edit.1 = add;
    } else {
        edit.1.append(&mut add);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vendored::event::{Kind, Name, Point};
    use alloc::vec;
    // On wasm32 the same tests run under Node (QR-21 layer 3).
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn event(name: Name) -> Event {
        Event {
            kind: Kind::Enter,
            name,
            point: Point { line: 1, column: 1, index: 0, vs: 0 },
            link: None,
        }
    }

    fn names(events: &[Event]) -> Vec<Name> {
        events.iter().map(|event| event.name.clone()).collect()
    }

    #[test]
    fn an_insertion_goes_in_at_its_position() {
        let mut events = vec![event(Name::Data), event(Name::Paragraph)];
        let mut map = EditMap::new();
        map.add(1, 0, vec![event(Name::Emphasis)]);
        map.consume(&mut events);
        assert_eq!(names(&events), [Name::Data, Name::Emphasis, Name::Paragraph]);
    }

    #[test]
    fn a_removal_takes_the_events_it_names() {
        let mut events = vec![event(Name::Data), event(Name::Emphasis), event(Name::Paragraph)];
        let mut map = EditMap::new();
        map.add(1, 1, vec![]);
        map.consume(&mut events);
        assert_eq!(names(&events), [Name::Data, Name::Paragraph]);
    }

    #[test]
    fn edits_apply_in_position_order_whatever_order_they_were_added() {
        let mut events = vec![event(Name::Data), event(Name::Paragraph), event(Name::Strong)];
        let mut map = EditMap::new();
        map.add(2, 0, vec![event(Name::Emphasis)]);
        map.add(0, 1, vec![event(Name::HtmlFlow)]);
        map.consume(&mut events);
        assert_eq!(names(&events), [Name::HtmlFlow, Name::Paragraph, Name::Emphasis, Name::Strong]);
    }

    #[test]
    fn edits_at_one_position_add_up_and_keep_their_order() {
        let mut events = vec![event(Name::Data), event(Name::Paragraph)];
        let mut map = EditMap::new();
        map.add(1, 0, vec![event(Name::Emphasis)]);
        map.add(1, 1, vec![event(Name::Strong)]);
        map.consume(&mut events);
        assert_eq!(names(&events), [Name::Data, Name::Emphasis, Name::Strong]);
    }

    #[test]
    fn an_edit_added_before_goes_ahead_of_the_additions_at_its_position() {
        let mut events = vec![event(Name::Data)];
        let mut map = EditMap::new();
        map.add(1, 0, vec![event(Name::Emphasis)]);
        map.add_before(1, 0, vec![event(Name::Strong)]);
        map.consume(&mut events);
        assert_eq!(names(&events), [Name::Data, Name::Strong, Name::Emphasis]);
    }

    #[test]
    fn an_edit_that_adds_and_removes_nothing_is_not_kept() {
        let mut events = vec![event(Name::Data)];
        let mut map = EditMap::new();
        map.add(0, 0, vec![]);
        map.add_before(0, 0, vec![]);
        map.consume(&mut events);
        assert_eq!(names(&events), [Name::Data]);
        assert!(map.map.is_empty());
    }

    #[test]
    fn links_follow_the_events_they_point_at() {
        use crate::vendored::event::{Content, Link};
        let linked = |previous, next| Event {
            link: Some(Link { previous, next, content: Content::Text }),
            ..event(Name::Data)
        };
        let mut events = vec![linked(None, Some(2)), event(Name::Paragraph), linked(Some(0), None)];
        let mut map = EditMap::new();
        map.add(1, 0, vec![event(Name::Emphasis), event(Name::Strong)]);
        map.consume(&mut events);
        assert_eq!(events[0].link.as_ref().and_then(|link| link.next), Some(4));
        assert_eq!(events[4].link.as_ref().and_then(|link| link.previous), Some(0));
    }

    #[test]
    fn many_edits_at_distinct_positions_are_applied() {
        let count = 2_000;
        let mut events: Vec<Event> = (0..count).map(|_| event(Name::Data)).collect();
        let mut map = EditMap::new();
        for at in (0..count).rev() {
            map.add(at, 0, vec![event(Name::Emphasis)]);
        }
        map.consume(&mut events);
        assert_eq!(events.len(), count * 2);
        assert!(
            events
                .chunks(2)
                .all(|pair| pair[0].name == Name::Emphasis && pair[1].name == Name::Data)
        );
    }

    /// One edit: where, how many events it takes out, how many it puts in.
    type Edit = (usize, usize, usize);

    /// Each event is told apart by the `index` of its point. A chain of links
    /// runs through the events in `chain`, in order; edits never remove a
    /// linked event (markdown-rs removes the ones between and around them).
    fn linked_events(count: usize, chain: &[usize]) -> Vec<Event> {
        use crate::vendored::event::{Content, Link};
        let mut events: Vec<Event> = (0..count)
            .map(|id| Event {
                point: Point { line: 1, column: 1, index: id, vs: 0 },
                ..event(Name::Data)
            })
            .collect();
        for (position, at) in chain.iter().enumerate() {
            events[*at].link = Some(Link {
                previous: position.checked_sub(1).map(|before| chain[before]),
                next: chain.get(position + 1).copied(),
                content: Content::Text,
            });
        }
        events
    }

    /// The edits made non-overlapping, none of them removing a chain member,
    /// from raw draws.
    fn settled(draws: &[(usize, usize, usize)], count: usize, chain: &[usize]) -> Vec<Edit> {
        let mut edits: Vec<Edit> = Vec::new();
        let mut taken = 0;
        let mut sorted = draws.to_vec();
        sorted.sort_by_key(|draw| *draw);
        for (at, remove, add) in sorted {
            let at = at % (count + 1);
            if at < taken {
                continue;
            }
            let mut remove = remove.min(count - at);
            while remove > 0 && (at..at + remove).any(|id| chain.contains(&id)) {
                remove -= 1;
            }
            edits.push((at, remove, add));
            taken = at + remove.max(1);
        }
        edits
    }

    /// What the edits make of the events, built event by event: the oracle for
    /// where each original event lands, sharing none of `consume`'s index
    /// arithmetic.
    fn applied(events: &[Event], edits: &[Edit]) -> Vec<Event> {
        let mut out = Vec::new();
        let mut at = 0;
        while at <= events.len() {
            if let Some((_, remove, add)) = edits.iter().find(|edit| edit.0 == at) {
                out.extend((0..*add).map(|_| event(Name::Emphasis)));
                at += remove;
                if *remove > 0 {
                    continue;
                }
            }
            if let Some(kept) = events.get(at) {
                out.push(kept.clone());
            }
            at += 1;
        }
        out
    }

    #[test]
    fn links_still_name_the_events_they_named_after_any_edits() {
        use whiteboard_proptest::proptest::prelude::{prop, prop_assert, prop_assert_eq};
        use whiteboard_proptest::{Floor, check};
        let moved = Floor::new("a link whose target moved");
        let strategy = (
            8_usize..40,
            prop::collection::vec(0_usize..40, 2..6),
            prop::collection::vec((0_usize..45, 0_usize..4, 0_usize..4), 1..8),
        );
        check(strategy, None, |(count, raw_chain, draws)| {
            let mut chain: Vec<usize> = raw_chain.iter().map(|at| at % count).collect();
            chain.sort_by_key(|at| *at);
            chain.dedup();
            let before = linked_events(count, &chain);
            let edits = settled(&draws, count, &chain);
            let expected = applied(&before, &edits);

            let mut events = before.clone();
            let mut map = EditMap::new();
            for (at, remove, add) in &edits {
                map.add(*at, *remove, (0..*add).map(|_| event(Name::Emphasis)).collect());
            }
            map.consume(&mut events);
            prop_assert_eq!(events.len(), expected.len());

            for id in &chain {
                let at = events.iter().position(|e| e.link.is_some() && e.point.index == *id);
                prop_assert!(at.is_some(), "event {id} is gone");
                let at = at.unwrap_or_default();
                let link = events[at].link.as_ref();
                let target_of = |wanted: Option<usize>| {
                    wanted.and_then(|old| {
                        expected.iter().position(|e| e.link.is_some() && e.point.index == old)
                    })
                };
                let old = before[*id].link.as_ref();
                prop_assert_eq!(link.and_then(|l| l.next), target_of(old.and_then(|l| l.next)));
                prop_assert_eq!(
                    link.and_then(|l| l.previous),
                    target_of(old.and_then(|l| l.previous))
                );
                moved.draw(link.and_then(|l| l.next).is_some_and(|next| next != at + 1));
            }
            Ok(())
        });
        moved.assert(100);
    }
}
