//! The literal autolinks remark finds in finished text.
//!
//! `remark-gfm` links `www.`, `http://` and email addresses twice: in the
//! tokenizer, and again by a find-and-replace over the text nodes of the
//! finished tree (`mdast-util-gfm-autolink-literal`'s transform, patched in
//! this repository to bound each match). The second pass is what links an
//! address after `;`, an entity or an escape, and it is not in the GFM spec, so
//! the vendored tokenizer does not do it. This is that pass, over the tree the
//! tokenizer built, so the tree is the one `parseMarkdownBody` answers.
//!
//! Every match is bounded as the patched patterns are: a domain at 256
//! characters, a path at 2,048, a local part at 256. The work of each text
//! node and of each attempt is charged to the parse's fuel, so a text built to
//! make many attempts fail is refused instead of read.

use crate::mdast::{Link, Node, Text};
use crate::vendored::{Budget, is_punctuation};
use alloc::{format, string::ToString, vec, vec::Vec};

/// Longest domain one URL match reads, in characters.
const DOMAIN_MAX: usize = 256;
/// Longest path one URL match reads after its domain, in characters.
const PATH_MAX: usize = 2_048;
/// Longest local part one email match reads, in characters.
const LOCAL_MAX: usize = 256;

/// Link the literal URLs and then the email addresses left in the text of `root`.
///
/// A text under a link or a link reference is left alone, and the second pass
/// reads the pieces the first left, as the find-and-replace it was written for does.
pub(crate) fn link_literals(root: &mut Node, budget: &Budget) {
    visit(root, budget, urls_in);
    visit(root, budget, emails_in);
}

/// What replaces a text: the nodes it becomes, or nothing when it is left as it is.
type Finder = fn(&str, &Budget) -> Option<Vec<Node>>;

fn visit(node: &mut Node, budget: &Budget, find: Finder) {
    if matches!(node, Node::Link(_) | Node::LinkReference(_)) {
        return;
    }
    let Some(children) = node.children_mut() else { return };
    let before = core::mem::take(children);
    let mut after = Vec::with_capacity(before.len());
    for mut child in before {
        let replaced = match &child {
            // A unit for four bytes: the scan for a place to start.
            Node::Text(text) if budget.spend((text.value.len() / 4).saturating_add(1)) => {
                find(&text.value, budget)
            }
            _ => None,
        };
        if let Some(nodes) = replaced {
            after.extend(nodes);
        } else {
            if !matches!(child, Node::Text(_)) {
                visit(&mut child, budget, find);
            }
            after.push(child);
        }
    }
    *children = after;
}

/// A text cut into the text between matches and what each match became.
struct Pieces<'a> {
    value: &'a str,
    nodes: Vec<Node>,
    start: usize,
}

impl<'a> Pieces<'a> {
    fn new(value: &'a str) -> Self {
        Pieces { value, nodes: Vec::new(), start: 0 }
    }

    fn text_between(&mut self, from: usize, to: usize) {
        if from < to
            && let Some(between) = self.value.get(from..to)
        {
            self.nodes.push(text(between));
        }
    }

    /// The match at `from..to` became `made`.
    fn push(&mut self, from: usize, to: usize, made: Vec<Node>) {
        self.text_between(self.start, from);
        self.nodes.extend(made);
        self.start = to;
    }

    fn finish(mut self) -> Option<Vec<Node>> {
        if self.nodes.is_empty() {
            return None;
        }
        self.text_between(self.start, self.value.len());
        Some(self.nodes)
    }
}

fn text(value: &str) -> Node {
    Node::Text(Text { value: value.to_string(), position: None })
}

fn link(url: &str, shown: &str) -> Node {
    Node::Link(Link {
        children: vec![text(shown)],
        position: None,
        url: url.to_string(),
        title: None,
    })
}

