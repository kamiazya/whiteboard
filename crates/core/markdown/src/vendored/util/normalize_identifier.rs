//! Normalize identifiers.

use alloc::string::String;

/// Normalize an identifier, as found in [references][label_end] and
/// [definitions][definition], so it can be compared when matching.
///
/// This collapsed whitespace found in markdown (`\t`, `\r`, `\n`, and ` `)
/// into one space, trims it (as in, dropping the first and last space), and
/// then performs unicode case folding twice: first by lowercasing uppercase
/// characters, and then uppercasing lowercase characters.
///
/// Some characters are considered “uppercase”, such as U+03F4 (`ϴ`), but if
/// their lowercase counterpart (U+03B8 (`θ`)) is uppercased will result in a
/// different uppercase character (U+0398 (`Θ`)).
/// Hence, to get that form, we perform both lower- and uppercase.
///
/// Performing these steps in that order works, but the inverse does not work.
/// To illustrate, say the source markdown containes two identifiers
/// `SS` (U+0053 U+0053) and `ẞ` (U+1E9E), which would be lowercased to
/// `ss` (U+0073 U+0073) and `ß` (U+00DF), and those in turn would both
/// uppercase to `SS` (U+0053 U+0053).
/// If we’d inverse the steps, for `ẞ`, we’d first uppercase without a
/// change, and then lowercase to `ß`, which would not match `ss`.
///
/// ## Examples
///
/// ```rust ignore
/// markdown::util::normalize_identifier::normalize_identifier;
///
/// assert_eq!(normalize_identifier(" a "), "a");
/// assert_eq!(normalize_identifier("a\t\r\nb"), "a b");
/// assert_eq!(normalize_identifier("ПРИВЕТ"), "привет");
/// assert_eq!(normalize_identifier("Привет"), "привет");
/// assert_eq!(normalize_identifier("привет"), "привет");
/// ```
///
/// ## References
///
/// * [`micromark-util-normalize-identifier` in `micromark`](https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier)
///
/// [definition]: crate::vendored::construct::definition
/// [label_end]: crate::vendored::construct::label_end
pub(crate) fn normalize_identifier(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for word in value.split(['\t', '\n', '\r', ' ']).filter(|w| !w.is_empty()) {
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(word);
    }
    result.to_lowercase().to_uppercase()
}
