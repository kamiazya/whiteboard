//! Whether `URL.canParse` accepts a text: the WHATWG basic URL parser's
//! failures, for the part of the grammar that fails.
//!
//! Zod's `z.url()` is `URL.canParse` on the trimmed text, so a link node's
//! `url` is valid exactly when the host's URL parser does not fail. That
//! parser fails in few places: no scheme, a missing host after a special
//! scheme's slashes, a forbidden code point or a bad port in the host, an
//! IPv6 literal that is not one, and a host that ends in a number but is not
//! an IPv4 address. The path, the query and the fragment never fail.
//!
//! One deliberate deviation: a special scheme's host is not run through
//! UTS 46, whose mapping tables this crate does not carry. A non-ASCII or
//! `xn--` host is accepted when it holds no forbidden domain code point, so a
//! host UTS 46 maps to a forbidden or empty one (a full-width `:`, a soft
//! hyphen alone), or an `xn--` label with bad punycode, is accepted here and
//! refused by the host's parser. Accepting where the browser might refuse is
//! the safe side for a link a user typed.

use whiteboard_model::checks::is_js_space;

const SPECIAL: [&str; 5] = ["http", "https", "ws", "wss", "ftp"];

/// Whether the URL parser accepts the text.
pub(super) fn can_parse(input: &str) -> bool {
    let trimmed = input.trim_matches(|c: char| c <= ' ');
    let cleaned: String = trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let Some((scheme, rest)) = split_scheme(&cleaned) else { return false };
    let scheme = scheme.to_ascii_lowercase();
    if scheme == "file" {
        return file_valid(rest);
    }
    if SPECIAL.contains(&scheme.as_str()) {
        let authority = rest.trim_start_matches(['/', '\\']);
        return authority_valid(until(authority, &['/', '\\', '?', '#']), true);
    }
    match rest.strip_prefix("//") {
        Some(authority) => authority_valid(until(authority, &['/', '?', '#']), false),
        None => true,
    }
}

/// A `file:` URL: with two slashes the host runs to the next separator, and
/// is empty, a Windows drive letter (which is the path's, not a host) or a
/// domain; with fewer there is no host.
fn file_valid(rest: &str) -> bool {
    let mut chars = rest.chars();
    if !(chars.next().is_some_and(is_slash) && chars.next().is_some_and(is_slash)) {
        return true;
    }
    let host = until(rest.get(2..).unwrap_or(""), &['/', '\\', '?', '#']);
    host.is_empty() || is_drive_letter(host) || host_valid(host, true)
}

fn is_slash(c: char) -> bool {
    matches!(c, '/' | '\\')
}

/// A letter and `:` or `|`.
fn is_drive_letter(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(letter), Some(':' | '|'), None) if letter.is_ascii_alphabetic()
    )
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
fn authority_valid(authority: &str, special: bool) -> bool {
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, rest)| rest);
    let split = if host_port.starts_with('[') {
        host_port.find(']').and_then(|end| host_port.split_at_checked(end.saturating_add(1))).map(
            |(host, after)| {
                (host, after.strip_prefix(':'), after.is_empty() || after.starts_with(':'))
            },
        )
    } else {
        let (host, port) = match host_port.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        };
        Some((host, port, true))
    };
    let Some((host, port, tail_ok)) = split else { return false };
    if !tail_ok || !port.is_none_or(port_valid) {
        return false;
    }
    if host.is_empty() && (special || port.is_some() || authority.contains('@')) {
        return false;
    }
    host_valid(host, special)
}

/// The host parser: a bracketed IPv6 address, else a domain or an opaque host.
fn host_valid(host: &str, special: bool) -> bool {
    if let Some(inner) = host.strip_prefix('[') {
        return inner.strip_suffix(']').is_some_and(ipv6_valid);
    }
    if special { domain_valid(host) } else { opaque_host_valid(host) }
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

/// A special scheme's host: percent-decoded, lower-cased, no forbidden domain
/// code point, and an IPv4 address when its last label is a number.
fn domain_valid(host: &str) -> bool {
    let Some(decoded) = percent_decode(host) else { return false };
    let lower = decoded.to_ascii_lowercase();
    if lower.chars().any(|c| forbidden_host(c) || c <= '\u{1f}' || c == '%' || c == '\u{7f}') {
        return false;
    }
    !ends_in_number(&lower) || ipv4_valid(&lower)
}

/// The percent-decoding of the host's bytes as UTF-8; a malformed escape stays
/// literal, and bytes that are not UTF-8 are `None`.
fn percent_decode(text: &str) -> Option<String> {
    let mut rest = text.as_bytes();
    let mut out = Vec::with_capacity(rest.len());
    while let Some((&byte, tail)) = rest.split_first() {
        rest = tail;
        if let (b'%', [high, low, after @ ..]) = (byte, tail) {
            let value = std::str::from_utf8(&[*high, *low])
                .ok()
                .filter(|pair| pair.bytes().all(|b| b.is_ascii_hexdigit()))
                .and_then(|pair| u8::from_str_radix(pair, 16).ok());
            if let Some(value) = value {
                out.push(value);
                rest = after;
                continue;
            }
        }
        out.push(byte);
    }
    String::from_utf8(out).ok()
}

/// The WHATWG IPv6 parser's verdict on the text between the brackets: up to
/// eight pieces of at most four hex digits, one `::`, and a dotted-decimal
/// IPv4 address in place of the last two pieces.
fn ipv6_valid(text: &str) -> bool {
    let mut rest = text.as_bytes();
    let mut pieces = 0usize;
    let mut compressed = false;
    if let Some(after) = rest.strip_prefix(b"::") {
        rest = after;
        pieces = 1;
        compressed = true;
    } else if rest.first() == Some(&b':') {
        return false;
    }
    while !rest.is_empty() {
        if pieces >= 8 {
            return false;
        }
        if let Some(after) = rest.strip_prefix(b":") {
            if compressed {
                return false;
            }
            rest = after;
            pieces = pieces.saturating_add(1);
            compressed = true;
            continue;
        }
        let digits = rest.iter().take(4).take_while(|b| b.is_ascii_hexdigit()).count();
        let Some((_, after)) = rest.split_at_checked(digits) else { return false };
        rest = match after.split_first() {
            Some((b'.', _)) => {
                // The IPv4 tail fills the last two pieces, so without `::` exactly six precede it.
                return digits > 0
                    && pieces <= 6
                    && (compressed || pieces == 6)
                    && std::str::from_utf8(rest).is_ok_and(strict_ipv4);
            }
            Some((b':', tail)) if !tail.is_empty() => tail,
            Some(_) => return false,
            None => after,
        };
        pieces = pieces.saturating_add(1);
    }
    compressed || pieces == 8
}

/// Four decimal parts, none empty, none with a leading zero, none past 255.
fn strict_ipv4(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
                && part.parse::<u8>().is_ok()
        })
}

/// The host parser's "ends in a number" test on the last non-empty label.
fn ends_in_number(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.last() == Some(&"") {
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
    if parts.last() == Some(&"") {
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

/// What `z.url()` decides for a string.
pub(super) fn zod_url_valid(text: &str) -> bool {
    can_parse(text.trim_matches(is_js_space))
}

#[cfg(test)]
mod tests;
