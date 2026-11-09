//! Plain and quoted scalars, as `yaml` 2.9 reads them.

use super::cursor::{FLOW_INDICATORS, Indent, Parsed, Parser, deeper, syntax};
use super::node::{Node, Style};

/// What ended a line of a plain scalar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stop {
    /// A `:` that ends a key.
    Colon,
    /// A comment: it ends the scalar, which no further line continues.
    Comment,
    /// The end of the line.
    Eol,
    /// A flow indicator inside a flow collection.
    FlowIndicator,
}

/// Characters a plain scalar cannot start with.
const PLAIN_FORBIDDEN_START: [char; 16] =
    [',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`'];

impl Parser {
    /// One line of a plain scalar. `continuation` lines are not held to the
    /// first-character rules.
    pub(super) fn plain_line(&mut self, flow: bool, continuation: bool) -> Parsed<(String, Stop)> {
        if !continuation && self.starts_badly(flow) {
            return syntax("a plain scalar cannot start here");
        }
        let mut text = String::new();
        loop {
            let ch = self.cur();
            if ch == '\n' || self.eof() {
                return Ok((text, Stop::Eol));
            }
            if ch == ':' && (self.blank_at(1) || (flow && FLOW_INDICATORS.contains(&self.ch(1)))) {
                return Ok((trim_blanks(&text), Stop::Colon));
            }
            if flow && FLOW_INDICATORS.contains(&ch) {
                return Ok((trim_blanks(&text), Stop::FlowIndicator));
            }
            if matches!(ch, ' ' | '\t') {
                if let Some(stop) = self.blanks_into(&mut text) {
                    return Ok((text, stop));
                }
                continue;
            }
            text.push(ch);
            self.bump();
        }
    }

    fn starts_badly(&self, flow: bool) -> bool {
        let first = self.cur();
        if PLAIN_FORBIDDEN_START.contains(&first) {
            return true;
        }
        matches!(first, '-' | '?' | ':')
            && (self.blank_at(1) || (flow && FLOW_INDICATORS.contains(&self.ch(1))))
    }

    /// Moves a run of spaces and tabs into `text` when text follows it, and
    /// otherwise leaves the cursor after it and says what ended the line.
    fn blanks_into(&mut self, text: &mut String) -> Option<Stop> {
        let mut end = self.pos;
        while matches!(self.chars.get(end), Some(' ' | '\t')) {
            end = end.saturating_add(1);
        }
        match self.chars.get(end) {
            None | Some('\n' | '#') => {
                let comment = self.chars.get(end) == Some(&'#');
                self.pos = end;
                Some(if comment { Stop::Comment } else { Stop::Eol })
            }
            Some(_) => {
                text.push_str(&self.slice(self.pos, end));
                self.pos = end;
                None
            }
        }
    }

    /// A plain scalar, over several lines if need be, whose parent sits at
    /// `parent`.
    pub(super) fn plain_scalar(&mut self, parent: Indent, flow: bool) -> Parsed<Node> {
        let (mut text, stop) = self.plain_line(flow, false)?;
        if stop == Stop::Colon && !flow {
            return syntax("a nested implicit mapping");
        }
        if stop == Stop::Eol {
            self.continuation_lines(&mut text, parent, flow)?;
        }
        Ok(Node::scalar(text, Style::Plain))
    }

    /// Appends the continuation lines of a plain scalar, folded: one space
    /// between lines, or one newline for each empty line between them.
    fn continuation_lines(&mut self, text: &mut String, parent: Indent, flow: bool) -> Parsed<()> {
        while !self.eof() {
            let save = self.pos;
            let Some((column, empties)) = self.next_continuation() else {
                self.pos = save;
                return Ok(());
            };
            if self.ends_plain_scalar(flow) {
                self.pos = save;
                return Ok(());
            }
            if !deeper(column, parent) {
                if flow {
                    return syntax("a flow line indented no further than its parent");
                }
                self.pos = save;
                return Ok(());
            }
            let (line, stop) = self.plain_line(flow, true)?;
            if stop == Stop::Colon && !flow {
                return syntax("a multi-line implicit key");
            }
            text.push_str(&"\n".repeat(empties));
            if empties == 0 {
                text.push(' ');
            }
            text.push_str(&line);
            if stop != Stop::Eol {
                return Ok(());
            }
        }
        Ok(())
    }