/// What JavaScript's `\s` is.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Whether a match may start at `at`: at the start of the text, or after white
/// space, punctuation or a symbol.
///
/// The TypeScript reads that character as a UTF-16 unit, so one outside the
/// basic plane is its low surrogate, which is none of them: a match after an
/// emoji is refused. An email is also refused after a slash.
fn may_start_at(value: &str, at: usize, email: bool) -> bool {
    if at == 0 {
        return true;
    }
    let Some(before) = value.get(..at).and_then(|head| head.chars().next_back()) else {
        return false;
    };
    before.len_utf8() < 4
        && (is_js_space(before) || is_punctuation(before))
        && !(email && before == '/')
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

// ---- URLs

fn urls_in(value: &str, budget: &Budget) -> Option<Vec<Node>> {
    let mut pieces = Pieces::new(value);
    let mut at = 0_usize;
    while let Some(rest) = value.get(at..) {
        let Some(offset) = rest.find(['h', 'H', 'w', 'W']) else { break };
        let start = at.saturating_add(offset);
        match url_at(value, start, budget) {
            Some((end, made)) => {
                pieces.push(start, end, made);
                // A match always ends past its start; this keeps the scan moving if one did not.
                at = end.max(start.saturating_add(1));
            }
            None => at = start.saturating_add(1),
        }
        if budget.refusal().is_some() {
            return None;
        }
    }
    pieces.finish()
}

/// How a URL starts: `http://` or `https://` (any case), or `www` before a dot,
/// and how many bytes of the text that takes.
fn protocol(from: &[u8]) -> Option<(bool, usize)> {
    if from.get(..3).is_some_and(|head| head.eq_ignore_ascii_case(b"www"))
        && from.get(3) == Some(&b'.')
    {
        return Some((true, 3));
    }
    if !from.get(..4).is_some_and(|head| head.eq_ignore_ascii_case(b"http")) {
        return None;
    }
    let secure = from.get(4).is_some_and(|b| b.eq_ignore_ascii_case(&b's'));
    let colon: usize = if secure { 5 } else { 4 };
    (from.get(colon..colon.saturating_add(3)) == Some(b"://"))
        .then_some((false, colon.saturating_add(3)))
}

/// How many bytes of domain characters, at most 256, `bytes` holds from `from`.
fn domain_run(bytes: &[u8], from: usize) -> usize {
    bytes.get(from..).map_or(0, |rest| {
        rest.iter().take(DOMAIN_MAX).take_while(|&&b| is_word(b) || b == b'-' || b == b'.').count()
    })
}

/// The URL starting at `start`: where its match ends, and what it became.
fn url_at(value: &str, start: usize, budget: &Budget) -> Option<(usize, Vec<Node>)> {
    if !may_start_at(value, start, false) {
        return None;
    }
    let bytes = value.as_bytes();
    let (www, protocol_len) = protocol(bytes.get(start..)?)?;
    let domain_start = start.saturating_add(protocol_len);
    let domain_len = domain_run(bytes, domain_start);
    if domain_len == 0 {
        return None;
    }
    let domain_end = domain_start.saturating_add(domain_len);
    let path_len: usize = value
        .get(domain_end..)?
        .chars()
        .take(PATH_MAX)
        .take_while(|c| !matches!(c, ' ' | '\t' | '\r' | '\n'))
        .map(char::len_utf8)
        .sum();
    let end = domain_end.saturating_add(path_len);
    // An attempt reads its whole match, however it ends.
    if !budget.spend((end.saturating_sub(start) / 4).saturating_add(1)) {
        return None;
    }
    // `www` counts as part of the domain; `http://` does not.
    let domain = value.get(if www { start } else { domain_start }..domain_end)?;
    if !is_correct_domain(domain) {
        return None;
    }
    let (main, trail) = split_url(value.get(if www { start } else { domain_start }..end)?);
    if main.is_empty() {
        return None;
    }
    let opening = value.get(start..domain_start)?;
    let made = if www {
        link(&format!("http://{main}"), main)
    } else {
        let shown = format!("{opening}{main}");
        link(&shown, &shown)
    };
    let mut nodes = vec![made];
    if !trail.is_empty() {
        nodes.push(text(trail));
    }
    Some((end, nodes))
}

/// Whether the last two labels of a domain are not empty-looking: neither has
/// an underscore, and each holds a letter or a digit (an empty one passes).
fn is_correct_domain(domain: &str) -> bool {
    let mut labels = domain.rsplit('.');
    let (Some(last), Some(second)) = (labels.next(), labels.next()) else {
        return false;
    };
    let fine = |label: &str| {
        label.is_empty()
            || (!label.contains('_') && label.bytes().any(|b| b.is_ascii_alphanumeric()))
    };
    fine(last) && fine(second)
}

fn is_trailing_punctuation(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'"'
            | b'&'
            | b'\''
            | b')'
            | b','
            | b'.'
            | b':'
            | b';'
            | b'<'
            | b'>'
            | b'?'
            | b']'
            | b'}'
    )
}

