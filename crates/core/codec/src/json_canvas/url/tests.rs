use super::{can_parse, zod_url_valid};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn all(urls: &[&str], expected: bool) {
    for url in urls {
        assert_eq!(can_parse(url), expected, "{url:?}");
    }
}

// Every list below was checked against Node's `URL.canParse`.

#[test]
fn an_ipv6_literal_is_parsed_by_the_whatwg_grammar() {
    all(
        &[
            "http://[::1]/",
            "http://[::1]:8080/",
            "http://[::1]:/",
            "http://[1:2:3:4:5:6:7:8]/",
            "http://[1:2:3:4:5:6:7::]/",
            "http://[::ffff:192.168.0.1]/",
            "http://[1:2:3:4:5:6:1.2.3.4]/",
            "http://[1::1.2.3.4]/",
            "http://[::1.2.3.0]/",
            "http://u@[::1]/",
            "foo://[::1]",
            "foo://[::1]:80/",
        ],
        true,
    );
}

#[test]
fn a_malformed_ipv6_literal_fails() {
    all(
        &[
            "http://[1:2:3:4:5:1.2.3.4]/",
            "http://[1:1.2.3.4]/",
            "http://[::1:]/",
            "http://[::.1.2.3]/",
            "http://[::1/",
            "http://[1:2:3:4:5:6:7:8:9]/",
            "http://[1:2:3:4:5:6:7:8::]/",
            "http://[1:2:3:4:5:6:7]/",
            "http://[::1::2]/",
            "http://[1::2::]/",
            "http://[12345::]/",
            "http://[::1]x/",
            "http://[::1]:99999/",
            "http://[::1]:8a/",
            "http://[::1.2.3.256]/",
            "http://[::01.2.3.4]/",
            "http://[::1.2.3.04]/",
            "http://[::1.2.3]/",
            "http://[::1.2.3.4.5]/",
            "http://[::1.2..4]/",
            "http://[::1a.2.3.4]/",
            "http://[1:2:3:4:5:6:7:1.2.3.4]/",
            "http://[:1]/",
            "http://[1:]/",
            "http://[]/",
            "http://[::g]/",
            "foo://[::1]x",
            "foo://[zz]",
            "foo://a[b",
            "http://a[b/",
        ],
        false,
    );
}

#[test]
fn a_percent_encoded_host_is_decoded_before_it_is_judged() {
    all(&["http://ex%41mple.com/", "http://1.2.3.4%2e/", "http://a%2e%2e/", "foo://ex%41/"], true);
    all(
        &[
            "http://ex%20ample.com/",
            "http://%FF/",
            "http://%zz/",
            "http://ex%2/",
            "http://a%2Fb/",
            "http://%00/",
            "http://%7F/",
            "http://%25/",
            "http://%41%25/",
        ],
        false,
    );
}

#[test]
fn an_international_host_is_accepted_without_the_uts_46_tables() {
    all(
        &[
            "https://\u{4f8b}\u{3048}.jp/",
            "https://xn--r8jz45g.jp/",
            "http://\u{ff41}.com",
            "http://\u{ff01}.com/",
            "http://a\u{200b}c.com/",
            "http://a\u{ad}.com/",
        ],
        true,
    );
    all(
        &["https://a<b.jp/", "https://ex\u{7f}a.com", "http://xn--a.1/", "http://\u{e9}\u{e9}.1/"],
        false,
    );
}

/// Accepted here, refused by the host: UTS 46 maps these to a forbidden or
/// empty host, and the tables to see that are not carried.
#[test]
fn the_documented_deviations_accept_what_uts_46_would_refuse() {
    all(
        &[
            "http://\u{ad}/",
            "http://\u{a0}.com",
            "http://\u{ff1a}.com",
            "http://\u{ff05}\u{ff14}\u{ff11}.com",
            "http://a\u{fffd}.com",
        ],
        true,
    );
}

#[test]
fn a_file_url_has_a_host_a_drive_letter_or_neither() {
    all(
        &[
            "file:///C:/x",
            "file://C:/x",
            "file://C|/x",
            "file://server/share",
            "file:notes.md",
            "file:C:/x",
            "file:/x",
            "file:/C:/x",
            "file:///",
            "file://",
            "file:///%",
            "file:\\\\server\\x",
            "file://localhost/x",
            "file://1.2.3.4/x",
            "file://1/x",
            "file://[::1]/x",
            "file://ex%41/x",
            "file://\u{4f8b}.jp/",
        ],
        true,
    );
    all(
        &[
            "file://a b/",
            "file://1.2.3.256/x",
            "file://a<b/x",
            "file://%FF/x",
            "file://a:80/x",
            "file://a:b/x",
            "file://u@h/x",
            "file://@/x",
            "file://:80/x",
            "file://a%20b/",
            "file://c%3A/x",
            "file://[::1/x",
        ],
        false,
    );
}

#[test]
fn the_text_is_trimmed_and_stripped_before_it_is_judged() {
    assert!(zod_url_valid("\u{a0} http://[::1]\t:80/ "));
    assert!(!zod_url_valid("nonsense"));
}
