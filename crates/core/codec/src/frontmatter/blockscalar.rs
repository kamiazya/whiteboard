//! Literal (`|`) and folded (`>`) block scalars, line for line as `yaml`
//! 2.9's lexer finds their lines and `resolveBlockScalar` folds them.

use super::cursor::{Indent, Parsed, Parser, deeper, syntax};
use super::node::{Node, Style};

/// A block scalar's header: the indentation indicator and the chomping one.
struct Header {
    explicit: Option<usize>,
    chomp: char,
}

/// A source line of the scalar: its leading spaces and the rest.
type Line = (usize, String);

impl Parser {
    pub(super) fn block_scalar(&mut self, parent: Indent) -> Parsed<Node> {
        let literal = self.cur() == '|';
        self.bump();
        let header = self.block_header()?;
        let indent = self.block_indent(parent, header.explicit)?;
        let start = self.pos;
        let region_end = self.block_region(indent);
        let lines = self.block_lines(start, region_end, header.chomp);
        let text = fold_block(&lines, parent, &header, literal)?;
        self.next_line_content();
        Ok(Node::scalar(text, Style::Block))
    }

    /// `|`, `>`, then up to two indicators and an optional comment, on one line.
    fn block_header(&mut self) -> Parsed<Header> {
        let mut explicit = None;
        let mut chomp = ' ';
        for _ in 0..2 {
            let c = self.cur();
            if explicit.is_none() && matches!(c, '1'..='9') {
                explicit = c.to_digit(10).and_then(|d| usize::try_from(d).ok());
                self.bump();
            } else if chomp == ' ' && matches!(c, '-' | '+') {
                chomp = c;
                self.bump();
            }
        }
        if !self.blank_at(0) {
            return syntax("a malformed block scalar header");
        }
        self.skip_inline_whitespace();
        if self.cur() == '#' {
            self.skip_to_line_end();
        }
        if !self.eof() {
            if self.cur() != '\n' {
                return syntax("a malformed block scalar header");
            }
            self.bump();
        }
        Ok(Header { explicit, chomp })
    }

    /// The column the content sits at: stated by the header, or that of the
    /// first non-empty line when it is deeper than the parent.
    fn block_indent(&self, parent: Indent, explicit: Option<usize>) -> Parsed<usize> {
        if let Some(digit) = explicit {
            return Ok(parent.unwrap_or(0).saturating_add(digit));
        }
        let mut at = self.pos;
        let mut widest_empty = 0usize;
        loop {
            let line_start = at;
            while self.chars.get(at) == Some(&' ') {
                at = at.saturating_add(1);
            }
            let spaces = at.saturating_sub(line_start);
            match self.chars.get(at) {
                Some('\n') => {
                    widest_empty = widest_empty.max(spaces);
                    at = at.saturating_add(1);
                }
                Some(_) if deeper(spaces, parent) => {
                    if widest_empty > spaces {
                        return syntax("an empty line indented past the first content line");
                    }
                    return Ok(spaces);
                }
                _ => break,
            }
        }
        Ok(parent.map_or(0, |p| p.saturating_add(1)))
    }

    /// Moves past the lines that belong to the scalar and answers where they
    /// end: its content lines, and the empty lines between them.
    fn block_region(&mut self, indent: usize) -> usize {
        while !self.eof() {
            let line_start = self.pos;
            let mut taken = 0usize;
            while taken < indent && self.cur() == ' ' {
                self.bump();
                taken = taken.saturating_add(1);
            }
            if taken == indent && !self.eof() && self.cur() != '\n' {
                self.skip_to_line_end();
                self.bump();
                continue;
            }
            self.skip_spaces();
            if self.cur() == '\n' {
                self.bump();
                continue;
            }
            if !self.eof() {
                self.pos = line_start;
            }
            break;
        }
        self.pos = self.pos.min(self.chars.len());
        self.pos
    }

