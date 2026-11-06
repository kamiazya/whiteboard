//! The module's own doc comment.

/// A doc comment on an item.
pub const URL: &str = "https://a.example/// not a comment";

/* An outer block /* with a nested block */ still a comment */
pub const RAW: &str = r#"a "quoted" // word and /* no comment */"#;
pub const RAW2: &str = r##"one "# is not the end"##;
pub const BYTES: &[u8] = b"// bytes, not a comment";
pub const OPEN: char = '{';
pub const QUOTE: char = '"';
pub const ESCAPED: char = '\'';
pub const FACE: char = '😀';

pub fn borrow<'a>(x: &'a str) -> &'a str {
    let r#type = '}'; // trailing comment
    let _ = r#type;
    'outer: loop {
        break 'outer;
    }
    x
}
