//! What an excerpt shows of markdown: the words typeset, without the
//! typesetting. Each step is one of `snippet.ts`'s regular expressions
//! written out over UTF-16 units, in the same order, because a later step
//! reads what an earlier one left.

use crate::units::{
    LF, collapse_whitespace, decode, encode, is_blank, is_line_terminator, slice, trim,
};

/// Stands in for a rendered link while the rest of the excerpt is stripped.
const LINK_OPEN: u16 = 0xe001;
const LINK_CLOSE: u16 = 0xe002;
const BANG: u16 = 0x21;
const OPEN_BRACKET: u16 = 0x5b;
const CLOSE_BRACKET: u16 = 0x5d;

/// What a `[[target]]` shows in an excerpt: the target's display name when the
/// caller knows it, none to fall back to the target's last segment.
pub type LinkLabel<'a> = &'a dyn Fn(&str) -> Option<String>;

/// A wiki link or embed, as the reference extractor reads one: no brackets or
/// line breaks inside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Link {
    pub(crate) end: usize,
    inner_from: usize,
    inner_to: usize,
}

/// `/!?\[\[([^[\]\n]*)\]\]/y` at `at`.
#[must_use]
pub(crate) fn link_at(units: &[u16], at: usize) -> Option<Link> {
    let bang = usize::from(units.get(at) == Some(&BANG));
    let open = at.saturating_add(bang);
    if units.get(open) != Some(&OPEN_BRACKET)
        || units.get(open.saturating_add(1)) != Some(&OPEN_BRACKET)
    {
        return None;
    }
    let inner_from = open.saturating_add(2);
    let mut at_close = inner_from;
    while units.get(at_close).is_some_and(|u| !matches!(*u, 0x5b | 0x5d | LF)) {
        at_close = at_close.saturating_add(1);
    }
    if units.get(at_close) == Some(&CLOSE_BRACKET)
        && units.get(at_close.saturating_add(1)) == Some(&CLOSE_BRACKET)
    {
        return Some(Link { end: at_close.saturating_add(2), inner_from, inner_to: at_close });
    }
    None
}

/// `replace(LINK, (_, inner) => with(inner))`.
fn replace_links(units: &[u16], mut with: impl FnMut(&[u16]) -> Vec<u16>) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0_usize;
    while let Some(unit) = units.get(at) {
        if let Some(link) = link_at(units, at) {
            out.extend(with(slice(units, link.inner_from, link.inner_to)));
            at = link.end;
        } else {
            out.push(*unit);
            at = at.saturating_add(1);
        }
    }
    out
}

/// `[[target#Heading|alias]]`'s inner text as a reader sees it.
fn link_text(inner: &[u16], label_of: Option<LinkLabel<'_>>) -> Vec<u16> {
    if let Some(bar) = inner.iter().position(|u| *u == 0x7c) {
        return slice(inner, bar.saturating_add(1), inner.len()).to_vec();
    }
    let hash = inner.iter().position(|u| *u == 0x23);
    let target = decode(trim(slice(inner, 0, hash.unwrap_or(inner.len()))));
    let heading = hash
        .map_or_else(Vec::new, |at| trim(slice(inner, at.saturating_add(1), inner.len())).to_vec());
    let label = if target.is_empty() {
        String::new()
    } else {
        label_of.and_then(|of| of(&target)).unwrap_or_else(|| leaf_of_path(&target).to_owned())
    };
    if heading.is_empty() {
        return encode(&label);
    }
    if label.is_empty() {
        return heading;
    }
    let mut joined = encode(&label);
    joined.extend(encode(" › "));
    joined.extend(heading);
    joined
}

