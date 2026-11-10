//! The frontmatter writer: `yaml.stringify` as `serializeOkf` calls it, with
//! `doubleQuotedAsJSON`, for the plain JSON-shaped values a document holds.

use super::fold::Units;
use super::quote::{Ctx, string, units};
use super::value::{Fault, MAX_PARSE_DEPTH, Step, Unwritable, Value};

const NEWLINE: u16 = b'\n' as u16;
const SPACE: u16 = b' ' as u16;

/// The longest key, in written units, `yaml` keeps on its line.
const MAX_IMPLICIT_KEY_UNITS: usize = 1024;

/// A value's spelling as a frontmatter document: block style throughout, a
/// trailing newline, nothing written for the `---` fences.
pub(super) fn document(value: &Value) -> Result<Units, Vec<Fault>> {
    let faults = faults(value);
    if !faults.is_empty() {
        return Err(faults);
    }
    let mut ctx =
        Ctx { indent: 0, implicit_key: false, indent_at_start: None, force_block_indent: false };
    let mut text = node(value, &mut ctx);
    text.push(NEWLINE);
    Ok(text)
}

/// The issues of `yamlSafeValueSchema`, for what a `Value` can hold, in the
/// order it reports them: a `__proto__` key anywhere first, at the root, then
/// a walk that names a mapping's unprintable keys before its entries.
fn faults(value: &Value) -> Vec<Fault> {
    let mut found = Walk { faults: Vec::new(), reserved: false };
    found.visit(value, &mut Vec::new());
    if found.reserved {
        found.faults.insert(0, Fault { path: Vec::new(), why: Unwritable::ReservedKey });
    }
    found.faults
}

struct Walk {
    faults: Vec<Fault>,
    reserved: bool,
}

impl Walk {
    fn fault(&mut self, path: &[Step], why: Unwritable) {
        self.faults.push(Fault { path: path.to_vec(), why });
    }

    fn visit(&mut self, value: &Value, path: &mut Vec<Step>) {
        match value {
            Value::Number(n) if n.is_nan() => self.fault(path, Unwritable::Nan),
            Value::Number(n) if n.is_infinite() => self.fault(
                path,
                if *n < 0.0 { Unwritable::NegativeInfinity } else { Unwritable::Infinity },
            ),
            Value::BigInt(_) => self.fault(path, Unwritable::BigInt),
            Value::String(text) if text.contains('\u{feff}') => {
                self.fault(path, Unwritable::ByteOrderMark);
            }
            // The path holds the collections around `value`.
            Value::Seq(_) | Value::Map(_) if path.len() >= MAX_PARSE_DEPTH => {
                self.fault(path, Unwritable::TooDeep);
            }
            Value::Seq(items) => {
                for (at, item) in items.iter().enumerate() {
                    path.push(Step::Index(at));
                    self.visit(item, path);
                    path.pop();
                }
            }
            Value::Map(entries) => {
                for _ in entries.iter().filter(|(key, _)| key.contains('\u{feff}')) {
                    self.fault(path, Unwritable::ByteOrderMark);
                }
                for (key, item) in entries {
                    self.reserved |= key == "__proto__";
                    path.push(Step::Key(key.clone()));
                    self.visit(item, path);
                    path.pop();
                }
            }
            _ => {}
        }
    }
}

fn node(value: &Value, ctx: &mut Ctx) -> Units {
    match value {
        Value::Null => units("null"),
        Value::Bool(b) => units(if *b { "true" } else { "false" }),
        Value::Number(n) => units(&number(*n)),
        Value::BigInt(digits) => units(digits),
        Value::String(text) => string(&units(text), ctx),
        Value::Seq(items) if items.is_empty() => units("[]"),
        Value::Seq(items) => {
            let item_ctx = Ctx { indent: ctx.indent.saturating_add(2), ..ctx.clone() };
            let lines: Vec<Units> = items
                .iter()
                .map(|item| [units("- "), node(item, &mut item_ctx.clone())].concat())
                .collect();
            join_lines(&lines, ctx.indent)
        }
        Value::Map(entries) if entries.is_empty() => units("{}"),
        Value::Map(entries) => {
            let lines: Vec<Units> =
                entries.iter().map(|(key, item)| pair(key, item, ctx)).collect();
            join_lines(&lines, ctx.indent)
        }
    }
}

/// `-0` is written as it is; every other number as `JSON.stringify`.
fn number(n: f64) -> String {
    if n == 0.0 && n.is_sign_negative() {
        "-0".to_string()
    } else {
        whiteboard_det::format::js_number_to_string(n)
    }
}

/// Lines joined by a newline and the block's indent; an empty line carries no indent.
fn join_lines(lines: &[Units], indent: usize) -> Units {
    let mut out = Units::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            out.push(NEWLINE);
            if !line.is_empty() {
                out.extend(std::iter::repeat_n(SPACE, indent));
            }
        }
        out.extend_from_slice(line);
    }
    out
}

fn is_collection(value: &Value) -> bool {
    matches!(value, Value::Seq(_) | Value::Map(_))
}

fn is_empty_collection(value: &Value) -> bool {
    matches!(value, Value::Seq(items) if items.is_empty())
        || matches!(value, Value::Map(entries) if entries.is_empty())
}

/// One `key: value`, or `? key` and `:` on lines of their own when the key is
/// longer than a line may hold.
fn pair(key: &str, value: &Value, parent: &Ctx) -> Units {
    let mut ctx =
        Ctx { implicit_key: true, indent: parent.indent.saturating_add(2), ..parent.clone() };
    let key_text = string(&units(key), &mut ctx);
    let explicit = key_text.len() > MAX_IMPLICIT_KEY_UNITS;
    let mut head = if explicit {
        let mut head = units("? ");
        head.extend_from_slice(&key_text);
        head.push(NEWLINE);
        head.extend(std::iter::repeat_n(SPACE, parent.indent));
        head.push(u16::from(b':'));
        head
    } else {
        let mut head = key_text;
        head.push(u16::from(b':'));
        head
    };
    ctx.implicit_key = false;
    if !explicit && !is_collection(value) {
        ctx.indent_at_start = Some(head.len().saturating_add(1));
    }
    let body = node(value, &mut ctx);
    let separator = if !explicit && is_collection(value) {
        if body.contains(&NEWLINE) || !is_empty_collection(value) {
            std::iter::once(NEWLINE).chain(std::iter::repeat_n(SPACE, ctx.indent)).collect()
        } else {
            units(" ")
        }
    } else if body.first().is_none_or(|&u| u == NEWLINE) {
        Units::new()
    } else {
        units(" ")
    };
    head.extend(separator);
    head.extend(body);
    head
}