    /// From a line break: skips empty lines and the next line's indentation,
    /// answering that line's column and how many empty lines preceded it, or
    /// `None` at the end of the text.
    fn next_continuation(&mut self) -> Option<(usize, usize)> {
        self.bump();
        let mut empties = 0usize;
        loop {
            let line_start = self.pos;
            self.skip_spaces();
            if self.cur() == '\n' {
                empties = empties.saturating_add(1);
                self.bump();
                continue;
            }
            if self.eof() {
                return None;
            }
            return Some((self.pos.saturating_sub(line_start), empties));
        }
    }

    fn ends_plain_scalar(&self, flow: bool) -> bool {
        let ch = self.cur();
        ch == '#'
            || (ch == ':' && (self.blank_at(1) || (flow && FLOW_INDICATORS.contains(&self.ch(1)))))
            || (flow && FLOW_INDICATORS.contains(&ch))
    }

    /// A quoted scalar, and whether it spanned lines. `indented` holds a
    /// continuation line to more than `parent`'s column; a key is read
    /// without it, since a key spanning lines is refused whole.
    ///
    /// `yaml` 2.9 takes a quoted scalar to end where a closing quote is, or
    /// where the text ends, or before a continuation line indented too little
    /// when a closing quote exists further on, and then accepts it unless its
    /// last character is not the quote. So a scalar left open is read as
    /// closed by that last quote, and refused otherwise.
    pub(super) fn quoted(&mut self, parent: Indent, indented: bool) -> Parsed<(Node, bool)> {
        let quote = self.cur();
        let start = self.pos;
        self.bump();
        let mut scan = Scan::default();
        loop {
            if self.eof() {
                self.close_open_scalar(start, quote, self.pos)?;
                break;
            }
            let ch = self.cur();
            if ch == quote && !(quote == '\'' && self.ch(1) == '\'') {
                self.bump();
                if let Some(cut) = scan.cut {
                    self.close_open_scalar(start, quote, cut.newline)?;
                    scan.out.truncate(cut.out_len);
                    self.pos = cut.newline;
                } else {
                    scan.flush();
                }
                break;
            }
            self.quoted_step(quote, parent, indented, &mut scan)?;
        }
        if quote == '"' {
            self.double_quoted.push((start, self.pos));
        }
        Ok((Node::scalar(self.decode(&scan.out), Style::Quoted), scan.multi_line))
    }

    /// Accepts a scalar that ends at `end` without a closing quote of its own
    /// when the character before `end` is the quote, and refuses it otherwise.
    fn close_open_scalar(&self, start: usize, quote: char, end: usize) -> Parsed<()> {
        let last = end.checked_sub(1).filter(|&last| last > start);
        if last.and_then(|i| self.chars.get(i)) == Some(&quote) {
            Ok(())
        } else {
            syntax("a quoted scalar without a closing quote")
        }
    }

    /// One character (or escape, or line break) of a quoted scalar's content.
    fn quoted_step(
        &mut self,
        quote: char,
        parent: Indent,
        indented: bool,
        scan: &mut Scan,
    ) -> Parsed<()> {
        let ch = self.cur();
        match ch {
            '\'' if quote == '\'' => {
                scan.flush();
                scan.out.push(u16::from(b'\''));
                self.skip(2);
            }
            '\\' if quote == '"' => {
                scan.flush();
                self.escape(scan, parent, indented)?;
            }
            ' ' | '\t' => {
                scan.pending.push(ch);
                self.bump();
            }
            '\n' => {
                scan.pending.clear();
                let newline = self.pos;
                self.bump();
                scan.multi_line = true;
                self.fold_into(scan, newline, parent, indented, false);
            }
            _ => {
                scan.flush();
                scan.out.extend(ch.encode_utf16(&mut [0; 2]).iter());
                self.bump();
            }
        }
        Ok(())
    }

