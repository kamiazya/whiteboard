//! The title a markdown body announces about itself, if it announces one
//! (`titleFromMarkdownBody` in the TypeScript's `title-from-body.ts`): the
//! first non-blank line, when it is a level-1 ATX heading. Lengths are UTF-16
//! code units and whitespace is ECMAScript's, as a JavaScript caller sees them.

use crate::display_name::js_trim;
use whiteboard_det::utf16;

/// Long enough for any title someone means as one; a heading past it is refused, not cut.
const MAX_TITLE_LENGTH: usize = 120;

/// A first line longer than this is refused before anything reads it.
const MAX_HEADING_LINE_LENGTH: usize = 4 * MAX_TITLE_LENGTH;

fn is_blank(byte: u8) -> bool {
    byte == b' ' || byte == b'\t'
}

fn is_js_space(c: char) -> bool {
    u16::try_from(u32::from(c)).is_ok_and(utf16::is_js_whitespace)
}

/// The end of `bytes[..end]` with its trailing blanks taken off.
fn before_blanks(bytes: &[u8], mut end: usize) -> usize {
    while let Some(at) = end.checked_sub(1)
        && bytes.get(at).copied().is_some_and(is_blank)
    {
        end = at;
    }
    end
}

/// A closed heading's every trailing marker run dropped (`# Title #`); `C#`
/// keeps its `#`, which no blank precedes. Markers and blanks are ASCII, so
/// the byte offsets are character boundaries.
fn strip_trailing_marker_runs(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut end = before_blanks(bytes, bytes.len());
    let mut kept = bytes.len();
    loop {
        let mut marker_start = end;
        while let Some(at) = marker_start.checked_sub(1)
            && bytes.get(at) == Some(&b'#')
        {
            marker_start = at;
        }
        let blank_before =
            marker_start.checked_sub(1).and_then(|at| bytes.get(at)).copied().is_some_and(is_blank);
        if marker_start == end || !blank_before {
            return text.get(..kept).unwrap_or(text);
        }
        end = before_blanks(bytes, marker_start);
        kept = end;
    }
}

/// The text of `# ` + text: a blank after the marker is required, and the
/// text starts on a non-blank and runs to the end of the line, holding no
/// line terminator.
fn heading_text(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('#')?;
    let text = rest.trim_start_matches([' ', '\t']);
    let terminator = |c: char| matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}');
    (text.len() < rest.len() && !text.is_empty() && !text.contains(terminator)).then_some(text)
}

/// Every run of whitespace made one space.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// The title the first non-blank line announces, `None` when that line is
/// no level-1 heading or the title is blank or too long.
#[must_use]
pub fn title_from_markdown_body(body: &str) -> Option<String> {
    let raw = body.split('\n').find(|line| !js_trim(line).is_empty())?;
    let line = raw.strip_suffix('\r').unwrap_or(raw);
    if utf16::len(line) > MAX_HEADING_LINE_LENGTH {
        return None;
    }
    let collapsed = collapse_whitespace(strip_trailing_marker_runs(heading_text(line)?));
    let title = js_trim(&collapsed);
    (!title.is_empty() && utf16::len(title) <= MAX_TITLE_LENGTH).then(|| title.to_owned())
}