/// A URL and what trails it: punctuation that ends a sentence is not the URL's,
/// and a `)` is its own only while the URL has more `(` than `)`.
fn split_url(url: &str) -> (&str, &str) {
    let bytes = url.as_bytes();
    let mut cut =
        bytes.iter().rposition(|&b| !is_trailing_punctuation(b)).map_or(0, |p| p.saturating_add(1));
    let count = |ch: char, upto: usize| url.get(..upto).map_or(0, |s| s.matches(ch).count());
    let opening = count('(', cut);
    let mut closing = count(')', cut);
    while opening > closing {
        let Some(offset) = bytes.get(cut..).and_then(|trail| trail.iter().position(|&b| b == b')'))
        else {
            break;
        };
        cut = cut.saturating_add(offset).saturating_add(1);
        closing = closing.saturating_add(1);
    }
    (url.get(..cut).unwrap_or(url), url.get(cut..).unwrap_or_default())
}

// ---- Email addresses

fn is_local(byte: u8) -> bool {
    is_word(byte) || matches!(byte, b'-' | b'.' | b'+')
}

fn is_label(byte: u8) -> bool {
    is_word(byte) || byte == b'-'
}

/// Where the domain of an address ends: a label, then one or more dot and label.
fn domain_end(bytes: &[u8], from: usize) -> Option<usize> {
    let run =
        |at: usize| bytes.get(at..).map_or(0, |s| s.iter().take_while(|&&b| is_label(b)).count());
    let first = run(from);
    if first == 0 {
        return None;
    }
    let mut end = from.saturating_add(first);
    let mut dots = 0_usize;
    while bytes.get(end) == Some(&b'.') {
        let next = run(end.saturating_add(1));
        if next == 0 {
            break;
        }
        end = end.saturating_add(1).saturating_add(next);
        dots = dots.saturating_add(1);
    }
    (dots > 0).then_some(end)
}

