//! Where the tree this parser builds had to be bent to the one the
//! TypeScript parser builds. Each case is a minimal input and the model tree
//! `parseMarkdownBody` answers for it (the recorded oracle holds the same
//! differences at corpus scale); each failed before its fix.

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

fn paragraph(inner: &str) -> String {
    format!(r#"{{"children":[{{"children":[{inner}],"type":"paragraph"}}],"type":"root"}}"#)
}

fn text(value: &str) -> String {
    format!(r#"{{"type":"text","value":{value:?}}}"#)
}

fn item(inner: &str) -> String {
    format!(
        r#"{{"children":[{{"checked":null,"children":[{inner}],"spread":false,"type":"listItem"}}],"ordered":false,"spread":false,"type":"list"}}"#
    )
}

#[test]
fn a_nul_reads_as_the_replacement_character() {
    assert_eq!(model("\0x"), paragraph(&text("\u{FFFD}x")));
    assert_eq!(model("\0x\n"), paragraph(&text("\u{FFFD}x")));
}

#[test]
fn a_last_line_that_starts_a_construct_still_continues_a_paragraph_lazily() {
    let expected = format!(
        r#"{{"children":[{}],"type":"root"}}"#,
        item(&format!(r#"{{"children":[{}],"type":"paragraph"}}"#, text("a\n**")))
    );
    for last in ["**", "~", "$"] {
        assert_eq!(model(&format!("- a\n{last}")), expected.replace("**", last), "{last}");
        assert_eq!(model(&format!("- a\n{last}\n")), expected.replace("**", last), "{last}");
    }
}

#[test]
fn a_line_ending_at_an_edge_of_code_text_is_stripped_like_a_space() {
    assert_eq!(model("``\nfoo\n``"), paragraph(r#"{"type":"inlineCode","value":"foo"}"#));
    assert_eq!(model("`` a\n``"), paragraph(r#"{"type":"inlineCode","value":"a"}"#));
    assert_eq!(model("$\nx\n$"), paragraph(r#"{"type":"inlineMath","value":"x"}"#));
}

#[test]
fn a_reference_is_named_by_its_label_as_written() {
    assert_eq!(
        model("[*foo* bar]\n\n[*foo* bar]: /u"),
        concat!(
            r#"{"children":[{"children":[{"children":[{"children":[{"type":"text","value":"foo"}],"type":"emphasis"},"#,
            r#"{"type":"text","value":" bar"}],"identifier":"*foo* bar","label":"*foo* bar","referenceType":"shortcut","type":"linkReference"}],"type":"paragraph"},"#,
            r#"{"identifier":"*foo* bar","label":"*foo* bar","type":"definition","url":"/u"}],"type":"root"}"#
        )
    );
}

#[test]
fn an_identifier_keeps_the_single_space_between_its_words() {
    assert_eq!(
        model("[Foo\n  bar]: /u"),
        r#"{"children":[{"identifier":"foo bar","label":"Foo\n  bar","type":"definition","url":"/u"}],"type":"root"}"#
    );
}

#[test]
fn an_image_alt_counts_the_alt_of_an_image_inside_it() {
    assert_eq!(model("![a ![b](/u)](/v)"), paragraph(r#"{"alt":"a b","type":"image","url":"/v"}"#));
}

#[test]
fn a_literal_autolink_inside_a_link_is_its_text() {
    assert_eq!(
        model("[https://x.y](https://x.y)"),
        paragraph(
            r#"{"children":[{"type":"text","value":"https://x.y"}],"type":"link","url":"https://x.y"}"#
        )
    );
}

#[test]
fn a_list_item_is_not_spread_by_the_blank_lines_it_ends_on() {
    let expected = format!(
        r#"{{"children":[{},{{"children":[{}],"type":"paragraph"}}],"type":"root"}}"#,
        item(&format!(r#"{{"children":[{}],"type":"paragraph"}}"#, text("a"))),
        text("b")
    );
    assert_eq!(model("- a\n\n  \nb"), expected);
    assert_eq!(model("- a\n\n\nb"), expected);
}

#[test]
fn a_run_of_hashes_that_is_not_the_closing_sequence_is_text() {
    let heading = |depth: u8, value: &str| {
        format!(
            r#"{{"children":[{{"children":[{}],"depth":{depth},"type":"heading"}}],"type":"root"}}"#,
            text(value)
        )
    };
    assert_eq!(model("# # x"), heading(1, "# x"));
    assert_eq!(model("## a ## b"), heading(2, "a ## b"));
    assert_eq!(model("# a #"), heading(1, "a"));
}

#[test]
fn what_a_container_prefix_leaves_of_a_tab_is_kept_as_spaces_or_dropped_as_indent() {
    assert_eq!(
        model(">\t\tfoo"),
        r#"{"children":[{"children":[{"type":"code","value":"  foo"}],"type":"blockquote"}],"type":"root"}"#
    );
    assert_eq!(
        model("- \n\ta"),
        format!(
            r#"{{"children":[{}],"type":"root"}}"#,
            item(&format!(r#"{{"children":[{}],"type":"paragraph"}}"#, text("a")))
        )
    );
}

#[test]
fn a_label_is_decoded_but_its_identifier_is_not() {
    assert_eq!(
        model("[a&amp;b &#35; &bogus;]: /u"),
        r#"{"children":[{"identifier":"a&amp;b &#35; &bogus;","label":"a&b # &bogus;","type":"definition","url":"/u"}],"type":"root"}"#
    );
    assert_eq!(
        model(r"[a\*b]: /u"),
        r#"{"children":[{"identifier":"a\\*b","label":"a*b","type":"definition","url":"/u"}],"type":"root"}"#
    );
}

#[test]
fn a_reference_in_a_label_decodes_only_when_it_is_whole() {
    assert_eq!(
        model("[a&amp b &aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; &#x41; &#X42; &#;]: /u"),
        r#"{"children":[{"identifier":"a&amp b &aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; &#x41; &#x42; &#;","label":"a&amp b &aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; A B &#;","type":"definition","url":"/u"}],"type":"root"}"#
    );
}
