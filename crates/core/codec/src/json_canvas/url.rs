//! Whether `URL.canParse` accepts a text: the WHATWG basic URL parser's
//! failures, for the part of the grammar that needs no tables.
//!
//! Zod's `z.url()` is `URL.canParse` on the trimmed text, so a link node's
//! `url` is valid exactly when the host's URL parser does not fail. That
//! parser fails in few places: no scheme, a missing host after a special
//! scheme's slashes, a forbidden code point or a bad port in the host, and a
//! host that ends in a number but is not an IPv4 address. The path, the query
//! and the fragment never fail.
//!
//! Three things need data this crate does not carry, and [`can_parse`]
//! declines them with `None` rather than guess: an internationalised or
//! `xn--` host (UTS 46), a percent-encoded host, and an IPv6 literal. So does
//! the `file` scheme, whose host rules are their own.

use whiteboard_model::checks::is_js_space;

const SPECIAL: [&str; 5] = ["http", "https", "ws", "wss", "ftp"];

/// `Some(verdict)` when the URL parser's answer is known, `None` when only the
/// host's own parser can give it.
pub(super) fn can_parse(input: &str) -> Option<bool> {
    let trimmed = input.trim_matches(|c: char| c <= ' ');
    let cleaned: String = trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let Some((scheme, rest)) = split_scheme(&cleaned) else { return Some(false) };
    let scheme = scheme.to_ascii_lowercase();
    if scheme == "file" {
        return None;
    }
    let special = SPECIAL.contains(&scheme.as_str());
    if special {
        let authority = rest.trim_start_matches(['/', '\\']);
        return authority_valid(until(authority, &['/', '\\', '?', '#']), true);
    }
    match rest.strip_prefix("//") {
        Some(authority) => authority_valid(until(authority, &['/', '?', '#']), false),
        None => Some(true),
    }
}

/// The URL's text with a leading `scheme:` taken off, if it opens with one.
fn split_scheme(text: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = text.split_once(':')?;
    let mut chars = scheme.chars();
    let first = chars.next()?;
    let valid = first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid.then_some((scheme, rest))
}

/// The text up to the first of `stops`.
fn until<'a>(text: &'a str, stops: &[char]) -> &'a str {
    text.find(stops).and_then(|end| text.get(..end)).unwrap_or(text)
}

/// Userinfo, host and port: the part of a URL between the slashes and the path.
fn authority_valid(authority: &str, special: bool) -> Option<bool> {
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, rest)| rest);
    if host_port.contains('[') {
        return None;
    }
    let (host, port) = match host_port.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (host_port, None),
    };
    if host.is_empty() && (special || port.is_some() || authority.contains('@')) {
        return Some(false);
    }
    if !port.is_none_or(port_valid) {
        return Some(false);
    }
    if special { domain_valid(host) } else { Some(opaque_host_valid(host)) }
}

/// Digits only, and no larger than 65535. An empty port is none.
fn port_valid(port: &str) -> bool {
    let value = port.bytes().fold(0u32, |n, b| {
        n.saturating_mul(10).saturating_add(u32::from(b).saturating_sub(u32::from(b'0')))
    });
    port.bytes().all(|b| b.is_ascii_digit()) && value <= 65535
}

/// The forbidden host code points: those an opaque host may not hold.
fn forbidden_host(c: char) -> bool {
    matches!(
        c,
        '\0' | '\t'
            | '\n'
            | '\r'
            | ' '
            | '#'
            | '/'
            | ':'
            | '<'
            | '>'
            | '?'
            | '@'
            | '['
            | '\\'
            | ']'
            | '^'
            | '|'
    )
}

fn opaque_host_valid(host: &str) -> bool {
    !host.chars().any(forbidden_host)
}

/// A special scheme's host: lower-cased ASCII, no forbidden domain code point,
/// and an IPv4 address when its last label is a number.
fn domain_valid(host: &str) -> Option<bool> {
    if host.contains('%') || !host.is_ascii() {
        return None;
    }
    let lower = host.to_ascii_lowercase();
    if lower.split('.').any(|label| label.starts_with("xn--")) {
        return None;
    }
    if lower.chars().any(|c| forbidden_host(c) || c <= '\u{1f}' || c == '\u{7f}') {
        return Some(false);
    }
    Some(!ends_in_number(&lower) || ipv4_valid(&lower))
}

/// The host parser's "ends in a number" test on the last non-empty label.
fn ends_in_number(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.last() == Some(&"") {
        if parts.len() == 1 {
            return false;
        }
        parts.pop();
    }
    let Some(last) = parts.last() else { return false };
    (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit())) || ipv4_number(last).is_some()
}

/// One IPv4 part: decimal, `0x` hexadecimal or `0` octal. `None` is the
/// parser's failure; a value past what a `u64` holds is clamped, since the
/// caller only asks whether it is under 2^32.
fn ipv4_number(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    let (digits, radix) =
        if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            (hex, 16)
        } else if part.len() >= 2 && part.starts_with('0') {
            (part.get(1..)?, 8)
        } else {
            (part, 10)
        };
    let mut value = 0u64;
    for c in digits.chars() {
        let digit = u64::from(c.to_digit(radix)?);
        value = value.saturating_mul(u64::from(radix)).saturating_add(digit);
    }
    Some(value)
}

fn ipv4_valid(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.last() == Some(&"") && parts.len() > 1 {
        parts.pop();
    }
    if parts.len() > 4 {
        return false;
    }
    let Some(numbers) = parts.iter().map(|part| ipv4_number(part)).collect::<Option<Vec<u64>>>()
    else {
        return false;
    };
    let Some((last, leading)) = numbers.split_last() else { return false };
    let room =
        256u64.saturating_pow(u32::try_from(5usize.saturating_sub(numbers.len())).unwrap_or(0));
    leading.iter().all(|n| *n <= 255) && *last < room
}

/// Zod trims the text with `String.prototype.trim` before asking, and keeps
/// the trimmed text (with tabs and line breaks dropped) as the value.
pub(super) fn zod_url_value(text: &str) -> String {
    let trimmed = text.trim_matches(is_js_space);
    trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect()
}

/// What `z.url()` decides for a string: `Some(valid)`, or `None` to decline.
pub(super) fn zod_url_valid(text: &str) -> Option<bool> {
    can_parse(text.trim_matches(is_js_space))
}
