//! The reference grammar's scanner (`scan.ts`'s `findNextReference`).
//!
//! Offsets are bytes. Every character the grammar names is ASCII, so a cut
//! next to one is a character boundary, and a byte offset names the same cut
//! the TypeScript's UTF-16 index does.

/// One `[[target]]`, `[[target|alias]]` or `![[…]]` occurrence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReferenceMatch<'a> {
    /// Where the match starts: the `!` when there is one, otherwise the first `[`.
    pub index: usize,
    /// The whole match, brackets included.
    pub full: &'a str,
    pub is_embed: bool,
    /// The document half of the address: what resolves to a document id.
    pub target: &'a str,
    pub alias: Option<&'a str>,
    /// The part after the FIRST `#`, so a fragment may hold another; an empty
    /// one is none.
    pub fragment: Option<&'a str>,
}

/// How a reference whose target ends at a `]` or `|` closes.
enum Close {
    /// At `end`, with the alias between these bytes when one was written.
    Ended { end: usize, alias: Option<(usize, usize)> },
    /// It does not close; the scan resumes here, past everything inspected.
    Resume(usize),
    /// No `]` or `|` is left anywhere, so no reference can follow.
    Never,
}

/// The first `byte` at or after `from`, or the end of `bytes`.
fn first_of(bytes: &[u8], from: usize, found: impl Fn(u8) -> bool) -> usize {
    let rest = bytes.get(from..).unwrap_or_default();
    rest.iter().position(|&b| found(b)).map_or(bytes.len(), |at| from.saturating_add(at))
}

fn close_reference(bytes: &[u8], target_end: usize) -> Close {
    let after = target_end.saturating_add(1);
    match bytes.get(target_end) {
        None => Close::Never,
        Some(b']') if bytes.get(after) == Some(&b']') => {
            Close::Ended { end: target_end.saturating_add(2), alias: None }
        }
        Some(b']') => Close::Resume(after),
        Some(_) => {
            let bracket = first_of(bytes, after, |b| b == b']');
            if bytes.get(bracket.saturating_add(1)) == Some(&b']') {
                Close::Ended { end: bracket.saturating_add(2), alias: Some((after, bracket)) }
            } else {
                Close::Resume(bracket.saturating_add(1))
            }
        }
    }
}

fn slice(value: &str, from: usize, to: usize) -> &str {
    value.get(from..to).unwrap_or_default()
}

/// The next reference at or after byte `cursor` (`findNextReference`).
///
/// Linear: the scan only moves forward, past everything it has inspected, and
/// a target's walk is shared by the openers before where it stopped, since it
/// crossed no `]` or `|` (an opener with an empty target resumes two bytes on,
/// and walking again from there would make a run of them quadratic).
#[must_use]
pub fn find_next_reference(value: &str, cursor: usize) -> Option<ReferenceMatch<'_>> {
    let bytes = value.as_bytes();
    let mut pos = cursor;
    // Where the last walk for a target's end stopped.
    let mut walked = 0;
    // Each pass moves `pos` forward, so the bound is never what ends the loop.
    for _ in 0..=bytes.len() {
        let rest = bytes.get(pos..).unwrap_or_default();
        let open = pos.saturating_add(rest.windows(2).position(|w| w == b"[[")?);
        let content = open.saturating_add(2);
        walked = first_of(bytes, content.max(walked), |b| b == b']' || b == b'|');
        let raw = slice(value, content, walked);
        if raw.is_empty() || raw.starts_with('#') {
            pos = content;
            continue;
        }
        let (end, alias) = match close_reference(bytes, walked) {
            Close::Never => return None,
            Close::Resume(at) => {
                pos = at;
                continue;
            }
            Close::Ended { end, alias } => (end, alias),
        };
        let is_embed = open.checked_sub(1).and_then(|at| bytes.get(at)) == Some(&b'!');
        let index = open.saturating_sub(usize::from(is_embed));
        let (target, fragment) = raw.split_once('#').map_or((raw, None), |(t, f)| (t, Some(f)));
        return Some(ReferenceMatch {
            index,
            full: slice(value, index, end),
            is_embed,
            target,
            alias: alias.map(|(from, to)| slice(value, from, to)),
            fragment: fragment.filter(|f| !f.is_empty()),
        });
    }
    None
}
