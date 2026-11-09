//! Block structure: nodes, sequences, mappings and their keys.

use super::cursor::{Indent, Parsed, Parser, deeper, subset, syntax};
use super::node::{Node, Outside, Pair, Props, Style};

/// The longest implicit key, in UTF-16 units, `yaml` reads; and the length
/// past which `yaml.stringify` writes an explicit `? key` instead.
const MAX_IMPLICIT_KEY_UNITS: usize = 1024;

impl Props {
    pub(super) fn any(self) -> bool {
        self.anchored || self.tagged
    }
}

impl Parser {
    /// The whole document: one block node and nothing after it.
    pub(super) fn document(&mut self) -> Parsed<Option<Node>> {
        self.next_line_content();
        if self.eof() {
            return Ok(None);
        }
        let node = self.block_node(None, true)?;
        if self.eof() { Ok(Some(node)) } else { syntax("content after the root node") }
    }

    /// Anchors and tags written before a node. Both are refused later; they
    /// are read so that anything malformed beside them is named first.
    pub(super) fn props(&mut self) -> Parsed<Props> {
        let mut props = Props::default();
        loop {
            let marker = self.cur();
            match marker {
                '&' => props.anchored = true,
                '!' => props.tagged = true,
                _ => return Ok(props),
            }
            self.bump();
            let start = self.pos;
            if props.tagged && self.cur() == '<' {
                self.verbatim_tag()?;
            }
            while !self.blank_at(0) && !super::cursor::FLOW_INDICATORS.contains(&self.cur()) {
                self.bump();
            }
            if self.pos == start && marker == '&' {
                return syntax("an anchor without a name");
            }
            self.skip_inline_whitespace();
        }
    }

    /// `<...>` after a `!`, which may hold the flow indicators a tag cannot.
    fn verbatim_tag(&mut self) -> Parsed<()> {
        while !self.blank_at(0) && self.cur() != '>' {
            self.bump();
        }
        if self.cur() != '>' {
            return syntax("a verbatim tag without its '>'");
        }
        self.bump();
        Ok(())
    }

    /// A node starting at the current content character, whose parent sits at
    /// `parent`. `may_be_collection` is false for a value on its key's line,
    /// where `a: b: c` is an error.
    pub(super) fn block_node(&mut self, parent: Indent, may_be_collection: bool) -> Parsed<Node> {
        let start = self.pos;
        self.tabbed = std::mem::take(&mut self.tab_before);
        let props = self.props()?;
        if props.any() && self.at_line_end_or_comment() {
            return self.properties_alone(parent, props);
        }
        let column = self.col();
        if props.any() && self.cur() == '*' {
            return syntax("an alias with properties");
        }
        match self.cur() {
            '-' if self.blank_at(1) => self.compact_sequence(column, may_be_collection, props),
            '?' if self.blank_at(1) => {
                if props.any() {
                    return subset("a property on an explicit key");
                }
                if !may_be_collection {
                    return syntax("an explicit key where a key is expected");
                }
                self.block_map(column)
            }
            '[' | '{' => self.flow_value(parent, props),
            '"' | '\'' => self.quoted_value(parent, (start, column), may_be_collection, props),
            '|' | '>' => Ok(self.block_scalar(parent)?.with_props(props)),
            '*' => self.alias_value(column, may_be_collection),
            _ => self.plain_value(parent, (start, column), may_be_collection, props),
        }
    }

    /// Properties on a line of their own: the node is on the next line, or
    /// there is none and the properties stand on an empty one. The next line
    /// can hold properties alone again, so each such line counts against the
    /// parse depth: nothing else bounds this recursion.
    fn properties_alone(&mut self, parent: Indent, props: Props) -> Parsed<Node> {
        self.end_line()?;
        if self.eof() || !deeper(self.col(), parent) {
            return Ok(Node::null().with_props(props));
        }
        self.enter()?;
        let node = self.block_node(parent, true);
        self.leave();
        Ok(node?.with_props(props))
    }

    fn compact_sequence(&mut self, column: usize, allowed: bool, props: Props) -> Parsed<Node> {
        if !allowed {
            return syntax("a sequence entry where a key is expected");
        }
        if props.any() {
            return subset("a property on a compact sequence");
        }
        self.block_seq(column)
    }

