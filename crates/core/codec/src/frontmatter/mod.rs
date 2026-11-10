//! OKF frontmatter as a restricted YAML subset, read and written.
//!
//! The subset is what `serializeOkf` writes plus what a person writes by hand
//! that `yaml` reads the same way; everything else is refused by name rather
//! than read by one implementation and misread by another. The TypeScript
//! reader (`frontmatter-yaml.ts`) refuses the same constructs, and the
//! recorded oracle holds the two to the same answers.

mod block;
mod block_string;
mod blockscalar;
mod cursor;
mod flow;
mod fold;
mod node;
mod number;
mod precheck;
mod quote;
mod resolve;
mod scalars;
mod schema;
mod value;
mod write;

use cursor::Parser;
pub use value::{Fault, MAX_BYTES, MAX_DEPTH, MAX_PARSE_DEPTH, Refusal, Step, Unwritable, Value};

/// Reads a frontmatter text (the YAML between the `---` fences) as `yaml`
/// 2.9 reads it under the core schema, or says why it cannot.
///
/// A text longer than [`MAX_BYTES`] is refused before it is read, and
/// collections nested past [`MAX_DEPTH`] are refused after it is.
pub fn parse(text: &str) -> Result<Value, Refusal> {
    let normalized = precheck::normalize(text)?;
    let mut parser = Parser::new(&normalized);
    let root = parser.document()?;
    let value = resolve::resolve(root.as_ref())?;
    parser.refuse_unquoted_c1()?;
    if parser.lone_surrogate {
        return Err(Refusal::Subset("a lone UTF-16 surrogate"));
    }
    Ok(value)
}

/// Writes `value` as the frontmatter text `serializeOkf` puts between its
/// fences: block style, no `---` lines, and without the one newline `yaml`
/// ends a document with (a value that itself ends in newlines keeps them).
/// A value with no spelling answers every place that has none, in the order
/// `yamlSafeValueSchema` reports them.
pub fn stringify(value: &Value) -> Result<String, Vec<Fault>> {
    let text = String::from_utf16_lossy(&write::document(value)?);
    Ok(text.strip_suffix('\n').map_or(text.clone(), str::to_string))
}

impl Parser {
    /// A C1 control (U+007F to U+009F) is read only inside double quotes, the
    /// one place a writer escapes it.
    fn refuse_unquoted_c1(&self) -> Result<(), Refusal> {
        // The ranges are in source order and do not overlap.
        let outside = |index: usize| {
            let at = self.double_quoted.partition_point(|&(_, end)| end <= index);
            !self.double_quoted.get(at).is_some_and(|&(start, end)| (start..end).contains(&index))
        };
        let found = self
            .chars
            .iter()
            .enumerate()
            .any(|(index, c)| ('\u{7f}'..='\u{9f}').contains(c) && outside(index));
        if found {
            Err(Refusal::Subset("a C1 control character outside double quotes"))
        } else {
            Ok(())
        }
    }
}
