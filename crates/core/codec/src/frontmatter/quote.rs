//! How `yaml.stringify` spells a string: plain when the text reads back as
//! the same string, single-quoted or JSON double-quoted when it does not, and
//! a block scalar for multi-line text.

use super::block_string::block_string;
use super::fold::{Mode, Units, fold};
use super::schema::{Core, resolve_plain};

const NEWLINE: u16 = b'\n' as u16;
const SPACE: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const DOUBLE_QUOTE: u16 = b'"' as u16;
const SINGLE_QUOTE: u16 = b'\'' as u16;

/// What a scalar's spelling depends on beyond the text.
#[derive(Clone)]
pub(super) struct Ctx {
    /// Columns of indentation the scalar's own lines carry.
    pub(super) indent: usize,
    /// The scalar is a mapping key, which must stay on one line.
    pub(super) implicit_key: bool,
    /// The column a scalar value starts at, which its first line is folded from.
    pub(super) indent_at_start: Option<usize>,
    /// A block scalar at the root is indented anyway, since a line of it
    /// could start with a document marker.
    pub(super) force_block_indent: bool,
}

pub(super) fn units(text: &str) -> Units {
    text.encode_utf16().collect()
}

fn spaces(count: usize) -> impl Iterator<Item = u16> {
    std::iter::repeat_n(SPACE, count)
}

/// `/^(%|---|\.\.\.)/m`, where `^` also follows CR, U+2028 and U+2029.
fn contains_document_marker(text: &[u16]) -> bool {
    let starts_line = |i: usize| {
        i.checked_sub(1)
            .and_then(|p| text.get(p))
            .is_none_or(|&u| matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029))
    };
    (0..text.len()).filter(|&i| starts_line(i)).any(|i| {
        let rest = text.get(i..).unwrap_or_default();
        rest.first() == Some(&u16::from(b'%'))
            || rest.starts_with(&units("---"))
            || rest.starts_with(&units("..."))
    })
}

/// A string `yaml` writes in double quotes whatever else is true of it:
/// a control character it would otherwise write raw, and the two shapes the
/// subset's reader cannot take back from a block scalar.
pub(super) fn needs_double_quotes(text: &[u16]) -> bool {
    let control = |u: u16| u <= 8 || (0x0b..=0x1f).contains(&u) || (0x7f..=0x9f).contains(&u);
    if text.iter().copied().any(control) {
        return true;
    }
    let lines: Vec<&[u16]> = text.split(|&u| u == NEWLINE).collect();
    lines.iter().enumerate().any(|(index, line)| {
        let indent = line.iter().take_while(|&&u| u == SPACE).count();
        let last = index.saturating_add(1) == lines.len();
        line.get(indent) == Some(&TAB) || (!last && indent > 0 && indent == line.len())
    })
}

/// `JSON.stringify` of a string, which `doubleQuotedAsJSON` writes as it is.
pub(super) fn json_string(text: &[u16]) -> Units {
    let mut out = vec![DOUBLE_QUOTE];
    for &unit in text {
        match unit {
            0x22 => out.extend(units("\\\"")),
            0x5c => out.extend(units("\\\\")),
            0x08 => out.extend(units("\\b")),
            0x0c => out.extend(units("\\f")),
            0x0a => out.extend(units("\\n")),
            0x0d => out.extend(units("\\r")),
            0x09 => out.extend(units("\\t")),
            u if u < 0x20 => out.extend(units(&format!("\\u{u:04x}"))),
            u => out.push(u),
        }
    }
    out.push(DOUBLE_QUOTE);
    out
}

pub(super) fn indent_for(text: &[u16], ctx: &Ctx, force: bool) -> usize {
    if ctx.indent > 0 {
        ctx.indent
    } else if force || contains_document_marker(text) {
        2
    } else {
        0
    }
}

/// Single quotes are for one line. Text with a line break is written in
/// double quotes whichever way it got here: a key must stay on one line, and
/// the only multi-line text that reaches a quoted form is one a block scalar
/// cannot hold, whose blanks around a break single quotes cannot hold either.
fn single_quoted(text: &[u16], ctx: &Ctx) -> Units {
    if text.contains(&NEWLINE) {
        return json_string(text);
    }
    let indent = indent_for(text, ctx, false);
    let mut out = vec![SINGLE_QUOTE];
    for &unit in text {
        out.push(unit);
        if unit == SINGLE_QUOTE {
            out.push(SINGLE_QUOTE);
        }
    }
    out.push(SINGLE_QUOTE);
    if ctx.implicit_key { out } else { fold(&out, indent, Mode::Flow, ctx.indent_at_start).text }
}

