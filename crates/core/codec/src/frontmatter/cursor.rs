//! The reader's position in the text and the questions it asks of it.
//!
//! The text is held as `char`s so that a column is a count of characters and
//! an index never lands inside a UTF-8 sequence. `'\0'` stands for the end:
//! the precheck refuses every raw NUL, so it cannot be mistaken for text.

use super::node::Node;
use super::value::Refusal;

pub(super) type Parsed<T> = Result<T, Refusal>;

/// The indent a node's parent sits at; `None` is the document, one column
/// before the first.
pub(super) type Indent = Option<usize>;

/// Whether a column is further right than the parent's indent.
pub(super) fn deeper(column: usize, parent: Indent) -> bool {
    parent.is_none_or(|p| column > p)
}

pub(super) fn syntax<T>(why: &'static str) -> Parsed<T> {
    Err(Refusal::Syntax(why))
}

pub(super) fn subset<T>(why: &'static str) -> Parsed<T> {
    Err(Refusal::Subset(why))
}

pub(super) const FLOW_INDICATORS: [char; 5] = [',', '[', ']', '{', '}'];

pub(super) struct Parser {
    pub(super) chars: Vec<char>,
    pub(super) pos: usize,
    /// Collections the parse currently sits inside.
    pub(super) depth: usize,
    /// Where each double-quoted scalar was written, quotes included: the one
    /// place a C1 control may appear.
    pub(super) double_quoted: Vec<(usize, usize)>,
    /// An escape spelled a lone UTF-16 surrogate, which no `String` holds.
    pub(super) lone_surrogate: bool,
    /// Flow collections the parse currently sits inside.
    pub(super) flow_depth: usize,
    /// The blanks before the node about to be read held a tab.
    pub(super) tab_before: bool,
    /// The node being read followed such blanks; a block collection must not.
    pub(super) tabbed: bool,
}

impl Parser {
    pub(super) fn new(text: &str) -> Parser {
        Parser {
            chars: text.chars().collect(),
            pos: 0,
            depth: 0,
            double_quoted: Vec::new(),
            lone_surrogate: false,
            flow_depth: 0,
            tab_before: false,
            tabbed: false,
        }
    }

    pub(super) fn ch(&self, ahead: usize) -> char {
        self.chars.get(self.pos.saturating_add(ahead)).copied().unwrap_or('\0')
    }

    pub(super) fn cur(&self) -> char {
        self.ch(0)
    }

    pub(super) fn eof(&self) -> bool {
        self.pos >= self.chars.len()
    }

    /// The character before the cursor, or `'\0'` at the start.
    pub(super) fn prev(&self) -> char {
        self.pos.checked_sub(1).and_then(|i| self.chars.get(i)).copied().unwrap_or('\0')
    }

    pub(super) fn bump(&mut self) {
        self.pos = self.pos.saturating_add(1);
    }

    pub(super) fn skip(&mut self, count: usize) {
        self.pos = self.pos.saturating_add(count);
    }

    /// Characters from the start of the line to the cursor.
    pub(super) fn col(&self) -> usize {
        self.chars
            .get(..self.pos)
            .map_or(0, |head| head.iter().rev().take_while(|&&c| c != '\n').count())
    }

    /// Whether the character `ahead` of the cursor is a space, tab, line end
    /// or the end of the text.
    pub(super) fn blank_at(&self, ahead: usize) -> bool {
        matches!(self.ch(ahead), ' ' | '\t' | '\n' | '\0')
    }

    pub(super) fn is_seq_indicator(&self) -> bool {
        self.cur() == '-' && self.blank_at(1)
    }

    /// A `:` that ends a key.
    pub(super) fn is_value_indicator(&self) -> bool {
        self.cur() == ':' && self.blank_at(1)
    }

    pub(super) fn skip_spaces(&mut self) {
        while self.cur() == ' ' {
            self.bump();
        }
    }

    pub(super) fn skip_inline_whitespace(&mut self) {
        while matches!(self.cur(), ' ' | '\t') {
            self.bump();
        }
    }

    /// Skips spaces and tabs, and answers whether there was a tab among them.
    pub(super) fn skip_blanks_noting_tab(&mut self) -> bool {
        let mut tab = false;
        while matches!(self.cur(), ' ' | '\t') {
            tab |= self.cur() == '\t';
            self.bump();
        }
        tab
    }

    pub(super) fn skip_to_line_end(&mut self) {
        while !self.eof() && self.cur() != '\n' {
            self.bump();
        }
    }

    /// Whether the rest of the line holds nothing but an optional comment.
    pub(super) fn at_line_end_or_comment(&self) -> bool {
        matches!(self.cur(), '\n' | '\0')
            || (self.cur() == '#' && matches!(self.prev(), ' ' | '\t'))
    }

    /// The text of `from..to`.
    pub(super) fn slice(&self, from: usize, to: usize) -> String {
        self.chars.get(from..to).unwrap_or_default().iter().collect()
    }

    /// UTF-16 code units in `from..to`, which is what `yaml` measures a key by.
    pub(super) fn units(&self, from: usize, to: usize) -> usize {
        self.chars.get(from..to).unwrap_or_default().iter().map(|c| c.len_utf16()).sum()
    }

    /// At a line start: skips blank and comment lines, stopping at content or
    /// the end.
    pub(super) fn next_line_content(&mut self) {
        loop {
            self.skip_spaces();
            match self.cur() {
                '\n' => self.bump(),
                '#' => self.skip_to_line_end(),
                _ => return,
            }
        }
    }

    /// After a node's last token: an optional comment, then the line break.
    pub(super) fn end_line(&mut self) -> Parsed<()> {
        self.skip_inline_whitespace();
        if self.cur() == '#' {
            if !matches!(self.prev(), ' ' | '\t' | '\n') {
                return syntax("a comment needs a space before it");
            }
            self.skip_to_line_end();
        }
        if self.eof() {
            return Ok(());
        }
        if self.cur() != '\n' {
            return syntax("unexpected token after a node");
        }
        self.bump();
        self.next_line_content();
        Ok(())
    }

    /// Enters a collection. A document nested past [`super::value::MAX_DEPTH`]
    /// is refused by the visit that follows the parse, in the order the
    /// TypeScript names refusals; the parse itself stops recursing only at
    /// [`super::value::MAX_PARSE_DEPTH`], so the stack stays bounded.
    pub(super) fn enter(&mut self) -> Parsed<()> {
        self.depth = self.depth.saturating_add(1);
        if self.depth > super::value::MAX_PARSE_DEPTH { Err(Refusal::Depth) } else { Ok(()) }
    }

    pub(super) fn leave(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    /// An alias such as `*name`, which the visit refuses; it is read so that
    /// anything malformed beside it is named as malformed first.
    pub(super) fn alias(&mut self) -> Parsed<Node> {
        self.bump();
        let start = self.pos;
        while !self.blank_at(0) && !FLOW_INDICATORS.contains(&self.cur()) {
            self.bump();
        }
        if self.pos == start {
            return syntax("an alias without a name");
        }
        Ok(Node::Alias)
    }
}
