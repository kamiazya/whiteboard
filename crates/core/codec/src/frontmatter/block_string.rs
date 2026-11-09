//! `yaml.stringify`'s block scalars: `|` when the text fits, `>` when a line
//! is long enough to be worth folding, and a quoted form when neither can
//! hold the text.

use super::fold::{Mode, Units, fold};
use super::quote::{Ctx, after_newline_runs, indent_for, newline_runs, quoted, units};

const NEWLINE: u16 = b'\n' as u16;
const SPACE: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;

/// Whether `text` has a line past `80 - indent` units.
fn line_over_limit(text: &[u16], indent: usize) -> bool {
    let width = 80usize.saturating_sub(indent);
    if text.len() <= width {
        return false;
    }
    let mut line_start = 0usize;
    for (i, &unit) in text.iter().enumerate() {
        if unit == NEWLINE {
            if i.saturating_sub(line_start) > width {
                return true;
            }
            line_start = i.saturating_add(1);
            if text.len().saturating_sub(line_start) <= width {
                return false;
            }
        }
    }
    true
}

fn is_blank(unit: u16) -> bool {
    matches!(unit, NEWLINE | TAB | SPACE)
}

/// How a block scalar's end is chomped, from the whitespace it ends with.
fn chomping(value: &[u16], end: &[u16]) -> &'static str {
    match end.iter().position(|&u| u == NEWLINE) {
        None => "-",
        Some(first) if value.len() == end.len() || first.saturating_add(1) != end.len() => "+",
        Some(_) => "",
    }
}

/// `.replace(/\n+/g, '\n$&')`
fn double_newline_runs(text: &[u16]) -> Units {
    let mut out = Units::new();
    let mut from = 0usize;
    for (start, end) in newline_runs(text) {
        out.extend_from_slice(text.get(from..start).unwrap_or_default());
        out.push(NEWLINE);
        out.extend_from_slice(text.get(start..end).unwrap_or_default());
        from = end;
    }
    out.extend_from_slice(text.get(from..).unwrap_or_default());
    out
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// `.replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, '$1$2')`: a
/// line that starts with a blank is kept as it is, with the empty lines that
/// close its indented run.
fn keep_more_indented(text: &[u16]) -> Units {
    let blank = |i: usize| text.get(i).is_some_and(|&u| u == SPACE || u == TAB);
    let mut out = Units::new();
    let mut at = 0usize;
    while at <= text.len() {
        let group = if at == 0 && blank(0) {
            Some(0)
        } else if text.get(at) == Some(&NEWLINE) && blank(at.saturating_add(1)) {
            Some(at.saturating_add(1))
        } else {
            None
        };
        let Some(first) = group else {
            out.extend(text.get(at));
            at = at.saturating_add(1);
            continue;
        };
        let rest = text.get(first.saturating_add(1)..).unwrap_or_default();
        let line_end = first
            .saturating_add(1)
            .saturating_add(rest.iter().take_while(|&&u| !is_line_terminator(u)).count());
        out.extend_from_slice(text.get(first..line_end).unwrap_or_default());
        let after = text.get(line_end..).unwrap_or_default();
        let run_end = line_end.saturating_add(after.iter().take_while(|&&u| is_blank(u)).count());
        let closes = run_end.checked_sub(1).and_then(|i| text.get(i)) == Some(&NEWLINE);
        if closes {
            out.extend_from_slice(
                text.get(line_end..run_end.saturating_sub(1)).unwrap_or_default(),
            );
            at = run_end;
        } else {
            at = line_end;
        }
    }
    out
}

/// How much of the text leads up to its last newline within the blanks it
/// starts with, and whether any of those blanks is a space.
fn leading_blanks(value: &[u16]) -> (usize, bool) {
    let blanks: Vec<u16> =
        value.iter().copied().take_while(|&u| u == SPACE || u == NEWLINE).collect();
    let cut = blanks.iter().rposition(|&u| u == NEWLINE).map_or(0, |n| n.saturating_add(1));
    (cut, blanks.contains(&SPACE))
}

pub(super) fn block_string(value: &[u16], ctx: &mut Ctx) -> Units {
    let trailing = value.iter().rev().take_while(|&&u| u == SPACE || u == TAB).count();
    let body_len = value.len().saturating_sub(trailing);
    if trailing > 0 && value.get(body_len.saturating_sub(1)) == Some(&NEWLINE) {
        return quoted(value, ctx);
    }
    let indent = indent_for(value, ctx, ctx.force_block_indent);
    let literal = !line_over_limit(value, indent);
    if value.is_empty() {
        return units(if literal { "|\n" } else { ">\n" });
    }
    let kept = value.iter().rev().take_while(|&&u| is_blank(u)).count();
    let split_at = value.len().saturating_sub(kept);
    let (text, end_whitespace) = value.split_at(split_at);
    let chomp = chomping(value, end_whitespace);
    let end = if end_whitespace.is_empty() {
        Units::new()
    } else {
        let without_last = match end_whitespace.split_last() {
            Some((&NEWLINE, rest)) => rest,
            _ => end_whitespace,
        };
        without_last.to_vec()
    };
    let (cut, starts_with_space) = leading_blanks(text);
    let (leading, text) = text.split_at(cut.min(text.len()));
    let leading =
        if leading.is_empty() { Units::new() } else { after_newline_runs(leading, &[], indent) };
    let indicator = if starts_with_space { if indent > 0 { "2" } else { "1" } } else { "" };
    let header = format!("{indicator}{chomp}");
    if !literal {
        let folded = double_newline_runs(text);
        let folded = after_newline_runs(&keep_more_indented(&folded), &[], indent);
        let joined: Units = [leading.as_slice(), folded.as_slice(), end.as_slice()].concat();
        let body = fold(&joined, indent, Mode::Block, Some(ctx.indent));
        if !body.overflowed {
            return folded_block(&header, indent, &body.text);
        }
    }
    let inner = after_newline_runs(text, &[], indent);
    literal_block(&header, indent, &[leading.as_slice(), inner.as_slice(), end.as_slice()].concat())
}

fn framed(marker: char, header: &str, indent: usize, body: &[u16]) -> Units {
    let mut out: Units = format!("{marker}{header}\n").encode_utf16().collect();
    out.extend(std::iter::repeat_n(SPACE, indent));
    out.extend_from_slice(body);
    out
}

fn folded_block(header: &str, indent: usize, body: &[u16]) -> Units {
    framed('>', header, indent, body)
}

fn literal_block(header: &str, indent: usize, body: &[u16]) -> Units {
    framed('|', header, indent, body)
}
