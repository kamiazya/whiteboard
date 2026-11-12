//! Infer things from events.
//!
//! Used by the tree builder.

use crate::vendored::event::{Event, Kind, Name};
use crate::vendored::mdast::AlignKind;
use alloc::{vec, vec::Vec};

/// Figure out if a list is spread or not.
///
/// When `include_items: true` is passed, infers whether the list as a whole
/// is “loose”.
pub(crate) fn list_loose(events: &[Event], mut index: usize, include_items: bool) -> bool {
    let mut balance = 0;
    let name = &events[index].name;

    while index < events.len() {
        let event = &events[index];

        if event.kind == Kind::Enter {
            balance += 1;

            if include_items
                && balance == 2
                && event.name == Name::ListItem
                && list_item_loose(events, index)
            {
                return true;
            }
        } else {
            balance -= 1;

            if balance == 1 && event.name == Name::BlankLineEnding {
                // Blank line directly after item, which is just a prefix.
                //
                // ```markdown
                // > | -␊
                //      ^
                //   | - a
                // ```
                let mut at_empty_list_item = false;
                // Blank line at block quote prefix:
                //
                // ```markdown
                // > | * >␊
                //        ^
                //   | * a
                // ```
                let mut at_empty_block_quote = false;

                // List.
                let mut before = index - 2;

                if events[before].name == Name::ListItem {
                    before -= 1;

                    if events[before].name == Name::SpaceOrTab {
                        before -= 2;
                    }

                    if events[before].name == Name::BlockQuote
                        && events[before - 1].name == Name::BlockQuotePrefix
                    {
                        at_empty_block_quote = true;
                    } else if events[before].name == Name::ListItemPrefix {
                        at_empty_list_item = true;
                    }
                }

                if !at_empty_list_item && !at_empty_block_quote {
                    return true;
                }
            }

            // Done.
            if balance == 0 && event.name == *name {
                break;
            }
        }

        index += 1;
    }

    false
}

/// Whether only blank lines and the white space of them are left of the item at `next`.
///
/// A blank line the item ends on separates nothing inside it, which is how the
/// `TypeScript` reads `spread`.
fn ends_item(events: &[Event], mut next: usize) -> bool {
    while next < events.len()
        && matches!(events[next].name, Name::BlankLineEnding | Name::SpaceOrTab)
    {
        next += 1;
    }
    next < events.len() && events[next].kind == Kind::Exit && events[next].name == Name::ListItem
}

/// Figure out if an item is spread or not.
pub(crate) fn list_item_loose(events: &[Event], mut index: usize) -> bool {
    let mut balance = 0;

    while index < events.len() {
        let event = &events[index];

        if event.kind == Kind::Enter {
            balance += 1;
        } else {
            balance -= 1;

            if balance == 1 && event.name == Name::BlankLineEnding {
                // Blank line directly after a prefix:
                //
                // ```markdown
                // > | -␊
                //      ^
                //   |   a
                // ```
                let mut at_prefix = false;

                // List item.
                let mut before = index - 2;

                if events[before].name == Name::SpaceOrTab {
                    before -= 2;
                }

                if events[before].name == Name::ListItemPrefix {
                    at_prefix = true;
                }

                // Past a blank line the item ends on there are only blank lines:
                // answered here, not once a line (that walked the tail per line).
                if !at_prefix {
                    return !ends_item(events, index + 1);
                }
            }

            // Done.
            if balance == 0 && event.name == Name::ListItem {
                break;
            }
        }

        index += 1;
    }

    false
}

/// Figure out the alignment of a GFM table.
pub(crate) fn gfm_table_align(events: &[Event], mut index: usize) -> Vec<AlignKind> {
    let mut in_delimiter_row = false;
    let mut align = vec![];

    while index < events.len() {
        let event = &events[index];

        if in_delimiter_row {
            if event.kind == Kind::Enter {
                // Start of alignment value: set a new column.
                if event.name == Name::GfmTableDelimiterCellValue {
                    align.push(if events[index + 1].name == Name::GfmTableDelimiterMarker {
                        AlignKind::Left
                    } else {
                        AlignKind::None
                    });
                }
            } else {
                // End of alignment value: change the column.
                if event.name == Name::GfmTableDelimiterCellValue {
                    if events[index - 1].name == Name::GfmTableDelimiterMarker {
                        let align_index = align.len() - 1;
                        align[align_index] = if align[align_index] == AlignKind::Left {
                            AlignKind::Center
                        } else {
                            AlignKind::Right
                        }
                    }
                }
                // Done!
                else if event.name == Name::GfmTableDelimiterRow {
                    break;
                }
            }
        } else if event.kind == Kind::Enter && event.name == Name::GfmTableDelimiterRow {
            in_delimiter_row = true;
        }

        index += 1;
    }

    align
}