/// `leafOfPath`: what follows the last `/`.
#[must_use]
pub(crate) fn leaf_of_path(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// A link rendered in place, and nothing else touched.
#[must_use]
pub(crate) fn render_links(units: &[u16], label_of: Option<LinkLabel<'_>>) -> Vec<u16> {
    replace_links(units, |inner| link_text(inner, label_of))
}

/// Applies `matched` to each line (split at every line terminator, as a
/// multiline `^` sees them); it answers how many leading units to drop.
fn drop_in_lines(units: &[u16], matched: impl Fn(&[u16]) -> usize) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut line_start = 0_usize;
    for at in 0..=units.len() {
        let ends = units.get(at).is_none_or(|u| is_line_terminator(*u));
        if !ends {
            continue;
        }
        let line = slice(units, line_start, at);
        out.extend_from_slice(slice(line, matched(line), line.len()));
        if let Some(terminator) = units.get(at) {
            out.push(*terminator);
        }
        line_start = at.saturating_add(1);
    }
    out
}

fn skip_blanks(line: &[u16], from: usize) -> usize {
    let mut at = from;
    while line.get(at).is_some_and(|u| is_blank(*u)) {
        at = at.saturating_add(1);
    }
    at
}

fn run_of(line: &[u16], from: usize, unit: u16) -> usize {
    let mut at = from;
    while line.get(at) == Some(&unit) {
        at = at.saturating_add(1);
    }
    at.saturating_sub(from)
}

/// A fence line (three or more backticks or tildes after blanks), dropped whole.
fn fence_len(line: &[u16]) -> usize {
    let at = skip_blanks(line, 0);
    let fenced = [0x60_u16, 0x7e].iter().any(|mark| run_of(line, at, *mark) >= 3);
    if fenced { line.len() } else { 0 }
}

/// One `:?-{2,}:?[ \t]*` cell of a table delimiter row, the position after it.
fn delimiter_cell(line: &[u16], from: usize) -> Option<usize> {
    let mut at = from;
    if line.get(at) == Some(&0x3a) {
        at = at.saturating_add(1);
    }
    let dashes = run_of(line, at, 0x2d);
    if dashes < 2 {
        return None;
    }
    at = at.saturating_add(dashes);
    if line.get(at) == Some(&0x3a) {
        at = at.saturating_add(1);
    }
    Some(skip_blanks(line, at))
}

/// A table's delimiter row, dropped whole:
/// `^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$`.
fn delimiter_row_len(line: &[u16]) -> usize {
    let mut at = skip_blanks(line, 0);
    if line.get(at) == Some(&0x7c) {
        at = skip_blanks(line, at.saturating_add(1));
    }
    let Some(mut after) = delimiter_cell(line, at) else { return 0 };
    while line.get(after) == Some(&0x7c) {
        let past_pipe = skip_blanks(line, after.saturating_add(1));
        if let Some(next) = delimiter_cell(line, past_pipe) {
            after = next;
        } else {
            after = past_pipe;
            break;
        }
    }
    if after == line.len() { line.len() } else { 0 }
}

/// What follows a marker: blanks (all of them) or the end of the line.
fn after_marker(line: &[u16], from: usize) -> Option<usize> {
    if from == line.len() {
        return Some(from);
    }
    let past = skip_blanks(line, from);
    (past > from).then_some(past)
}

/// A bullet followed by a task box: `[-*+][ \t]+\[[ xX]\][ \t]+`.
fn task_marker_len(line: &[u16], at: usize) -> Option<usize> {
    let after = skip_blanks(line, at.saturating_add(1));
    if after == at.saturating_add(1) || line.get(after) != Some(&OPEN_BRACKET) {
        return None;
    }
    if !matches!(line.get(after.saturating_add(1)), Some(0x20 | 0x78 | 0x58))
        || line.get(after.saturating_add(2)) != Some(&CLOSE_BRACKET)
    {
        return None;
    }
    let done = after.saturating_add(3);
    let past = skip_blanks(line, done);
    (past > done).then_some(past)
}

