//! Refusals that need only the source text, run before any parsing so a
//! construct the grammar would reject with its own wording is named here. They
//! are the first half of the subset `frontmatter-yaml.ts` states.

use super::value::{MAX_BYTES, Refusal};

/// Refuses a text the subset has no reading for, and answers it with every
/// CRLF line ending turned into LF (a carriage return alone is refused).
pub(super) fn normalize(text: &str) -> Result<String, Refusal> {
    if text.len() > MAX_BYTES {
        return Err(Refusal::TooLarge);
    }
    refuse_characters(text)?;
    let normalized = text.replace("\r\n", "\n");
    if normalized.contains('\r') {
        return Err(Refusal::Subset("a carriage return outside a CRLF line ending"));
    }
    for line in normalized.split('\n') {
        refuse_line_start(line)?;
    }
    Ok(normalized)
}

/// A byte-order mark anywhere, and every C0 control but tab and the line
/// ends: the one place a writer escapes them is inside double quotes.
fn refuse_characters(text: &str) -> Result<(), Refusal> {
    if text.contains('\u{feff}') {
        return Err(Refusal::Subset("a byte-order mark"));
    }
    let raw_control = |c: char| c < ' ' && !matches!(c, '\t' | '\n' | '\r');
    if text.chars().any(raw_control) {
        return Err(Refusal::Subset("a raw control character"));
    }
    Ok(())
}

/// A tab indenting a line, a document marker and a directive: all judged on
/// where a line starts, and only LF starts a line.
fn refuse_line_start(line: &str) -> Result<(), Refusal> {
    if line.trim_start_matches(' ').starts_with('\t') {
        return Err(Refusal::Subset("a tab at the start of a line"));
    }
    let marker = |m: &str| {
        line.strip_prefix(m).is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '\t']))
    };
    if marker("---") || marker("...") || line.starts_with('%') {
        return Err(Refusal::Subset("a document marker or directive"));
    }
    Ok(())
}