fn emails_in(value: &str, budget: &Budget) -> Option<Vec<Node>> {
    let bytes = value.as_bytes();
    let mut pieces = Pieces::new(value);
    let mut at = 0_usize;
    // Where the run of local-part characters holding `at` ends, and the domain
    // read after the `@` that ends it: a start inside one run shares both.
    let mut run_end = 0_usize;
    let mut domain: Option<(usize, Option<usize>)> = None;
    while let Some(&byte) = bytes.get(at) {
        if !is_local(byte) {
            at = at.saturating_add(1);
            continue;
        }
        if at >= run_end {
            let run = bytes.get(at..).map_or(0, |s| s.iter().take_while(|&&b| is_local(b)).count());
            run_end = at.saturating_add(run);
        }
        let reaches = bytes.get(run_end) == Some(&b'@') && run_end.saturating_sub(at) <= LOCAL_MAX;
        if reaches && may_start_at(value, at, true) {
            let after_at = run_end.saturating_add(1);
            let end = match domain {
                Some((known, end)) if known == after_at => end,
                _ => {
                    let end = domain_end(bytes, after_at);
                    let read = end.unwrap_or(after_at).saturating_sub(after_at);
                    if !budget.spend((read / 4).saturating_add(1)) {
                        return None;
                    }
                    domain = Some((after_at, end));
                    end
                }
            };
            // A domain that ends in a hyphen, a digit or an underscore is not one.
            if let Some(end) = end
                && let Some(shown) = value.get(at..end)
                && bytes
                    .get(end.saturating_sub(1))
                    .is_some_and(|&b| !(b == b'-' || b == b'_' || b.is_ascii_digit()))
            {
                pieces.push(at, end, vec![link(&format!("mailto:{shown}"), shown)]);
                at = end;
                continue;
            }
        }
        at = at.saturating_add(1);
    }
    pieces.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    // On wasm32 the same tests run under Node (QR-21 layer 3).
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// The pieces a text becomes, as `text` or `url|shown`, or nothing when it is left alone.
    fn pieces(find: Finder, value: &str) -> Vec<String> {
        let budget = Budget::new(usize::MAX);
        find(value, &budget)
            .into_iter()
            .flatten()
            .map(|node| match node {
                Node::Text(t) => t.value,
                Node::Link(l) => match l.children.first() {
                    Some(Node::Text(t)) => format!("{}|{}", l.url, t.value),
                    _ => String::new(),
                },
                _ => String::new(),
            })
            .collect()
    }

    #[test]
    fn a_domain_is_read_to_256_characters_and_the_rest_is_the_path() {
        // Past the cap the underscore is in the path, so the domain is whole.
        let rest = "a".repeat(300);
        let text = format!(" www.{rest}_.com");
        let shown = format!("www.{rest}_.com");
        assert_eq!(pieces(urls_in, &text), [" ".to_string(), format!("http://{shown}|{shown}")]);
        // Inside it the underscore spoils the second last label.
        let near = "a".repeat(200);
        assert!(pieces(urls_in, &format!(" www.{near}_.com")).is_empty());
    }

    #[test]
    fn a_path_is_read_to_2048_characters() {
        let text = format!(" http://a.b/{}", "x".repeat(2_049));
        let shown = format!("http://a.b/{}", "x".repeat(2_047));
        assert_eq!(
            pieces(urls_in, &text),
            [" ".to_string(), format!("{shown}|{shown}"), "xx".to_string()]
        );
    }

    #[test]
    fn a_local_part_is_read_to_256_characters() {
        let local = "a".repeat(256);
        assert_eq!(
            pieces(emails_in, &format!(" {local}@c.de")),
            [" ".to_string(), format!("mailto:{local}@c.de|{local}@c.de")]
        );
        assert!(pieces(emails_in, &format!(" {}@c.de", "a".repeat(257))).is_empty());
        // A start after a dot is inside the cap.
        let long = format!("{}.b@c.de", "a".repeat(300));
        let found = pieces(emails_in, &format!(" {long}"));
        assert_eq!(found.last().map(String::as_str), Some("mailto:b@c.de|b@c.de"));
        assert_eq!(
            found.first().map(String::as_str),
            Some(format!(" {}.", "a".repeat(300)).as_str())
        );
    }

    #[test]
    fn a_match_after_a_character_outside_the_basic_plane_is_refused() {
        assert!(pieces(urls_in, "😀www.a.b").is_empty());
        assert!(pieces(urls_in, "😀http://a.b").is_empty());
        assert!(pieces(emails_in, "😀a@b.co").is_empty());
        assert_eq!(
            pieces(urls_in, "。www.a.b"),
            ["。".to_string(), "http://www.a.b|www.a.b".to_string()]
        );
    }

    #[test]
    fn white_space_and_punctuation_start_a_match_and_letters_do_not() {
        assert!(pieces(urls_in, "xwww.a.b").is_empty());
        assert!(pieces(urls_in, "xhttp://a.b").is_empty());
        assert_eq!(pieces(urls_in, "\u{a0}www.a.b").len(), 2);
        assert_eq!(pieces(urls_in, "$www.a.b").len(), 2);
        assert_eq!(pieces(urls_in, "\u{3000}www.a.b").len(), 2);
        assert!(pieces(emails_in, "/a@b.co").is_empty());
        assert_eq!(pieces(emails_in, "\u{2029}a@b.co").len(), 2);
        // The start of the text is a start; a start after a slash is not one for an email.
        assert_eq!(pieces(emails_in, "a@b.co").len(), 1);
    }

    #[test]
    fn the_protocol_is_http_or_https_in_any_case_or_www_before_a_dot() {
        assert_eq!(
            pieces(urls_in, " HtTpS://a.b"),
            [" ".to_string(), "HtTpS://a.b|HtTpS://a.b".to_string()]
        );
        assert_eq!(
            pieces(urls_in, " http://a.b"),
            [" ".to_string(), "http://a.b|http://a.b".to_string()]
        );
        assert_eq!(
            pieces(urls_in, " WwW.a.b"),
            [" ".to_string(), "http://WwW.a.b|WwW.a.b".to_string()]
        );
        assert!(pieces(urls_in, " httpx://a.b").is_empty());
        assert!(pieces(urls_in, " http:/a.b").is_empty());
        assert!(pieces(urls_in, " https:/a.b").is_empty());
        assert!(pieces(urls_in, " ww.a.b").is_empty());
        assert!(pieces(urls_in, " wwwa.b").is_empty());
        assert!(pieces(urls_in, " http://").is_empty());
        assert!(pieces(urls_in, " http://?x").is_empty());
    }

    #[test]
    fn a_domain_needs_two_labels_and_a_letter_or_digit_in_each_of_the_last_two() {
        assert!(pieces(urls_in, " http://a").is_empty());
        assert!(pieces(urls_in, " http://a_.b").is_empty());
        assert!(pieces(urls_in, " http://a.b_").is_empty());
        assert!(pieces(urls_in, " http://-.b").is_empty());
        assert!(pieces(urls_in, " http://a.-").is_empty());
        assert_eq!(pieces(urls_in, " http://a-.b1").len(), 2);
        assert!(pieces(urls_in, " http://.").is_empty());
    }

    #[test]
    fn what_ends_a_sentence_is_not_the_url_and_a_paren_is_while_it_is_open() {
        assert_eq!(
            pieces(urls_in, " http://a.b/c)."),
            [" ".to_string(), "http://a.b/c|http://a.b/c".to_string(), ").".to_string()]
        );
        assert_eq!(
            pieces(urls_in, " http://a.b/c(d))."),
            [" ".to_string(), "http://a.b/c(d)|http://a.b/c(d)".to_string(), ").".to_string()]
        );
        assert_eq!(
            pieces(urls_in, " http://a.b/c(d)."),
            [" ".to_string(), "http://a.b/c(d)|http://a.b/c(d)".to_string(), ".".to_string()]
        );
        assert_eq!(
            pieces(urls_in, " http://a.b/c(d(e)."),
            [" ".to_string(), "http://a.b/c(d(e)|http://a.b/c(d(e)".to_string(), ".".to_string()]
        );
        assert_eq!(
            pieces(urls_in, " http://a.b/(c).)"),
            [" ".to_string(), "http://a.b/(c)|http://a.b/(c)".to_string(), ".)".to_string()]
        );
        for trail in ["!", "\"", "&", "'", ",", ":", ";", "<", ">", "?", "]", "}"] {
            let found = pieces(urls_in, &format!(" http://a.b/c{trail}"));
            assert_eq!(found.last(), Some(&trail.to_string()), "{trail}");
        }
        assert_eq!(pieces(urls_in, " http://a.b/c*").len(), 2);
        assert_eq!(
            pieces(urls_in, " http://a.b/c*"),
            [" ".to_string(), "http://a.b/c*|http://a.b/c*".to_string()]
        );
        assert_eq!(pieces(urls_in, " http://a.b.").last().map(String::as_str), Some("."));
        assert!(pieces(urls_in, " http://.,").is_empty());
    }

    #[test]
    fn a_url_ends_at_white_space_and_reads_other_characters_into_its_path() {
        for stop in [' ', '\t', '\r', '\n'] {
            let found = pieces(urls_in, &format!(" http://a.b/c{stop}d"));
            assert_eq!(found.last(), Some(&format!("{stop}d")), "{stop:?}");
        }
        let found = pieces(urls_in, " http://a.b/c\u{a0}d");
        assert_eq!(found[1], "http://a.b/c\u{a0}d|http://a.b/c\u{a0}d");
    }

    #[test]
    fn matches_follow_each_other_and_the_text_between_is_kept() {
        assert_eq!(
            pieces(urls_in, "&www.a.b and &http://c.d x"),
            [
                "&".to_string(),
                "http://www.a.b|www.a.b".to_string(),
                " and &".to_string(),
                "http://c.d|http://c.d".to_string(),
                " x".to_string()
            ]
        );
        assert!(pieces(urls_in, "nothing to link").is_empty());
    }

    #[test]
    fn an_email_needs_a_domain_of_two_labels_that_ends_in_a_letter() {
        assert_eq!(
            pieces(emails_in, " a@b.co"),
            [" ".to_string(), "mailto:a@b.co|a@b.co".to_string()]
        );
        assert!(pieces(emails_in, " a@b").is_empty());
        assert!(pieces(emails_in, " a@.b").is_empty());
        assert!(pieces(emails_in, " a@b.c1").is_empty());
        assert!(pieces(emails_in, " a@b.c-").is_empty());
        assert!(pieces(emails_in, " a@b.c_").is_empty());
        assert_eq!(pieces(emails_in, " a@b.c-d").len(), 2);
        assert_eq!(pieces(emails_in, " +a.b-c@d.ef.").last().map(String::as_str), Some("."));
        assert_eq!(
            pieces(emails_in, " a@b.co.uk"),
            [" ".to_string(), "mailto:a@b.co.uk|a@b.co.uk".to_string()]
        );
        assert!(pieces(emails_in, " @b.co").is_empty());
    }

    #[test]
    fn the_domain_after_an_at_is_read_once_for_every_start_before_it() {
        // Two hundred starts share one local part and one domain that is refused.
        let budget = Budget::new(usize::MAX);
        let text = format!(" {}b@c.d1", "a.".repeat(100));
        assert!(emails_in(&text, &budget).is_none());
        assert_eq!(budget.spent(), 2);
    }

    #[test]
    fn each_at_has_its_own_domain() {
        assert_eq!(
            pieces(emails_in, " a@b.d1 c@e.fg"),
            [" a@b.d1 ".to_string(), "mailto:c@e.fg|c@e.fg".to_string()]
        );
    }

    #[test]
    fn an_empty_or_unmatched_text_is_left_alone() {
        assert!(pieces(urls_in, "").is_empty());
        assert!(pieces(emails_in, "").is_empty());
        assert!(pieces(emails_in, "@").is_empty());
    }

    #[test]
    fn text_under_a_link_is_left_alone_and_the_second_pass_reads_the_pieces_of_the_first() {
        let mut root = Node::Root(crate::mdast::Root {
            children: vec![Node::Paragraph(crate::mdast::Paragraph {
                children: vec![
                    link("u", "www.a.b"),
                    text(" www.c.d a@b.co"),
                    Node::Emphasis(crate::mdast::Emphasis {
                        children: vec![text(" a@e.fg")],
                        position: None,
                    }),
                ],
                position: None,
            })],
            position: None,
        });
        link_literals(&mut root, &Budget::new(usize::MAX));
        let Some(Node::Paragraph(paragraph)) = root.children().and_then(|c| c.first()) else {
            return;
        };
        let shown: Vec<String> = paragraph
            .children
            .iter()
            .map(|n| match n {
                Node::Text(t) => t.value.clone(),
                Node::Link(l) => l.url.clone(),
                Node::Emphasis(e) => format!("em({})", e.children.len()),
                _ => String::new(),
            })
            .collect();
        assert_eq!(shown, ["u", " ", "http://www.c.d", " ", "mailto:a@b.co", "em(2)"]);
    }

    #[test]
    fn a_text_is_charged_for_and_an_exhausted_budget_stops_the_pass() {
        let budget = Budget::new(0);
        let mut root = Node::Root(crate::mdast::Root {
            children: vec![Node::Paragraph(crate::mdast::Paragraph {
                children: vec![text(" www.a.b")],
                position: None,
            })],
            position: None,
        });
        link_literals(&mut root, &budget);
        assert_eq!(budget.refusal(), Some(crate::Refusal::TooCostly));
        let spent = Budget::new(usize::MAX);
        let mut again = Node::Root(crate::mdast::Root {
            children: vec![Node::Paragraph(crate::mdast::Paragraph {
                children: vec![text("x".repeat(400).as_str())],
                position: None,
            })],
            position: None,
        });
        link_literals(&mut again, &spent);
        // 400 bytes are a hundred units a pass, and a pass has one more.
        assert_eq!(spent.spent(), 2 * 101);
    }
}