    /// The scalar's source lines: the region less the trailing empty lines the
    /// lexer drops (unless the scalar keeps them), split at each line break.
    fn block_lines(&self, start: usize, region_end: usize, chomp: char) -> Vec<Line> {
        let len = self.chars.len();
        let at = |i: isize| -> char {
            usize::try_from(i).ok().and_then(|i| self.chars.get(i)).copied().unwrap_or('\0')
        };
        let signed = |n: usize| isize::try_from(n).unwrap_or(isize::MAX);
        // The region ends at the end of a line, or at the end of a text that
        // has no final line break, which stands in for one.
        let ends_line = region_end.checked_sub(1).and_then(|i| self.chars.get(i)) == Some(&'\n');
        let mut last_break = signed(region_end).saturating_sub(isize::from(ends_line));
        let lexer_indent = self
            .chars
            .get(start..)
            .unwrap_or_default()
            .iter()
            .try_fold(0isize, |count, &c| match c {
                ' ' => Ok(count.saturating_add(1)),
                '\n' => Ok(0),
                _ => Err(count),
            })
            .unwrap_or_else(|count| count);
        if chomp != '+' {
            loop {
                let last = last_break.saturating_sub(1);
                let mut i = last;
                while at(i) == ' ' {
                    i = i.saturating_sub(1);
                }
                let before_start = at(i) == '\n' && i >= signed(start);
                if before_start && i.saturating_add(1).saturating_add(lexer_indent) > last {
                    last_break = i;
                } else {
                    break;
                }
            }
        }
        let end = usize::try_from(last_break.saturating_add(1)).unwrap_or(0).max(start).min(len);
        let source: String = self.chars.get(start..end).unwrap_or_default().iter().collect();
        if source.is_empty() {
            return Vec::new();
        }
        source
            .split('\n')
            .map(|segment| {
                let spaces = segment.chars().take_while(|&c| c == ' ').count();
                (spaces, segment.trim_start_matches(' ').to_string())
            })
            .collect()
    }
}

/// `resolveBlockScalar`: the scalar's text from its lines.
fn fold_block(lines: &[Line], parent: Indent, header: &Header, literal: bool) -> Parsed<String> {
    let keep = header.chomp == '+';
    let chomp_start =
        lines.iter().rposition(|l| !l.1.is_empty()).map_or(0, |p| p.saturating_add(1));
    if chomp_start == 0 {
        let breaks = lines.len().saturating_sub(1).max(1);
        return Ok(if keep && !lines.is_empty() { "\n".repeat(breaks) } else { String::new() });
    }
    let (trim, content_start) = block_trim(lines, chomp_start, parent, header.explicit)?;
    let hold_end = lines
        .iter()
        .rposition(|l| l.0 > trim)
        .filter(|&p| p >= chomp_start)
        .map_or(chomp_start, |p| p.saturating_add(1));
    let indent_of = |spaces: usize| " ".repeat(spaces.saturating_sub(trim));
    let mut value = String::new();
    for line in lines.iter().take(content_start) {
        value.push_str(&indent_of(line.0));
        value.push('\n');
    }
    let body = lines.get(content_start..hold_end).unwrap_or_default();
    value.push_str(&join_lines(body, trim, literal)?);
    match header.chomp {
        '-' => {}
        '+' => {
            for line in lines.iter().skip(hold_end) {
                value.push('\n');
                value.push_str(&indent_of(line.0));
            }
            if !value.ends_with('\n') {
                value.push('\n');
            }
        }
        _ => value.push('\n'),
    }
    Ok(value)
}

/// The indentation stripped from every line, and the first line with content.
fn block_trim(
    lines: &[Line],
    chomp_start: usize,
    parent: Indent,
    explicit: Option<usize>,
) -> Parsed<(usize, usize)> {
    let stated = explicit.unwrap_or(0);
    let mut trim = parent.unwrap_or(0).saturating_add(stated);
    for (index, (spaces, content)) in lines.iter().enumerate().take(chomp_start) {
        if content.is_empty() {
            continue;
        }
        if *spaces < trim {
            return syntax("a block scalar line indented less than its first");
        }
        if stated == 0 {
            trim = *spaces;
        }
        if trim == 0 && parent.is_some() {
            return syntax("a block scalar inside a collection at column 0");
        }
        return Ok((trim, index));
    }
    Ok((trim, 0))
}

/// The content lines joined: as written for a literal scalar, and folded
/// (with more-indented lines kept) for a folded one.
fn join_lines(body: &[Line], trim: usize, literal: bool) -> Parsed<String> {
    let indent_of = |spaces: usize| " ".repeat(spaces.saturating_sub(trim));
    let mut value = String::new();
    let mut separator = "";
    let mut previous_more = false;
    for (spaces, content) in body {
        if !content.is_empty() && *spaces < trim {
            return syntax("a block scalar line indented less than its first");
        }
        if literal {
            value.push_str(separator);
            value.push_str(&indent_of(*spaces));
            value.push_str(content);
            separator = "\n";
        } else if *spaces > trim || content.starts_with('\t') {
            if separator == " " {
                separator = "\n";
            } else if !previous_more && separator == "\n" {
                separator = "\n\n";
            }
            value.push_str(separator);
            value.push_str(&indent_of(*spaces));
            value.push_str(content);
            separator = "\n";
            previous_more = true;
        } else if content.is_empty() {
            if separator == "\n" {
                value.push('\n');
            } else {
                separator = "\n";
            }
        } else {
            value.push_str(separator);
            value.push_str(content);
            separator = " ";
            previous_more = false;
        }
    }
    Ok(value)
}
