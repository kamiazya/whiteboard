//! Canonical number and href formatting for the SVG backend: the ONE place a
//! number or an href becomes serialized SVG text, so the same scene produces
//! the same bytes on every target.

use crate::xml_escape::strip_xml_invalid_chars;
use whiteboard_det::format::js_to_fixed;

/// Fixed decimal precision for all emitted coordinates.
const COORD_PRECISION: usize = 3;

/// A coordinate that was not a finite number. Layout is responsible for never
/// producing one, so reaching the serializer with one is a layout defect and
/// the render is refused rather than written.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NonFinite(pub f64);

/// Formats a finite number as a canonical SVG coordinate: fixed decimal
/// precision, trailing zeros and dot stripped, `-0` as `0`.
pub fn format_coord(value: f64) -> Result<String, NonFinite> {
    if !value.is_finite() {
        return Err(NonFinite(value));
    }
    let fixed = js_to_fixed(value, COORD_PRECISION);
    let stripped = if fixed.contains('.') {
        fixed.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        fixed
    };
    // A small negative rounds to `-0.000` and strips to `-0`, which would
    // reach the document as a coordinate differing from `0` byte for byte.
    Ok(if stripped.is_empty() || stripped == "-0" { "0".to_string() } else { stripped })
}

/// URL schemes a rendered `<a href>` may navigate to. Markdown link URLs are
/// caller-supplied and unrestricted; escaping prevents attribute breakout but
/// not a `javascript:` or `data:` scheme executing when the SVG is opened
/// directly or embedded inline.
const SAFE_URL_SCHEMES: [&str; 4] = ["http", "https", "mailto", "tel"];

/// The URL parser strips ASCII tab, line feed and carriage return anywhere in
/// the input and trims leading C0-control-or-space before resolving a scheme
/// (WHATWG URL, section 4.4). A scheme check that skips this is bypassable
/// with `\tjavascript:` or `java\nscript:`, which look scheme-less but resolve
/// to `javascript:` once activated.
fn normalize_for_scheme_check(href: &str) -> String {
    let stripped: String = href.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    stripped.trim_start_matches(|c: char| c <= ' ').to_string()
}

/// The scheme prefix of a URL (`javascript` of `javascript:...`) per the URL
/// spec's grammar, if it has one.
fn scheme_of(text: &str) -> Option<&str> {
    let (scheme, _) = text.split_once(':')?;
    let mut chars = scheme.chars();
    let starts_alpha = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    (starts_alpha && rest_ok).then_some(scheme)
}

/// `href` when it is a relative or hash link or has an allow-listed scheme,
/// otherwise `#`: never fails, degrades to a safe same-page anchor rather than
/// rejecting the whole render.
///
/// The check runs on the href with XML-invalid characters already removed, and
/// that stripped form is what is returned: the serializer removes them anyway,
/// so judging the raw input lets `java\u{85}script:` pass as relative and reach
/// the document as `javascript:`.
#[must_use]
pub fn sanitize_href(href: &str) -> String {
    let emitted = strip_xml_invalid_chars(href);
    let normalized = normalize_for_scheme_check(&emitted);
    // A scheme-less href that still names another host (`//host/x`): under an
    // http(s) base the URL parser reads `\` as `/`, so `\\host` is the same
    // address. Refused, as it is not the relative link a scheme-less href is
    // allowed through as.
    let mut leading = normalized.chars();
    let network_path = leading.next().is_some_and(|c| matches!(c, '/' | '\\'))
        && leading.next().is_some_and(|c| matches!(c, '/' | '\\'));
    if network_path {
        return "#".to_string();
    }
    match scheme_of(&normalized) {
        None => emitted,
        Some(scheme) if SAFE_URL_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) => emitted,
        Some(_) => "#".to_string(),
    }
}