    /// Reads the lines after a break at `newline`: counts the empty lines,
    /// skips the next line's indentation and remembers the first line indented
    /// too little. An escaped break joins the lines without a space.
    fn fold_into(
        &mut self,
        scan: &mut Scan,
        newline: usize,
        parent: Indent,
        indented: bool,
        escaped: bool,
    ) {
        let mut empties = 0usize;
        loop {
            let line_start = self.pos;
            self.skip_spaces();
            if self.cur() == '\n' {
                empties = empties.saturating_add(1);
                self.bump();
                continue;
            }
            if indented
                && !self.eof()
                && !deeper(self.pos.saturating_sub(line_start), parent)
                && scan.cut.is_none()
            {
                scan.cut = Some(Cut { newline, out_len: scan.out.len() });
            }
            break;
        }
        let unit = u16::from(if empties == 0 && !escaped { b' ' } else { b'\n' });
        let count = if empties == 0 && !escaped { 1 } else { empties };
        scan.out.extend(std::iter::repeat_n(unit, count));
    }

    /// The scalar's text; a lone surrogate an escape spelled is remembered,
    /// since the subset has no reading for one.
    fn decode(&mut self, units: &[u16]) -> String {
        String::from_utf16(units).unwrap_or_else(|_| {
            self.lone_surrogate = true;
            String::from_utf16_lossy(units)
        })
    }

    /// One backslash escape of a double-quoted scalar, cursor on the
    /// backslash.
    fn escape(&mut self, scan: &mut Scan, parent: Indent, indented: bool) -> Parsed<()> {
        let code = self.ch(1);
        self.skip(2);
        if code == '\n' {
            scan.multi_line = true;
            self.fold_into(scan, self.pos.saturating_sub(1), parent, indented, true);
            return Ok(());
        }
        if let Some(simple) = simple_escape(code) {
            scan.out.extend(simple.encode_utf16(&mut [0; 2]).iter());
            return Ok(());
        }
        let digits = match code {
            'x' => 2,
            'u' => 4,
            'U' => 8,
            _ => return syntax("an unknown escape in a double-quoted scalar"),
        };
        let mut value = 0u32;
        for offset in 0..digits {
            let Some(digit) = self.ch(offset).to_digit(16) else {
                return syntax("a malformed escape in a double-quoted scalar");
            };
            value = value.saturating_mul(16).saturating_add(digit);
        }
        self.skip(digits);
        push_code_point(&mut scan.out, value)
    }
}

/// Where a quoted scalar was left open by a continuation line indented too little.
#[derive(Clone, Copy)]
struct Cut {
    newline: usize,
    out_len: usize,
}

/// What reading a quoted scalar has gathered so far.
#[derive(Default)]
struct Scan {
    out: Vec<u16>,
    /// Blanks not yet known to be content: a break after them drops them.
    pending: String,
    multi_line: bool,
    cut: Option<Cut>,
}

impl Scan {
    /// Blanks written inside quotes are content once something follows them.
    fn flush(&mut self) {
        self.out.extend(self.pending.encode_utf16());
        self.pending.clear();
    }
}

/// Pushes a code point an escape named; a surrogate is pushed as the lone unit
/// it is, which pairs with a neighbour or is refused when decoded.
fn push_code_point(out: &mut Vec<u16>, value: u32) -> Parsed<()> {
    if let Some(c) = char::from_u32(value) {
        out.extend(c.encode_utf16(&mut [0; 2]).iter());
    } else if let Ok(unit) = u16::try_from(value) {
        out.push(unit);
    } else {
        return syntax("an escape past U+10FFFF");
    }
    Ok(())
}

fn simple_escape(code: char) -> Option<char> {
    Some(match code {
        '0' => '\0',
        'a' => '\u{7}',
        'b' => '\u{8}',
        't' | '\t' => '\t',
        'n' => '\n',
        'v' => '\u{b}',
        'f' => '\u{c}',
        'r' => '\r',
        'e' => '\u{1b}',
        ' ' => ' ',
        '"' => '"',
        '/' => '/',
        '\\' => '\\',
        'N' => '\u{85}',
        '_' => '\u{a0}',
        'L' => '\u{2028}',
        'P' => '\u{2029}',
        _ => return None,
    })
}

/// Trailing blanks are not part of a plain scalar that a `:` or a flow
/// indicator ends.
fn trim_blanks(text: &str) -> String {
    text.trim_end_matches([' ', '\t']).to_string()
}
