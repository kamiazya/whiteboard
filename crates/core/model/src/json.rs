//! JSON text as `JSON.parse` reads it, into the value tree the frontmatter
//! reader also produces. Not `serde_json`, which sorts an object's keys: a
//! contract, a manifest or an asset table is judged and embedded in the order
//! it was written.
//!
//! What the host does that a grammar does not say: a repeated key keeps the
//! position of its first holder and takes the value of its last, a key named
//! `__proto__` is an ordinary key, and an object enumerates integer-like keys
//! first. Two things a Rust `String` cannot hold decline instead of being
//! read: a lone UTF-16 surrogate written as an escape, and nesting past
//! [`MAX_DEPTH`].

use crate::{Map, Value, enumeration_order};
use std::collections::BTreeMap;
use std::mem;

/// The deepest nesting read. `JSON.parse` has no limit of its own; a parser
/// that recurses needs one.
pub const MAX_DEPTH: usize = 64;

/// Why a text was not read as JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Not JSON: `JSON.parse` throws.
    Syntax,
    /// A string holds a lone surrogate, which `JSON.parse` keeps and Rust cannot.
    LoneSurrogate,
    /// Nesting past [`MAX_DEPTH`].
    TooDeep,
}

/// Reads `text` as `JSON.parse` does, with object keys in enumeration order.
///
/// # Errors
///
/// [`Refusal::Syntax`] for text `JSON.parse` throws on, and the two
/// [`Refusal`]s for what a Rust string or the parser's depth cannot hold.
pub fn parse(text: &str) -> Result<Value, Refusal> {
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

    fn insert(&mut self, key: String, mut value: Value) {
        if let Some(&at) = self.index.get(&key) {
            // `at` came from this table's own entries, so the lookup always
            // answers; written without a branch because the other arm has no
            // input that reaches it.
            self.entries.get_mut(at).into_iter().for_each(|entry| entry.1 = mem::take(&mut value));
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
        // The token is ASCII between two boundaries, so the slice always exists;
        // an empty one would fail the parse below like any other non-number.
        let token = self.text.get(start..self.at).unwrap_or_default();
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
            // The run stops only at ASCII bytes, so both ends are char boundaries.
            out.push_str(self.text.get(start..self.at).unwrap_or_default());
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
        // Every scalar reaching here is a BMP non-surrogate or a joined pair, so
        // the replacement is never written.
        out.push(char::from_u32(scalar).unwrap_or(char::REPLACEMENT_CHARACTER));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_DEPTH, Refusal, parse};
    use crate::Value;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn map(entries: &[(&str, Value)]) -> Value {
        Value::Map(entries.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect())
    }

    fn text(value: &str) -> Value {
        Value::String(value.to_owned())
    }

    #[test]
    fn it_reads_every_value_kind() {
        let read = parse(" {\"a\": [1, -2.5, 1e3, 2E-2, 0, true, false, null], \"b\": \"x\"} \n");
        let numbers = Value::Seq(vec![
            Value::Number(1.0),
            Value::Number(-2.5),
            Value::Number(1000.0),
            Value::Number(0.02),
            Value::Number(0.0),
            Value::Bool(true),
            Value::Bool(false),
            Value::Null,
        ]);
        assert_eq!(read, Ok(map(&[("a", numbers), ("b", text("x"))])));
        assert_eq!(parse("{}"), Ok(Value::Map(Vec::new())));
        assert_eq!(parse("[ ]"), Ok(Value::Seq(Vec::new())));
        assert_eq!(parse("\t\r\n7"), Ok(Value::Number(7.0)));
        assert_eq!(parse("1E+2"), Ok(Value::Number(100.0)));
    }

    #[test]
    fn an_object_keeps_the_first_position_and_the_last_value_of_a_repeated_key() {
        let read = parse(r#"{"b": 1, "a": 2, "b": 3}"#);
        assert_eq!(read, Ok(map(&[("b", Value::Number(3.0)), ("a", Value::Number(2.0))])));
    }

    #[test]
    fn an_object_enumerates_integer_like_keys_first_and_proto_is_a_key() {
        let read = parse(r#"{"b": 0, "10": 1, "__proto__": 2, "2": 3}"#);
        let entries = [
            ("2", Value::Number(3.0)),
            ("10", Value::Number(1.0)),
            ("b", Value::Number(0.0)),
            ("__proto__", Value::Number(2.0)),
        ];
        assert_eq!(read, Ok(map(&entries)));
    }

    #[test]
    fn a_string_reads_its_escapes_and_its_surrogate_pairs() {
        let read = parse(r#""\"\\\/\b\f\n\r\t \u00e9 \ud83d\ude00 \uFF21 é""#);
        assert_eq!(read, Ok(text("\"\\/\u{8}\u{c}\n\r\t \u{e9} \u{1f600} \u{ff21} \u{e9}")));
    }

    #[test]
    fn a_lone_surrogate_is_declined_not_misread() {
        for lone in [
            r#""\ud800""#,
            r#""\udbff""#,
            r#""\udc00""#,
            r#""\udfff""#,
            r#""\ud800x""#,
            r#""\ud800\n""#,
            r#""\ud800A""#,
            r#""\ud800\ud800""#,
        ] {
            assert_eq!(parse(lone), Err(Refusal::LoneSurrogate), "{lone}");
        }
    }

    #[test]
    fn text_that_is_not_json_is_a_syntax_refusal() {
        for bad in [
            "",
            " ",
            "x",
            "tru",
            "nul",
            "falsy",
            "{",
            "[",
            "[1,",
            "[1 2]",
            "[1,]",
            "{,}",
            "{\"a",
            "{\"\\x\": 1}",
            "{\"a\"}",
            "{\"a\" 1}",
            "{\"a\": 1,}",
            "{\"a\": 1 \"b\": 2}",
            "{1: 2}",
            "{\"a\": }",
            "1 2",
            "{} x",
            "-",
            "-x",
            "01x",
            "1.",
            "1.x",
            "1e",
            "1e+",
            "1ex",
            ".5",
            "+1",
            "\"abc",
            "\"a\nb\"",
            "\"a\u{1f}b\"",
            r#""\x""#,
            r#""\"#,
            r#""\u12""#,
            r#""\u12g4""#,
            r#""\ud800\u12""#,
        ] {
            assert_eq!(parse(bad), Err(Refusal::Syntax), "{bad:?}");
        }
    }

    #[test]
    fn a_number_past_the_range_of_a_double_reads_as_infinity() {
        // A literal past f64's range reads as infinity, as `JSON.parse` does.
        assert_eq!(parse("1e999"), Ok(Value::Number(f64::INFINITY)));
        assert_eq!(parse("-0"), Ok(Value::Number(-0.0)));
    }

    #[test]
    fn nesting_is_read_to_the_limit_and_declined_past_it() {
        let nested = |depth: usize, open: &str, close: &str| {
            format!("{}0{}", open.repeat(depth), close.repeat(depth))
        };
        assert!(parse(&nested(MAX_DEPTH, "[", "]")).is_ok());
        assert_eq!(parse(&nested(MAX_DEPTH + 1, "[", "]")), Err(Refusal::TooDeep));
        let objects = |depth: usize| format!("{}0{}", "{\"k\":".repeat(depth), "}".repeat(depth));
        assert!(parse(&objects(MAX_DEPTH)).is_ok());
        assert_eq!(parse(&objects(MAX_DEPTH + 1)), Err(Refusal::TooDeep));
    }
}
