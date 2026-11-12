//! JavaScript's reading of a string, for the few places the typesetter's
//! arithmetic depends on it: `\s`, `trim` and `String.prototype.length`.

use whiteboard_model::checks::is_js_space;

/// `text.trimStart()`.
pub(super) fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

/// `text.trimEnd()`.
pub(super) fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// `text.trim().replace(/\s+/g, ' ')`: boundary whitespace dropped, every
/// interior run of it one space.
pub(super) fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in trim_start(trim_end(text)).chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `/^\s/.test(text)`.
pub(super) fn starts_with_space(text: &str) -> bool {
    text.chars().next().is_some_and(is_js_space)
}

/// `/\s$/.test(text)`.
pub(super) fn ends_with_space(text: &str) -> bool {
    text.chars().next_back().is_some_and(is_js_space)
}

/// `text.slice(from, to)` in UTF-16 units, answering `None` when the range is
/// not a whole number of code points: a `&str` cannot hold half a pair.
pub(super) fn slice_utf16(units: &[u16], from: usize, to: usize) -> Option<String> {
    String::from_utf16(units.get(from..to)?).ok()
}