/// The leading marker of a line (heading, quote, task, bullet, ordered item)
/// as `snippet.ts`'s alternation reads it, in its order.
fn marker_len(line: &[u16]) -> usize {
    let at = skip_blanks(line, 0);
    let hashes = run_of(line, at, 0x23);
    if let Some(end) =
        (1..=6).contains(&hashes).then(|| after_marker(line, at.saturating_add(hashes))).flatten()
    {
        return end;
    }
    if line.get(at) == Some(&0x3e) {
        let mut end = at;
        while line.get(end) == Some(&0x3e) {
            end = end.saturating_add(1);
            if line.get(end).is_some_and(|u| is_blank(*u)) {
                end = end.saturating_add(1);
            }
        }
        return end;
    }
    if line.get(at).is_some_and(|u| matches!(*u, 0x2d | 0x2a | 0x2b)) {
        return task_marker_len(line, at)
            .or_else(|| after_marker(line, at.saturating_add(1)))
            .unwrap_or(0);
    }
    let digits = line
        .get(at..)
        .unwrap_or_default()
        .iter()
        .take_while(|u| (0x30..=0x39).contains(*u))
        .count();
    let stop = at.saturating_add(digits);
    if digits > 0 && matches!(line.get(stop), Some(0x2e | 0x29)) {
        return after_marker(line, stop.saturating_add(1)).unwrap_or(0);
    }
    0
}

/// `!?\[([^\]]*)\]\([^)]*\)` at `at`: the label's range and the end.
fn link_syntax_at(units: &[u16], at: usize) -> Option<(usize, usize, usize)> {
    let open = if units.get(at) == Some(&BANG) { at.saturating_add(1) } else { at };
    if units.get(open) != Some(&OPEN_BRACKET) {
        return None;
    }
    let label_from = open.saturating_add(1);
    let close = label_from
        .saturating_add(units.get(label_from..)?.iter().position(|u| *u == CLOSE_BRACKET)?);
    if units.get(close.saturating_add(1)) != Some(&0x28) {
        return None;
    }
    let target_from = close.saturating_add(2);
    let stop =
        target_from.saturating_add(units.get(target_from..)?.iter().position(|u| *u == 0x29)?);
    Some((label_from, close, stop.saturating_add(1)))
}

/// `replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')`.
fn unwrap_link_syntax(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0_usize;
    while let Some(unit) = units.get(at) {
        if let Some((from, to, end)) = link_syntax_at(units, at) {
            out.extend_from_slice(slice(units, from, to));
            at = end;
        } else {
            out.push(*unit);
            at = at.saturating_add(1);
        }
    }
    out
}

/// Drops `**`, `__`, `~~` and each backtick.
fn drop_emphasis(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0_usize;
    while let Some(unit) = units.get(at) {
        let pair =
            units.get(at.saturating_add(1)) == Some(unit) && matches!(*unit, 0x2a | 0x5f | 0x7e);
        if pair {
            at = at.saturating_add(2);
        } else if *unit == 0x60 {
            at = at.saturating_add(1);
        } else {
            out.push(*unit);
            at = at.saturating_add(1);
        }
    }
    out
}

/// `replace(/[ \t]*\|[ \t]*/g, ' ')`.
fn pipes_to_spaces(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0_usize;
    while let Some(unit) = units.get(at) {
        let past_blanks = skip_blanks(units, at);
        if units.get(past_blanks) == Some(&0x7c) {
            out.push(0x20);
            at = skip_blanks(units, past_blanks.saturating_add(1));
        } else {
            out.push(*unit);
            at = at.saturating_add(1);
        }
    }
    out
}

/// `replace(OPEN(\d+)CLOSE, (_, i) => links[Number(i)] ?? '')`.
fn put_links_back(units: &[u16], links: &[Vec<u16>]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0_usize;
    while let Some(unit) = units.get(at) {
        let from = at.saturating_add(1);
        let digits = if *unit == LINK_OPEN {
            units
                .get(from..)
                .unwrap_or_default()
                .iter()
                .take_while(|u| (0x30..=0x39).contains(*u))
                .count()
        } else {
            0
        };
        let close = from.saturating_add(digits);
        if digits > 0 && units.get(close) == Some(&LINK_CLOSE) {
            let number = decode(slice(units, from, close)).parse::<usize>().ok();
            if let Some(link) = number.and_then(|n| links.get(n)) {
                out.extend_from_slice(link);
            }
            at = close.saturating_add(1);
        } else {
            out.push(*unit);
            at = from;
        }
    }
    out
}

