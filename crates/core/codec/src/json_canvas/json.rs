//! JSON text as `JSON.parse` reads it, into the value tree the frontmatter
//! reader also produces.
//!
//! What the host does that a grammar does not say: a repeated key keeps the
//! position of its first holder and takes the value of its last, a key named
//! `__proto__` is an ordinary key, and an object enumerates integer-like keys
//! first. Two things a Rust `String` cannot hold decline instead of being
//! read: a lone UTF-16 surrogate written as an escape, and nesting past
//! [`MAX_DEPTH`].

use std::collections::BTreeMap;
use whiteboard_model::{Map, Value, enumeration_order};

/// The deepest nesting read. `JSON.parse` has no limit of its own; a parser
/// that recurses needs one.
pub const MAX_DEPTH: usize = 64;

/// Why a text was not read as JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refusal {
    /// Not JSON: `JSON.parse` throws.
    Syntax,
    /// A string holds a lone surrogate, which `JSON.parse` keeps and Rust cannot.
    LoneSurrogate,
    /// Nesting past [`MAX_DEPTH`].
    TooDeep,
}

/// Reads `text` as `JSON.parse` does, with object keys in enumeration order.
pub(super) fn parse(text: &str) -> Result<Value, Refusal> {
    let mut reader = Reader { text, at: 0 };
    reader.skip_white();
    let value = reader.value(0)?;
    reader.skip_white();
    if reader.peek().is_some() {
        return Err(Refusal::Syntax);
    }
    Ok(enumeration_order(value))
}

struct Reader<'a> {
    text: &'a str,
    at: usize,
}

/// An object under construction: entries in first-seen order, indexed by key
/// so that a repeated key finds its first holder without a scan.
struct Members {
    entries: Map,
    index: BTreeMap<String, usize>,
}

impl Members {
    fn new() -> Self {
        Self { entries: Vec::new(), index: BTreeMap::new() }
    }

    fn insert(&mut self, key: String, value: Value) {
        if let Some(&at) = self.index.get(&key) {
            if let Some(entry) = self.entries.get_mut(at) {
                entry.1 = value;
            }
            return;
        }
        self.index.insert(key.clone(), self.entries.len());
        self.entries.push((key, value));
    }
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn bump(&mut self) {
        self.at = self.at.saturating_add(1);
    }

    fn skip_white(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.bump();
        }
    }

    fn eat(&mut self, byte: u8) -> Result<(), Refusal> {
        if self.peek() == Some(byte) {
            self.bump();
            Ok(())
        } else {
            Err(Refusal::Syntax)
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, Refusal> {
        for byte in word.bytes() {
            self.eat(byte)?;
        }
        Ok(value)
    }

    fn value(&mut self, depth: usize) -> Result<Value, Refusal> {
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Value::String),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(Refusal::Syntax),
        }
    }

    fn enter(depth: usize) -> Result<usize, Refusal> {
        if depth >= MAX_DEPTH { Err(Refusal::TooDeep) } else { Ok(depth.saturating_add(1)) }
    }

    fn array(&mut self, depth: usize) -> Result<Value, Refusal> {
        let inner = Self::enter(depth)?;
        self.bump();
        let mut items = Vec::new();
        self.skip_white();
        if self.peek() == Some(b']') {
            self.bump();
            return Ok(Value::Seq(items));
        }
        loop {
            self.skip_white();
            items.push(self.value(inner)?);
            self.skip_white();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b']') => {
                    self.bump();
                    return Ok(Value::Seq(items));
                }
                _ => return Err(Refusal::Syntax),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, Refusal> {
        let inner = Self::enter(depth)?;
        self.bump();
        let mut members = Members::new();
        self.skip_white();
        if self.peek() == Some(b'}') {
            self.bump();
            return Ok(Value::Map(members.entries));
        }
        loop {
            self.skip_white();
            if self.peek() != Some(b'"') {
                return Err(Refusal::Syntax);
            }
            let key = self.string()?;
            self.skip_white();
            self.eat(b':')?;
            self.skip_white();
            members.insert(key, self.value(inner)?);
            self.skip_white();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b'}') => {
                    self.bump();
                    return Ok(Value::Map(members.entries));
                }
                _ => return Err(Refusal::Syntax),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.bump();
        }
        self.at.saturating_sub(start)
    }

    /// `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`
    fn number(&mut self) -> Result<Value, Refusal> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.bump();
        }
        match self.peek() {
            Some(b'0') => self.bump(),
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(Refusal::Syntax),
        }
        if self.peek() == Some(b'.') {
            self.bump();
            if self.digits() == 0 {
                return Err(Refusal::Syntax);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.bump();
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.bump();
            }
            if self.digits() == 0 {
                return Err(Refusal::Syntax);
            }
        }
        let token = self.text.get(start..self.at).ok_or(Refusal::Syntax)?;
        token.parse::<f64>().map(Value::Number).map_err(|_| Refusal::Syntax)
    }

    fn string(&mut self) -> Result<String, Refusal> {
        self.bump();
        let mut out = String::new();
        loop {
            let start = self.at;
            while !matches!(self.peek(), None | Some(b'"' | b'\\' | 0..=0x1f)) {
                self.bump();
            }
            out.push_str(self.text.get(start..self.at).ok_or(Refusal::Syntax)?);
            match self.peek() {
                Some(b'"') => {
                    self.bump();
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.bump();
                    self.escape(&mut out)?;
                }
                _ => return Err(Refusal::Syntax),
            }
        }
    }

    fn escape(&mut self, out: &mut String) -> Result<(), Refusal> {
        let plain = match self.peek() {
            Some(b'"') => '"',
            Some(b'\\') => '\\',
            Some(b'/') => '/',
            Some(b'b') => '\u{8}',
            Some(b'f') => '\u{c}',
            Some(b'n') => '\n',
            Some(b'r') => '\r',
            Some(b't') => '\t',
            Some(b'u') => {
                self.bump();
                return self.unicode(out);
            }
            _ => return Err(Refusal::Syntax),
        };
        self.bump();
        out.push(plain);
        Ok(())
    }

    fn hex4(&mut self) -> Result<u32, Refusal> {
        let mut unit = 0u32;
        for _ in 0..4 {
            let digit =
                self.peek().and_then(|b| char::from(b).to_digit(16)).ok_or(Refusal::Syntax)?;
            unit = unit.saturating_mul(16).saturating_add(digit);
            self.bump();
        }
        Ok(unit)
    }

    /// `\uXXXX`, joined with a following low-surrogate escape when it is a high one.
    fn unicode(&mut self, out: &mut String) -> Result<(), Refusal> {
        let unit = self.hex4()?;
        let scalar = match unit {
            0xD800..=0xDBFF => {
                if self.peek() != Some(b'\\')
                    || self.text.as_bytes().get(self.at.saturating_add(1)) != Some(&b'u')
                {
                    return Err(Refusal::LoneSurrogate);
                }
                self.bump();
                self.bump();
                let low = self.hex4()?;
                if !(0xDC00..=0xDFFF).contains(&low) {
                    return Err(Refusal::LoneSurrogate);
                }
                0x10000u32
                    .saturating_add((unit.saturating_sub(0xD800)).saturating_mul(0x400))
                    .saturating_add(low.saturating_sub(0xDC00))
            }
            0xDC00..=0xDFFF => return Err(Refusal::LoneSurrogate),
            other => other,
        };
        out.push(char::from_u32(scalar).ok_or(Refusal::Syntax)?);
        Ok(())
    }
}
