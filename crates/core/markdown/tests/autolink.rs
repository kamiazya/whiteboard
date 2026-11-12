//! The literal autolinks remark finds in finished text, which the tokenizer
//! leaves: after an entity here, so the second pass is the one that links.
//! Each case is the model tree `parseMarkdownBody` answers for it.

#[path = "common/model.rs"]
mod model;

use whiteboard_markdown::parse;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn model(text: &str) -> String {
    parse(text)
        .map_or_else(|refusal| format!("refused: {refusal:?}"), |root| model::canonical(&root))
}

fn paragraph(inner: &[String]) -> String {
    format!(
        r#"{{"children":[{{"children":[{}],"type":"paragraph"}}],"type":"root"}}"#,
        inner.join(",")
    )
}

fn t(value: &str) -> String {
    format!(r#"{{"type":"text","value":{value:?}}}"#)
}

fn l(url: &str, shown: &str) -> String {
    format!(r#"{{"children":[{{"type":"text","value":{shown:?}}}],"type":"link","url":{url:?}}}"#)
}

#[test]
fn a_url_after_an_entity_is_linked_with_its_trailing_punctuation_left_out() {
    assert_eq!(model("&amp;www.a.b"), paragraph(&[t("&"), l("http://www.a.b", "www.a.b")]));
    assert_eq!(
        model("&amp;HTTPS://A.B/c);"),
        paragraph(&[t("&"), l("HTTPS://A.B/c", "HTTPS://A.B/c"), t(");")])
    );
    assert_eq!(
        model("&amp;http://a.b/c(d))."),
        paragraph(&[t("&"), l("http://a.b/c(d)", "http://a.b/c(d)"), t(").")])
    );
    assert_eq!(
        model("&amp;http://a.b)))"),
        paragraph(&[t("&"), l("http://a.b", "http://a.b"), t(")))")])
    );
    assert_eq!(
        model("&amp;http://a.b/c\"d&"),
        paragraph(&[t("&"), l("http://a.b/c\"d&", "http://a.b/c\"d&")])
    );
    assert_eq!(model("&amp;www."), paragraph(&[t("&"), l("http://www", "www"), t(".")]));
}

#[test]
fn a_url_with_no_valid_domain_is_text() {
    for text in ["&amp;www.a_b.com", "&amp;www.a.b_", "&amp;http://", "&amp;http://."] {
        let expected = text.replace("&amp;", "&");
        assert_eq!(model(text), paragraph(&[t(&expected)]), "{text}");
    }
}

#[test]
fn an_email_after_an_entity_is_linked_unless_its_domain_ends_wrongly_or_a_slash_comes_before() {
    assert_eq!(model("&amp;a@b.co."), paragraph(&[t("&"), l("mailto:a@b.co", "a@b.co"), t(".")]));
    assert_eq!(model("&amp;+a@b.co"), paragraph(&[t("&"), l("mailto:+a@b.co", "+a@b.co")]));
    assert_eq!(
        model("&amp;x@y.co z@w.io"),
        paragraph(&[t("&"), l("mailto:x@y.co", "x@y.co"), t(" "), l("mailto:z@w.io", "z@w.io")])
    );
    for text in ["&amp;a@b.c1", "&amp;a@b", "&amp;/a@b.co"] {
        assert_eq!(model(text), paragraph(&[t(&text.replace("&amp;", "&"))]), "{text}");
    }
}

#[test]
fn nothing_is_linked_after_a_character_outside_the_basic_plane() {
    assert_eq!(model("&amp;😀www.a.b"), paragraph(&[t("&😀www.a.b")]));
}

#[test]
fn the_text_of_a_link_is_not_read_again() {
    assert_eq!(model("&amp;[a@b.co](u)"), paragraph(&[t("&"), l("u", "a@b.co")]));
}

#[test]
fn a_domain_is_read_to_256_characters() {
    let rest = "a".repeat(300);
    let shown = format!("www.{rest}_.com");
    assert_eq!(
        model(&format!("&amp;www.{rest}_.com")),
        paragraph(&[t("&"), l(&format!("http://{shown}"), &shown)])
    );
}