    fn flow_value(&mut self, parent: Indent, props: Props) -> Parsed<Node> {
        let flow = self.flow_node(parent)?;
        self.skip_inline_whitespace();
        if self.is_value_indicator() {
            return subset("a collection key");
        }
        self.end_line()?;
        Ok(flow.with_props(props))
    }

    /// A quoted scalar, which is a key when a `:` follows it.
    fn quoted_value(
        &mut self,
        parent: Indent,
        (start, column): (usize, usize),
        allowed: bool,
        props: Props,
    ) -> Parsed<Node> {
        let (save, ranges) = (self.pos, self.double_quoted.len());
        let (quoted, multi_line) = self.quoted(parent, true)?;
        self.skip_inline_whitespace();
        if !self.is_value_indicator() {
            self.end_line()?;
            return Ok(quoted.with_props(props));
        }
        if !allowed {
            return syntax("a nested implicit mapping");
        }
        if multi_line {
            return syntax("a multi-line implicit key");
        }
        self.pos = if props.any() { start } else { save };
        self.double_quoted.truncate(ranges);
        self.block_map(column)
    }

    fn alias_value(&mut self, column: usize, allowed: bool) -> Parsed<Node> {
        let save = self.pos;
        let alias = self.alias()?;
        self.skip_inline_whitespace();
        if self.is_value_indicator() {
            if !allowed {
                return syntax("a nested implicit mapping");
            }
            self.pos = save;
            return self.block_map(column);
        }
        self.end_line()?;
        Ok(alias)
    }

    /// A plain scalar, which is a key when a `:` ends its first line.
    fn plain_value(
        &mut self,
        parent: Indent,
        (start, column): (usize, usize),
        allowed: bool,
        props: Props,
    ) -> Parsed<Node> {
        if self.is_value_indicator() {
            if !allowed {
                return syntax("a nested implicit mapping");
            }
            return self.block_map(column);
        }
        let save = self.pos;
        let (_, stop) = self.plain_line(false, false)?;
        if stop == super::scalars::Stop::Colon {
            if !allowed {
                return syntax("a nested implicit mapping");
            }
            self.pos = if props.any() { start } else { save };
            return self.block_map(column);
        }
        self.pos = save;
        let scalar = self.plain_scalar(parent, false)?;
        self.end_line()?;
        Ok(scalar.with_props(props))
    }

    /// `? key` on its own line, then `:` at the mapping's column: the only
    /// explicit key `yaml.stringify` writes, for a key past 1024 units. Any
    /// other is outside the subset, and answered with what marks it so.
    fn explicit_key(&mut self, column: usize) -> Parsed<(Node, Outside)> {
        self.bump();
        if !matches!(self.cur(), ' ' | '\n' | '\0') {
            return subset("an explicit key");
        }
        self.skip_inline_whitespace();
        if self.at_line_end_or_comment() {
            self.end_line()?;
            let key = if self.eof() || self.col() <= column {
                Node::null()
            } else {
                self.block_node(Some(column), true)?
            };
            return Ok((key, Some("an explicit key without a key on its line")));
        }
        let (key, units) = match self.cur() {
            '"' | '\'' => {
                let start = self.pos;
                let (quoted, multi_line) = self.quoted(None, false)?;
                if multi_line {
                    return subset("a multi-line explicit key");
                }
                (quoted, self.units(start, self.pos))
            }
            '[' | '{' | '&' | '!' | '*' | '|' | '>' | '#' => {
                return subset("an explicit key");
            }
            // Followed by a non-blank, `?` and `-` start a plain scalar (YAML
            // 1.2 rule 126), which the writer emits for a long key like any other.
            '?' | '-' if self.blank_at(1) => return subset("an explicit key"),
            _ => {
                let (text, stop) = self.plain_line(false, false)?;
                if stop == super::scalars::Stop::Colon {
                    return subset("an explicit key");
                }
                let units = text.encode_utf16().count();
                (Node::scalar(text, Style::Plain), units)
            }
        };
        self.end_line()?;
        let outside = (units <= MAX_IMPLICIT_KEY_UNITS)
            .then_some("an explicit key written in 1024 units or fewer");
        Ok((key, outside))
    }

