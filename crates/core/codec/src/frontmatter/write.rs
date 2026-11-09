//! The frontmatter writer: `yaml.stringify` as `serializeOkf` calls it, with
//! `doubleQuotedAsJSON`, for the plain JSON-shaped values a document holds.

use super::fold::Units;
use super::quote::{Ctx, string, units};
use super::value::{MAX_PARSE_DEPTH, Unwritable, Value};

const NEWLINE: u16 = b'\n' as u16;
const SPACE: u16 = b' ' as u16;

/// The longest key, in written units, `yaml` keeps on its line.
const MAX_IMPLICIT_KEY_UNITS: usize = 1024;

/// A value's spelling as a frontmatter document: block style throughout, a
/// trailing newline, nothing written for the `---` fences.
pub(super) fn document(value: &Value) -> Result<Units, Unwritable> {
    check(value, 0)?;
    let mut ctx =
        Ctx { indent: 0, implicit_key: false, indent_at_start: None, force_block_indent: false };
    let mut text = node(value, &mut ctx);
    text.push(NEWLINE);
    Ok(text)
}

/// The refusals of `yamlSafeValueSchema`, for what a `Value` can hold, with
/// `above` collections around `value`.
fn check(value: &Value, above: usize) -> Result<(), Unwritable> {
    let below = above.saturating_add(1);
    match value {
        Value::Number(n) if !n.is_finite() => Err(Unwritable::NonFiniteNumber),
        Value::BigInt(_) => Err(Unwritable::BigInt),
        Value::String(text) if text.contains('\u{feff}') => Err(Unwritable::ByteOrderMark),
        Value::Seq(_) | Value::Map(_) if below > MAX_PARSE_DEPTH => Err(Unwritable::TooDeep),
        Value::Seq(items) => items.iter().try_for_each(|item| check(item, below)),
        Value::Map(entries) => entries.iter().try_for_each(|(key, item)| {
            if key.contains('\u{feff}') {
                return Err(Unwritable::ByteOrderMark);
            }
            if key == "__proto__" {
                return Err(Unwritable::ReservedKey);
            }
            check(item, below)
        }),
        _ => Ok(()),
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