/// The words markdown typesets, without the typesetting: fence lines, quote /
/// list / task / heading markers, table delimiter rows and cell pipes, and
/// inline emphasis, code ticks and link syntax. A wiki link becomes what it
/// reads as, after everything else, so neither a pipe in it nor markup in a
/// display name is mistaken for the excerpt's own.
#[must_use]
pub(crate) fn strip_markup(chunk: &[u16], label_of: Option<LinkLabel<'_>>) -> Vec<u16> {
    let mut links: Vec<Vec<u16>> = Vec::new();
    let held = replace_links(chunk, |inner| {
        links.push(link_text(inner, label_of));
        let mut stand_in = vec![LINK_OPEN];
        stand_in.extend(encode(&links.len().saturating_sub(1).to_string()));
        stand_in.push(LINK_CLOSE);
        stand_in
    });
    let held = drop_in_lines(&held, fence_len);
    let held = drop_in_lines(&held, delimiter_row_len);
    let held = drop_in_lines(&held, marker_len);
    let held = unwrap_link_syntax(&held);
    let held = drop_emphasis(&held);
    let held = pipes_to_spaces(&held);
    put_links_back(&held, &links)
}

/// The text of an excerpt with its whitespace collapsed.
#[must_use]
pub(crate) fn plain(units: &[u16]) -> Vec<u16> {
    collapse_whitespace(units)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn strip(text: &str) -> String {
        decode(&strip_markup(&encode(text), None))
    }

    #[test]
    fn markers_and_syntax_are_stripped() {
        assert_eq!(strip("## Title"), "Title");
        assert_eq!(strip("> > quoted"), "quoted");
        assert_eq!(strip("- [x] done"), "done");
        assert_eq!(strip("- [x]done"), "[x]done");
        assert_eq!(strip("1. one\n2) two"), "one\ntwo");
        assert_eq!(strip("####### seven"), "####### seven");
        assert_eq!(strip("**bold** `code` ~~gone~~ __u__"), "bold code gone u");
        assert_eq!(strip("![alt](http://x) [t](u)"), "alt t");
        assert_eq!(strip("| a | b |"), " a b ");
    }

    #[test]
    fn fences_and_delimiter_rows_vanish() {
        assert_eq!(strip("a\n```rust\nb"), "a\n\nb");
        assert_eq!(strip("|---|:--:|\n"), "\n");
        assert_eq!(strip("--"), "");
        assert_eq!(strip("|-|"), " - ");
        assert_eq!(strip("- "), "");
    }

    #[test]
    fn a_link_reads_as_its_label_alias_or_heading() {
        let labels = |target: &str| (target == "a/b").then(|| "Bee".to_owned());
        let shown = |text: &str| decode(&strip_markup(&encode(text), Some(&labels)));
        assert_eq!(shown("x [[a/b]] y"), "x Bee y");
        assert_eq!(shown("![[a/b#H]]"), "Bee › H");
        assert_eq!(shown("[[a/b|the alias]]"), "the alias");
        assert_eq!(shown("[[other/leaf]]"), "leaf");
        assert_eq!(shown("[[#Only]]"), "Only");
        assert_eq!(shown("[[ ]]"), "");
    }

    #[test]
    fn link_at_follows_the_reference_grammar() {
        let units = encode("a ![[x]] [[y\n]]");
        assert_eq!(link_at(&units, 2).map(|l| l.end), Some(8));
        assert_eq!(link_at(&units, 3).map(|l| l.end), Some(8));
        assert_eq!(link_at(&units, 9), None);
        assert_eq!(link_at(&units, 10), None);
    }

    #[test]
    fn leaf_of_path_is_the_last_segment() {
        assert_eq!(leaf_of_path("a/b/c"), "c");
        assert_eq!(leaf_of_path("c"), "c");
        assert_eq!(leaf_of_path("a/"), "");
    }
}
