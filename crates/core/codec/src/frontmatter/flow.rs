//! Flow collections: `[a, b]` and `{a: 1}`.

use super::cursor::{FLOW_INDICATORS, Indent, Parsed, Parser, deeper, syntax};
use super::node::{Node, Outside, Pair, Props};

impl Parser {
    /// Blanks, comments and line breaks between the tokens of a flow
    /// collection; a continuation line must sit deeper than `parent`.
    fn flow_whitespace(&mut self, parent: Indent) -> Parsed<()> {
        loop {
            match self.cur() {
                ' ' | '\t' => self.bump(),
                '#' => {
                    if !matches!(self.prev(), ' ' | '\t' | '\n') {
                        return syntax("a comment needs a space before it");
                    }
                    self.skip_to_line_end();
                }
                '\n' => {
                    self.bump();
                    let line_start = self.pos;
                    self.skip_spaces();
                    let column = self.pos.saturating_sub(line_start);
                    if !matches!(self.cur(), '\n' | '#' | '\0')
                        && !self.flow_indent_ok(column, parent)
                    {
                        return syntax("a flow line indented no further than its parent");
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    /// A flow line must sit deeper than its parent, except that the closing
    /// `]` or `}` of the outermost collection may stand in the parent's own
    /// column.
    fn flow_indent_ok(&self, column: usize, parent: Indent) -> bool {
        if matches!(self.cur(), ']' | '}') && self.flow_depth <= 1 {
            parent.is_none_or(|p| column >= p)
        } else {
            deeper(column, parent)
        }
    }

    pub(super) fn flow_node(&mut self, parent: Indent) -> Parsed<Node> {
        let props = self.props()?;
        if props.any() && matches!(self.cur(), ',' | ']' | '}') {
            return Ok(Node::null().with_props(props));
        }
        let node = match self.cur() {
            '[' => self.flow_seq(parent)?,
            '{' => self.flow_map(parent)?,
            '"' | '\'' => self.quoted(parent, true)?.0,
            '*' => self.alias()?,
            _ => self.plain_scalar(parent, true)?,
        };
        Ok(node.with_props(props))
    }

    fn flow_seq(&mut self, parent: Indent) -> Parsed<Node> {
        self.enter()?;
        self.flow_depth = self.flow_depth.saturating_add(1);
        self.bump();
        let mut items = Vec::new();
        let mut outside = None;
        loop {
            self.flow_whitespace(parent)?;
            if self.eof() {
                return syntax("an unterminated flow sequence");
            }
            if self.cur() == ']' {
                self.bump();
                break;
            }
            let (item, pair) = self.flow_seq_item(parent)?;
            items.push(item);
            outside = outside.or(pair);
            match self.cur() {
                ',' => self.bump(),
                ']' => {
                    self.bump();
                    break;
                }
                _ => return syntax("an unexpected token in a flow sequence"),
            }
        }
        self.leave();
        self.flow_depth = self.flow_depth.saturating_sub(1);
        Ok(Node::Seq { items, props: Props::default(), outside })
    }

    /// An item of a flow sequence. A pair (`a: 1`, `? a`) is not in the
    /// subset; it is read past, its key standing for the item.
    fn flow_seq_item(&mut self, parent: Indent) -> Parsed<(Node, Outside)> {
        const PAIR: Outside = Some("a pair inside a flow sequence");
        let mut outside = None;
        let explicit = self.at_flow_explicit_key();
        if explicit {
            outside = PAIR;
            self.bump();
            self.flow_whitespace(parent)?;
        }
        let start = self.pos;
        let item = if explicit && matches!(self.cur(), ',' | ']') {
            Node::null()
        } else {
            self.flow_node(parent)?
        };
        self.flow_whitespace(parent)?;
        if self.cur() == ':' {
            if self.slice(start, self.pos).contains('\n') {
                return syntax("a multi-line key in a flow sequence");
            }
            outside = PAIR;
            self.bump();
            self.flow_whitespace(parent)?;
            if !matches!(self.cur(), ',' | ']') {
                self.flow_node(parent)?;
            }
        }
        Ok((item, outside))
    }

    /// A `:` that stands alone: a key before it is empty.
    fn is_flow_value_indicator(&self) -> bool {
        self.cur() == ':' && (self.blank_at(1) || FLOW_INDICATORS.contains(&self.ch(1)))
    }

    /// A `?` that opens an explicit key inside a flow collection.
    fn at_flow_explicit_key(&self) -> bool {
        self.cur() == '?' && (self.blank_at(1) || FLOW_INDICATORS.contains(&self.ch(1)))
    }

    fn flow_map(&mut self, parent: Indent) -> Parsed<Node> {
        self.enter()?;
        self.flow_depth = self.flow_depth.saturating_add(1);
        self.bump();
        let mut pairs = Vec::new();
        loop {
            self.flow_whitespace(parent)?;
            if self.eof() {
                return syntax("an unterminated flow mapping");
            }
            if self.cur() == '}' {
                self.bump();
                break;
            }
            pairs.push(self.flow_pair(parent)?);
            self.flow_whitespace(parent)?;
            match self.cur() {
                ',' => self.bump(),
                '}' => {
                    self.bump();
                    break;
                }
                _ => return syntax("an unexpected token in a flow mapping"),
            }
        }
        self.leave();
        self.flow_depth = self.flow_depth.saturating_sub(1);
        Ok(Node::Map { pairs, props: Props::default() })
    }

    /// One `key: value` of a flow mapping; the value may be missing.
    fn flow_pair(&mut self, parent: Indent) -> Parsed<Pair> {
        let mut outside = None;
        if self.at_flow_explicit_key() {
            outside = Some("an explicit key in a flow collection");
            self.bump();
            self.flow_whitespace(parent)?;
        }
        // A key that is quoted or a collection may be followed by `:` directly.
        let json_like = matches!(self.cur(), '"' | '\'' | '[' | '{');
        let key = if self.is_flow_value_indicator() {
            outside = outside.or(Some("an empty key in a flow mapping"));
            Node::null()
        } else {
            self.flow_node(parent)?
        };
        self.flow_whitespace(parent)?;
        let has_value = self.cur() == ':'
            && (json_like || self.blank_at(1) || FLOW_INDICATORS.contains(&self.ch(1)));
        if !has_value {
            return Ok(Pair { key, value: Node::null(), outside });
        }
        self.bump();
        self.flow_whitespace(parent)?;
        let value =
            if matches!(self.cur(), ',' | '}') { Node::null() } else { self.flow_node(parent)? };
        Ok(Pair { key, value, outside })
    }
}