    fn block_key(&mut self, column: usize) -> Parsed<(Node, Outside)> {
        if self.cur() == '?' && self.blank_at(1) {
            return self.explicit_key(column);
        }
        let mut outside = None;
        let props = self.props()?;
        let start = self.pos;
        let key = match self.cur() {
            ':' if self.blank_at(1) => {
                outside = Some("an empty implicit key");
                Node::null()
            }
            '[' | '{' => {
                let collection = self.flow_node(Some(column))?;
                self.skip_inline_whitespace();
                collection
            }
            '*' => {
                let alias = self.alias()?;
                self.skip_inline_whitespace();
                alias
            }
            '"' | '\'' => {
                let (quoted, multi_line) = self.quoted(None, false)?;
                if multi_line {
                    return syntax("a multi-line implicit key");
                }
                self.skip_inline_whitespace();
                quoted
            }
            _ => {
                let (text, stop) = self.plain_line(false, false)?;
                if stop != super::scalars::Stop::Colon {
                    self.colon_on_next_line(column)?;
                }
                Node::scalar(text, Style::Plain)
            }
        };
        if !self.is_value_indicator() {
            return syntax("a key without ':'");
        }
        if self.units(start, self.pos) > MAX_IMPLICIT_KEY_UNITS {
            return syntax("an implicit key over 1024 characters");
        }
        self.bump();
        Ok((key.with_props(props), outside))
    }

    /// `yaml` reads a plain key whose `:` stands alone on a later line, indented
    /// further than the key; the cursor is left on that `:`.
    fn colon_on_next_line(&mut self, column: usize) -> Parsed<()> {
        self.end_line()?;
        if self.col() <= column || !self.is_value_indicator() {
            return syntax("an implicit key without ':'");
        }
        Ok(())
    }

    fn block_map(&mut self, column: usize) -> Parsed<Node> {
        if self.tabbed {
            return syntax("a tab as indentation");
        }
        self.enter()?;
        let mut pairs = Vec::new();
        loop {
            let explicit = self.cur() == '?' && self.blank_at(1);
            let (key, outside) = self.block_key(column)?;
            let value = if explicit {
                self.explicit_value(column)?
            } else {
                self.map_value(column, false)?
            };
            pairs.push(Pair { key, value, outside });
            if self.eof() || self.col() < column {
                break;
            }
            if self.col() > column {
                return self.misindented();
            }
            if self.is_seq_indicator() {
                return syntax("a sequence entry after a mapping key");
            }
        }
        self.leave();
        Ok(Node::Map { pairs, props: Props::default() })
    }

    /// The `:` line of an explicit key, at the mapping's column; without one
    /// the key has no value.
    fn explicit_value(&mut self, column: usize) -> Parsed<Node> {
        if self.col() < column || !self.is_value_indicator() {
            return Ok(Node::null());
        }
        self.bump();
        self.map_value(column, true)
    }

    /// What follows a key's `:`.
    fn map_value(&mut self, column: usize, compact: bool) -> Parsed<Node> {
        self.skip_inline_whitespace();
        if !self.at_line_end_or_comment() {
            // After an explicit key's `:` a compact collection may follow.
            return self.block_node(Some(column), compact);
        }
        self.end_line()?;
        if self.eof() {
            return Ok(Node::null());
        }
        if self.col() > column {
            return self.block_node(Some(column), true);
        }
        if self.col() == column && self.is_seq_indicator() {
            return self.block_seq(column);
        }
        Ok(Node::null())
    }

    fn misindented<T>(&self) -> Parsed<T> {
        if self.is_value_indicator() {
            return subset("an empty implicit key");
        }
        syntax("a line indented past its siblings")
    }

    fn block_seq(&mut self, column: usize) -> Parsed<Node> {
        if self.tabbed {
            return syntax("a tab as indentation");
        }
        self.enter()?;
        let mut items = Vec::new();
        loop {
            self.bump();
            self.tab_before = self.skip_blanks_noting_tab();
            let item = if self.at_line_end_or_comment() {
                self.end_line()?;
                if self.eof() || self.col() <= column {
                    Node::null()
                } else {
                    self.block_node(Some(column), true)?
                }
            } else {
                self.block_node(Some(column), true)?
            };
            items.push(item);
            if self.eof() || self.col() < column {
                break;
            }
            if self.col() > column {
                return self.misindented();
            }
            if !self.is_seq_indicator() {
                break;
            }
        }
        self.leave();
        Ok(Node::Seq { items, props: Props::default(), outside: None })
    }
}