/// Single quotes when the text holds only double quotes, JSON otherwise.
pub(super) fn quoted(text: &[u16], ctx: &Ctx) -> Units {
    let has_double = text.contains(&DOUBLE_QUOTE);
    let has_single = text.contains(&SINGLE_QUOTE);
    if has_double && !has_single { single_quoted(text, ctx) } else { json_string(text) }
}

/// Runs of newlines in `text`, each as `(start, end)`.
pub(super) fn newline_runs(text: &[u16]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut start: Option<usize> = None;
    for (i, &unit) in text.iter().enumerate() {
        match (unit == NEWLINE, start) {
            (true, None) => start = Some(i),
            (false, Some(from)) => {
                runs.push((from, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        runs.push((from, text.len()));
    }
    runs
}

/// `.replace(/\n+/g, `$&${extra}${indent}`)`: each run of newlines followed
/// by `extra` and then `indent` spaces.
pub(super) fn after_newline_runs(text: &[u16], extra: &[u16], indent: usize) -> Units {
    let mut out = Units::new();
    let mut from = 0usize;
    for (_, end) in newline_runs(text) {
        out.extend_from_slice(text.get(from..end).unwrap_or_default());
        out.extend_from_slice(extra);
        out.extend(spaces(indent));
        from = end;
    }
    out.extend_from_slice(text.get(from..).unwrap_or_default());
    out
}

/// Whether `yaml`'s core schema reads this text as something but a string.
fn reads_as_non_string(text: &[u16]) -> bool {
    resolve_plain(&String::from_utf16_lossy(text)) != Core::Text
}

fn starts_with_indicator(text: &[u16]) -> bool {
    let indicator =
        |u: u16| char::from_u32(u32::from(u)).is_some_and(|c| "\n\t ,[]{}#&*!|>'\"%@`".contains(c));
    text.first().is_some_and(|&u| indicator(u))
}

/// Text a plain scalar cannot be: one that starts with an indicator, is `?` or
/// `-` alone or before a blank, holds `: `, a blank before a line break or a
/// `#` after a blank, or ends with a blank or a colon.
fn plain_cannot_hold(text: &[u16]) -> bool {
    let dash_or_question = |u: u16| u == u16::from(b'?') || u == u16::from(b'-');
    let blank = |u: u16| u == SPACE || u == TAB;
    let colon = u16::from(b':');
    let pairs = text.windows(2).any(|pair| match pair[..] {
        [a, b] => {
            ((a == NEWLINE || a == colon) && blank(b))
                || (blank(a) && b == NEWLINE)
                || ((a == NEWLINE || blank(a)) && b == u16::from(b'#'))
        }
        _ => false,
    });
    let leading = match text {
        [only] => dash_or_question(*only),
        [first, second, ..] => dash_or_question(*first) && blank(*second),
        [] => false,
    };
    starts_with_indicator(text)
        || leading
        || pairs
        || text.last().is_some_and(|&u| u == NEWLINE || blank(u) || u == colon)
}

fn plain_string(text: &[u16], ctx: &mut Ctx) -> Units {
    let multi_line = text.contains(&NEWLINE);
    if ctx.implicit_key && multi_line {
        return quoted(text, ctx);
    }
    if plain_cannot_hold(text) {
        return if ctx.implicit_key || !multi_line {
            quoted(text, ctx)
        } else {
            block_string(text, ctx)
        };
    }
    if !ctx.implicit_key && multi_line {
        return block_string(text, ctx);
    }
    if contains_document_marker(text) {
        if ctx.indent == 0 {
            ctx.force_block_indent = true;
            return block_string(text, ctx);
        }
        if ctx.implicit_key && ctx.indent == 2 {
            return quoted(text, ctx);
        }
    }
    let spelled = after_newline_runs(text, &[NEWLINE], ctx.indent);
    if reads_as_non_string(&spelled) {
        return quoted(text, ctx);
    }
    if ctx.implicit_key {
        spelled
    } else {
        fold(&spelled, ctx.indent, Mode::Flow, ctx.indent_at_start).text
    }
}

/// A string's spelling in the document.
pub(super) fn string(text: &[u16], ctx: &mut Ctx) -> Units {
    if needs_double_quotes(text) { json_string(text) } else { plain_string(text, ctx) }
}
