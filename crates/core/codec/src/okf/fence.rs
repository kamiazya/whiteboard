//! The fences around an OKF document's frontmatter.

/// What `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/` captures: the
/// frontmatter text and the body, or `None` when the text does not open with
/// a block.
///
/// The closing fence is the FIRST `\n---` after the opening one, whatever
/// follows its dashes: `---abc` closes a block and leaves `abc` as the body,
/// and one carriage return and one newline after the dashes are dropped.
/// The opening fence is followed by a line break, so a block with nothing in
/// it needs a blank line between the fences.
pub(super) fn split(text: &str) -> Option<(&str, &str)> {
    let after = text.strip_prefix("---")?;
    let start = if after.starts_with("\r\n") {
        5
    } else if after.starts_with('\n') {
        4
    } else {
        return None;
    };
    let bytes = text.as_bytes();
    let (close, end) = (start..bytes.len()).find_map(|at| Some((at, closing_end(bytes, at)?)))?;
    let mut body = end;
    if bytes.get(body) == Some(&b'\r') {
        body = body.saturating_add(1);
    }
    if bytes.get(body) == Some(&b'\n') {
        body = body.saturating_add(1);
    }
    Some((text.get(start..close)?, text.get(body..)?))
}

/// Where a closing fence that starts at `at` ends: `\r?\n---`.
fn closing_end(bytes: &[u8], at: usize) -> Option<usize> {
    let rest = bytes.get(at..)?;
    let line = rest.strip_prefix(b"\r").unwrap_or(rest);
    let dashes = line.strip_prefix(b"\n")?.strip_prefix(b"---")?;
    Some(bytes.len().saturating_sub(dashes.len()))
}
