//! The frontmatter subset by example: what the reader reads, what it refuses
//! and by which class, and what the writer spells. The TypeScript twin is
//! `frontmatter-subset.test.ts`; the recorded oracle holds the two to the same
//! answers over a generated corpus, and these say what each one means.

use whiteboard_codec::frontmatter::{
    Fault, MAX_BYTES, MAX_DEPTH, MAX_FAULT_BYTES, MAX_PARSE_DEPTH, Refusal, Step, Unwritable,
    Value, parse, stringify,
};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn s(text: &str) -> Value {
    Value::String(text.to_string())
}

fn n(x: f64) -> Value {
    Value::Number(x)
}

fn map(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect())
}

fn read(text: &str) -> Value {
    let read = parse(text);
    assert!(read.is_ok(), "{text:?} is refused: {read:?}");
    read.unwrap_or(Value::Null)
}

fn class(text: &str) -> &'static str {
    let read = parse(text);
    assert!(read.is_err(), "{text:?} is read as {read:?}");
    match read {
        Err(Refusal::Syntax(_)) => "syntax",
        Err(Refusal::Anchor) => "anchor",
        Err(Refusal::Depth) => "depth",
        Err(Refusal::Subset(_)) => "subset",
        Err(Refusal::TooLarge) => "too large",
        Ok(_) => "",
    }
}

fn write(value: &Value) -> String {
    let written = stringify(value);
    assert!(written.is_ok(), "{value:?} is unwritable: {written:?}");
    written.unwrap_or_default()
}

#[test]
fn the_core_schema_decides_what_a_plain_scalar_is() {
    let text = "a: true\nb: False\nc: ~\nd: null\ne: 0o17\nf: 0x1F\ng: -12\nh: +3\ni: .5\nj: 1.\nk: 1e3\nl: -.inf\nm: 12:30\nn: yes\no: 1_000\np: \"1\"";
    let value = read(text);
    assert!(matches!(value, Value::Map(_)), "not a mapping");
    let Value::Map(entries) = value else { return };
    let by =
        |key: &str| entries.iter().find(|(k, _)| k == key).map_or(Value::Null, |(_, v)| v.clone());
    assert_eq!(by("a"), Value::Bool(true));
    assert_eq!(by("b"), Value::Bool(false));
    assert_eq!(by("c"), Value::Null);
    assert_eq!(by("d"), Value::Null);
    assert_eq!(by("e"), n(15.0));
    assert_eq!(by("f"), n(31.0));
    assert_eq!(by("g"), n(-12.0));
    assert_eq!(by("h"), n(3.0));
    assert_eq!(by("i"), n(0.5));
    assert_eq!(by("j"), n(1.0));
    assert_eq!(by("k"), n(1000.0));
    assert_eq!(by("l"), n(f64::NEG_INFINITY));
    assert_eq!(by("m"), s("12:30"));
    assert_eq!(by("n"), s("yes"));
    assert_eq!(by("o"), s("1_000"));
    assert_eq!(by("p"), s("1"));
}

#[test]
fn an_integer_past_2_pow_53_is_kept_as_written_unless_the_double_prints_the_same() {
    assert_eq!(
        read("a: 9007199254740993"),
        map(&[("a", Value::BigInt("9007199254740993".into()))])
    );
    assert_eq!(
        read("a: -9007199254740993"),
        map(&[("a", Value::BigInt("-9007199254740993".into()))])
    );
    assert_eq!(
        read("a: 0x20000000000001"),
        map(&[("a", Value::BigInt("9007199254740993".into()))])
    );
    assert_eq!(
        read("a: 0o400000000000000001"),
        map(&[("a", Value::BigInt("9007199254740993".into()))])
    );
    assert_eq!(read("a: 9007199254740992"), map(&[("a", n(9_007_199_254_740_992.0))]));
    assert_eq!(read("a: 9007199254740991"), map(&[("a", n(9_007_199_254_740_991.0))]));
    // The digits JavaScript prints for the nearest double read back as that double.
    assert_eq!(read("a: 12345678901234567000"), map(&[("a", n(12_345_678_901_234_567_000.0))]));
    assert_eq!(read("a: 1e20"), map(&[("a", n(1e20))]));
    assert_eq!(read("a: 9007199254740993.0"), map(&[("a", n(9_007_199_254_740_992.0))]));
}

#[test]
fn a_radix_integer_rounds_to_the_nearest_double_ties_to_even() {
    // 2^53 + 1 is a tie between 2^53 and 2^53 + 2: even mantissa wins.
    assert_eq!(
        read("a: 0x20000000000001"),
        map(&[("a", Value::BigInt("9007199254740993".into()))])
    );
    assert_eq!(
        read("a: 0x20000000000003"),
        map(&[("a", Value::BigInt("9007199254740995".into()))])
    );
    // Past the tie the sticky bits decide.
    assert_eq!(
        read("a: 0x20000000000011"),
        map(&[("a", Value::BigInt("9007199254741009".into()))])
    );
    assert_eq!(read("a: 0x1fffffffffffff"), map(&[("a", n(9_007_199_254_740_991.0))]));
    assert_eq!(read("a: 0x0000"), map(&[("a", n(0.0))]));
    let huge = format!("a: 0x{}", "f".repeat(260));
    assert_eq!(read(&huge), map(&[("a", n(f64::INFINITY))]));
}

#[test]
fn keys_are_the_strings_javascript_makes_of_them() {
    let value = read("1: a\n1.5: b\ntrue: c\n~: d\n0x10: e\n9007199254740993: f");
    assert!(matches!(value, Value::Map(_)), "not a mapping");
    let Value::Map(entries) = value else { return };
    let keys: Vec<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["1", "1.5", "true", "", "16", "9007199254740993"]);
    // A quoted key and a plain one that spell the same string are different
    // keys to the schema and one key to JavaScript: the later value wins.
    assert_eq!(read("1: x\n\"1\": y"), map(&[("1", s("y"))]));
    assert_eq!(read("1: x\ntrue: y\n\"1\": z"), map(&[("1", s("z")), ("true", s("y"))]));
}

#[test]
fn a_flow_mapping_key_can_span_lines() {
    assert_eq!(read("x: {a\n  b: 1}"), map(&[("x", map(&[("a b", n(1.0))]))]));
}

#[test]
fn quoted_scalars_read_their_escapes_and_fold_their_lines() {
    assert_eq!(read(r#"a: "x\ny\u0001\x85""#), map(&[("a", s("x\ny\u{1}\u{85}"))]));
    assert_eq!(
        read(r#"a: "\0\a\b\t\v\f\r\e\ \"\/\\\N\_\L\P""#),
        map(&[("a", s("\0\u{7}\u{8}\t\u{b}\u{c}\r\u{1b} \"/\\\u{85}\u{a0}\u{2028}\u{2029}"))])
    );
    assert_eq!(read("a: 'it''s'"), map(&[("a", s("it's"))]));
    assert_eq!(read("a: \"one\n  two\""), map(&[("a", s("one two"))]));
    assert_eq!(read("a: \"one\n\n  two\""), map(&[("a", s("one\ntwo"))]));
    assert_eq!(read("a: \"one \\\n  two\""), map(&[("a", s("one two"))]));
    assert_eq!(read("a: 'x  \n  y'"), map(&[("a", s("x y"))]));
    assert_eq!(read(r#"a: "\uD83D\uDE00 \U0001F600""#), map(&[("a", s("\u{1f600} \u{1f600}"))]));
    assert_eq!(read(r#"a: "\uD83D\U0000DE00""#), map(&[("a", s("\u{1f600}"))]));
}

#[test]
fn an_unclosed_quote_is_read_as_closed_by_the_last_character_that_is_the_quote() {
    // yaml 2.9 finds a closing quote with indexOf, so a scalar left open
    // parses when its last character is the quote.
    assert_eq!(read("a: '''"), map(&[("a", s("'"))]));
    assert_eq!(read("a: 'x''"), map(&[("a", s("x'"))]));
    assert_eq!(read("a: \"x\\\""), map(&[("a", s("x\""))]));
    assert_eq!(class("a: 'x"), "syntax");
    assert_eq!(class("a: \"x"), "syntax");
    assert_eq!(class("a: '"), "syntax");
    // A continuation line indented too little ends the scalar before it.
    assert_eq!(
        read("k:\n  - 'x'''\ntype: ''"),
        map(&[("k", Value::Seq(vec![s("x'")])), ("type", s(""))])
    );
}

#[test]
fn block_scalars_chomp_and_fold() {
    assert_eq!(
        read("a: |\n  one\n  two\nb: >-\n  folded\n  text\n"),
        map(&[("a", s("one\ntwo\n")), ("b", s("folded text"))])
    );
    assert_eq!(read("a: |2+\n   x\n\n"), map(&[("a", s(" x\n\n"))]));
    assert_eq!(read("a: |-\n  x\n\n"), map(&[("a", s("x"))]));
    assert_eq!(read("a: |\n  x\n\n\nb: 1"), map(&[("a", s("x\n")), ("b", n(1.0))]));
    assert_eq!(
        read("a: >\n  one\n\n  two\n   more\n  three\n"),
        map(&[("a", s("one\ntwo\n more\nthree\n"))])
    );
    assert_eq!(read("a: |+\n  x\n\nb: 1"), map(&[("a", s("x\n\n")), ("b", n(1.0))]));
    assert_eq!(read("|\n#x\ny"), s("#x\ny\n"));
    assert_eq!(read("a: |\n x\n#c\nz: 1"), map(&[("a", s("x\n")), ("z", n(1.0))]));
    assert_eq!(read("a: |\n"), map(&[("a", s(""))]));
}

#[test]
fn comments_and_flow_collections_read() {
    assert_eq!(read("# c\na: 1 # d\n# e"), map(&[("a", n(1.0))]));
    assert_eq!(
        read("a: [1, {b: c}, [d]]\ne: {f: [g], h}"),
        map(&[
            ("a", Value::Seq(vec![n(1.0), map(&[("b", s("c"))]), Value::Seq(vec![s("d")])])),
            ("e", map(&[("f", Value::Seq(vec![s("g")])), ("h", Value::Null)])),
        ])
    );
    assert_eq!(read("b: [\n]"), map(&[("b", Value::Seq(vec![]))]));
    assert_eq!(
        read("x: {a: 1, b: #x\n}"),
        map(&[("x", map(&[("a", n(1.0)), ("b", Value::Null)]))])
    );
    assert_eq!(read("a: 1\r\nb: 2"), map(&[("a", n(1.0)), ("b", n(2.0))]));
    assert_eq!(read(""), Value::Null);
    assert_eq!(read("# only a comment"), Value::Null);
}

#[test]
fn the_long_explicit_key_yaml_writes_is_read() {
    let long = "k".repeat(1025);
    assert_eq!(read(&format!("? {long}\n: 1")), map(&[(&long, n(1.0))]));
    assert_eq!(read(&format!("? \"{long}\"\n: 1")), map(&[(&long, n(1.0))]));
    assert_eq!(read(&format!("? {long}")), map(&[(&long, Value::Null)]));
    assert_eq!(read(&format!("? {long}\n:\n  - a")), map(&[(&long, Value::Seq(vec![s("a")]))]));
    // An indicator followed by a non-blank starts a plain scalar, so a long
    // key may begin with one; the writer emits these as they are.
    for start in ["?!", "-x", ":x"] {
        let key = format!("{start}{long}");
        assert_eq!(read(&format!("? {key}\n: 1")), map(&[(&key, n(1.0))]), "{start}");
        assert_eq!(
            read(&format!("a:\n  - ? {key}\n    : 1")),
            map(&[("a", Value::Seq(vec![map(&[(&key, n(1.0))])]))]),
            "{start} in a list"
        );
    }
    // Followed by a blank they are a nested explicit key and a list as a key:
    // collection keys, outside the subset as the TypeScript says.
    assert_eq!(class(&format!("? ? {long}\n: 1")), "subset");
    assert_eq!(class(&format!("? - {long}\n: 1")), "subset");
}

#[test]
fn the_subset_refuses_by_class() {
    for text in [
        "a: !foo x",
        "a: !!str 1",
        "a: !!map\n  b: 1",
        "a:\n  - !!str 1",
        "a: !<tag:yaml.org,2002:str> x",
    ] {
        assert_eq!(class(text), "subset", "{text:?}");
    }
    for text in ["---\na: 1", "a: 1\n...", "a: 1\n--- b", "%YAML 1.2\n---\na: 1", "%YAML 1.2\na: 1"]
    {
        assert_eq!(class(text), "subset", "{text:?}");
    }
    for text in [
        "\u{feff}a: 1",
        "a: \"x\u{feff}y\"",
        "a: 1\rb: 2",
        "a: \"x\u{0}y\"",
        "a: x\u{7}y",
        "a:\n\tb: 1",
        "a: [1,\n\t2]",
        "a: x\n\ty",
        "a: |\n  x\n\ty",
    ] {
        assert_eq!(class(text), "subset", "{text:?}");
    }
    for text in
        ["? [a, b]\n: 1", "? {a: 1}\n: 1", "[a, b]: 1", "{a: 1}: 1", "? - a\n: 1", "{[a]: 1}"]
    {
        assert_eq!(class(text), "subset", "{text:?}");
    }
    for text in ["a: [b: 1]", "a: [? b]", "a: {? b : 1}", ": x", "a:\n  : x", "{: 1}"] {
        assert_eq!(class(text), "subset", "{text:?}");
    }
    let key_1024 = "k".repeat(1024);
    assert_eq!(class("? a\n: 1"), "subset");
    assert_eq!(class(&format!("? {key_1024}\n: 1")), "subset");
    assert_eq!(class(&format!("? \"{}\"\n: 1", "k".repeat(1022))), "subset");
    assert!(parse(&format!("? \"{}\"\n: 1", "k".repeat(1023))).is_ok());
    assert_eq!(class("? \n  a\n: 1"), "subset");
}

#[test]
fn c1_controls_are_read_only_inside_double_quotes() {
    assert_eq!(read("a: \"x\u{85}y\""), map(&[("a", s("x\u{85}y"))]));
    for text in [
        "a: x\u{85}y",
        "a: 'x\u{85}y'",
        "a: |\n  x\u{85}y",
        "a: x\u{7f}y",
        "# c\u{85}\na: 1",
        "a: 1 # c\u{9f}",
    ] {
        assert_eq!(class(text), "subset", "{text:?}");
    }
}

#[test]
fn a_lone_surrogate_has_no_reading() {
    for text in [
        r#"a: "\uD800""#,
        r#"a: "\uDC00""#,
        r#"a: "\uDE00\uD83D""#,
        r#""k\uD800": 1"#,
        r#"a: "\U0000D800""#,
    ] {
        assert_eq!(class(text), "subset", "{text:?}");
    }
    assert_eq!(class(r#"a: "\U00110000""#), "syntax");
}

#[test]
fn anchors_aliases_and_depth_are_refused_by_class() {
    for text in ["a: &x 1", "a: *x", "a: &x 1\nb: *x", "&a a: 1", "a: [&x]", "- &x\n- 1"] {
        assert_eq!(class(text), "anchor", "{text:?}");
    }
    let nest = |levels: usize| format!("a: {}1{}", "[".repeat(levels), "]".repeat(levels));
    assert!(parse(&nest(MAX_DEPTH - 1)).is_ok());
    assert_eq!(class(&nest(MAX_DEPTH)), "depth");
    assert_eq!(class(&nest(MAX_PARSE_DEPTH)), "depth");
    assert_eq!(class(&nest(MAX_PARSE_DEPTH + 40)), "depth");
    let blocks = |levels: usize| {
        (0..levels).fold(String::new(), |text, i| text + &" ".repeat(i) + &format!("a{i}:\n"))
            + &" ".repeat(levels)
            + "x"
    };
    assert!(parse(&blocks(MAX_DEPTH)).is_ok());
    assert_eq!(class(&blocks(MAX_DEPTH + 1)), "depth");
}

#[test]
fn a_text_past_the_cap_is_refused_before_it_is_read() {
    let at_cap = format!("a: {}", "x".repeat(MAX_BYTES - 3));
    assert!(parse(&at_cap).is_ok());
    assert_eq!(parse(&format!("{at_cap}x")), Err(Refusal::TooLarge));
}

#[test]
fn malformed_yaml_is_a_syntax_refusal() {
    for text in [
        "a: 1\na: 2",
        "a: 1\n\"a\": 2",
        "1: x\n1.0: y",
        "0x10: x\n16: y",
        "~: x\nnull: y",
        "9007199254740993: x\n9007199254740992: y",
        "a: b: c",
        "a: - b",
        "a: [1, 2",
        "a: {b: 1",
        "a: ]",
        "a: }",
        "a: 1\n  b: 2",
        "a:\n  b: 1\n c: 2",
        "{a\n  b: 1",
        "x: [a\n  b: 1]",
        "a: x\nb: [\n1]",
        "a: \"\\q\"",
        "a: \"\\x4\"",
        "a: |x\n  y",
        "- a\n- b: 1\n  - c",
        "a: 1\n- b",
        "a: ,",
        "a: 1 #c\n#d\nb",
    ] {
        assert_eq!(class(text), "syntax", "{text:?}");
    }
}

#[test]
fn a_tab_after_a_dash_is_a_separator_but_not_before_a_collection() {
    assert_eq!(read("-\tx"), Value::Seq(vec![s("x")]));
    assert_eq!(class("-\t- x"), "syntax");
    assert_eq!(class("a:\n  -\ta: 1"), "syntax");
}

/// `word{from} word{from+1} ... word{to}`.
fn words(from: usize, to: usize) -> String {
    (from..=to).map(|i| format!("word{i}")).collect::<Vec<_>>().join(" ")
}

fn prose() -> String {
    words(0, 39)
}

#[test]
fn writes_block_style_with_yamls_spellings() {
    assert_eq!(
        write(&map(&[("a", n(1.0)), ("b", s("x")), ("c", Value::Null), ("d", Value::Bool(true))])),
        "a: 1\nb: x\nc: null\nd: true"
    );
    assert_eq!(
        write(&map(&[
            ("a", Value::Seq(vec![n(1.0), s("two")])),
            ("b", Value::Seq(vec![])),
            ("c", map(&[]))
        ])),
        "a:\n  - 1\n  - two\nb: []\nc: {}"
    );
    assert_eq!(write(&map(&[("a", map(&[("b", map(&[("c", n(1.0))]))]))])), "a:\n  b:\n    c: 1");
    assert_eq!(
        write(&map(&[(
            "a",
            Value::Seq(vec![
                Value::Seq(vec![n(1.0), n(2.0)]),
                map(&[("b", Value::Seq(vec![]))]),
                s("x"),
                Value::Null
            ])
        )])),
        "a:\n  - - 1\n    - 2\n  - b: []\n  - x\n  - null"
    );
    assert_eq!(
        write(&map(&[
            ("a", n(-0.0)),
            ("b", n(1e21)),
            ("c", n(0.1)),
            ("d", n(123_456_789_012_345_680_000.0)),
            ("e", n(1e-7)),
            ("f", n(5e-324))
        ])),
        "a: -0\nb: 1e+21\nc: 0.1\nd: 123456789012345680000\ne: 1e-7\nf: 5e-324"
    );
    assert_eq!(write(&Value::Null), "null");
    assert_eq!(write(&s("root")), "root");
}

#[test]
fn writes_a_string_that_would_read_as_something_else_quoted() {
    assert_eq!(
        write(&map(&[
            ("a", s("true")),
            ("b", s("1")),
            ("c", s("null")),
            ("d", s("~")),
            ("e", s("0x10")),
            ("f", s("")),
            ("g", s(" x")),
            ("h", s("x ")),
            ("i", s("a: b")),
            ("j", s("# c")),
            ("k", s("- x")),
            ("l", s("?")),
            ("m", s("-"))
        ])),
        "a: \"true\"\nb: \"1\"\nc: \"null\"\nd: \"~\"\ne: \"0x10\"\nf: \"\"\ng: \" x\"\nh: \"x \"\ni: \"a: b\"\nj: \"# c\"\nk: \"- x\"\nl: \"?\"\nm: \"-\""
    );
    assert_eq!(
        write(&map(&[
            ("a", s("x\u{85}y")),
            ("\u{7f}", s("\u{9f}")),
            ("b", s("x\u{1}y\u{1b}")),
            ("c", s("it's")),
            ("d", s("say \"hi\"")),
            ("e", s("both ' and \""))
        ])),
        "a: \"x\u{85}y\"\n\"\u{7f}\": \"\u{9f}\"\nb: \"x\\u0001y\\u001b\"\nc: it's\nd: say \"hi\"\ne: both ' and \""
    );
    assert_eq!(
        write(&map(&[("a", s("x\n\ty")), ("b", s(" \n")), ("c", s("x\n \ny"))])),
        "a: \"x\\n\\ty\"\nb: \" \\n\"\nc: \"x\\n \\ny\""
    );
    assert_eq!(
        write(&map(&[
            ("a b", n(1.0)),
            ("", n(2.0)),
            ("x: y", n(3.0)),
            ("1", n(4.0)),
            ("true", n(5.0))
        ])),
        "a b: 1\n\"\": 2\n\"x: y\": 3\n\"1\": 4\n\"true\": 5"
    );
    assert_eq!(
        write(&map(&[("a", s("---")), ("b", s("a\n---\nb")), ("c", s("%x")), ("d", s("..."))])),
        "a: ---\nb: |-\n  a\n  ---\n  b\nc: \"%x\"\nd: ..."
    );
}

#[test]
fn writes_multi_line_strings_as_block_scalars_and_folds_long_lines() {
    assert_eq!(
        write(&map(&[
            ("a", s("one\ntwo\n")),
            ("b", s("x\n\ny")),
            ("c", s(" lead\n  two")),
            ("d", s("\n\nz")),
            ("e", s("x\n\n"))
        ])),
        "a: |\n  one\n  two\nb: |-\n  x\n\n  y\nc: |2-\n   lead\n    two\nd: |-\n  \n\n  z\ne: |+\n  x\n"
    );
    let folded = format!(
        "a: {}\n  {}\n  {}\n  {}",
        words(0, 11),
        words(12, 22),
        words(23, 33),
        words(34, 39)
    );
    assert_eq!(write(&map(&[("a", s(&prose()))])), folded);
    let two = format!("{}\nsecond line {}", prose(), prose());
    let expected = format!(
        "a: >-\n  {}\n  {}\n  {}\n  {}\n\n  second line {}\n  {}\n  {}\n  {}",
        words(0, 11),
        words(12, 22),
        words(23, 33),
        words(34, 39),
        words(0, 10),
        words(11, 21),
        words(22, 32),
        words(33, 39)
    );
    assert_eq!(write(&map(&[("a", s(&two))])), expected);
    let unbroken = "z".repeat(100);
    assert_eq!(write(&map(&[("a", s(&unbroken))])), format!("a: {unbroken}"));
    assert_eq!(
        write(&map(&[
            ("a", s("line one\n  indented\nline three")),
            ("b", s(&format!("{}\n  {}", prose(), prose())))
        ])),
        format!(
            "a: |-\n  line one\n    indented\n  line three\nb: >-\n  {}\n  {}\n  {}\n  {}\n    {}",
            words(0, 11),
            words(12, 22),
            words(23, 33),
            words(34, 39),
            prose()
        )
    );
}

#[test]
fn writes_a_key_past_1024_units_as_an_explicit_key() {
    let long = "k".repeat(1025);
    assert_eq!(write(&map(&[(&long, s("v"))])), format!("? {long}\n: v"));
    let edge = "k".repeat(1024);
    assert_eq!(write(&map(&[(&edge, s("v"))])), format!("{edge}: v"));
    assert_eq!(write(&map(&[("a", map(&[(&long, n(1.0))]))])), format!("a:\n  ? {long}\n  : 1"));
    // Written units count escapes and quotes: a key of 1023 units that needs
    // quotes is 1025 units long.
    let quoted = format!("{}:", "k".repeat(1022));
    assert_eq!(write(&map(&[(&quoted, n(1.0))])), format!("? \"{quoted}\"\n: 1"));
}

fn key(name: &str) -> Step {
    Step::Key(name.to_string())
}

fn fault(path: &[Step], why: Unwritable) -> Fault {
    Fault { path: path.to_vec(), why }
}

#[test]
fn refuses_to_write_what_has_no_spelling() {
    let seq = Value::Seq;
    assert_eq!(
        stringify(&map(&[("a", n(f64::NAN))])),
        Err(vec![fault(&[key("a")], Unwritable::Nan)])
    );
    assert_eq!(
        stringify(&map(&[("a", seq(vec![n(1.0), n(f64::INFINITY)]))])),
        Err(vec![fault(&[key("a"), Step::Index(1)], Unwritable::Infinity)])
    );
    assert_eq!(
        stringify(&map(&[("a", n(f64::NEG_INFINITY))])),
        Err(vec![fault(&[key("a")], Unwritable::NegativeInfinity)])
    );
    assert_eq!(
        stringify(&map(&[("a", Value::BigInt("9007199254740993".into()))])),
        Err(vec![fault(&[key("a")], Unwritable::BigInt)])
    );
    assert_eq!(
        stringify(&map(&[("a", s("x\u{feff}y"))])),
        Err(vec![fault(&[key("a")], Unwritable::ByteOrderMark)])
    );
    // A key is reported at the mapping that holds it, once for each such key,
    // before the entries of that mapping.
    assert_eq!(
        stringify(&map(&[("k\u{feff}", n(f64::NAN)), ("j\u{feff}", n(1.0))])),
        Err(vec![
            fault(&[], Unwritable::ByteOrderMark),
            fault(&[], Unwritable::ByteOrderMark),
            fault(&[key("k\u{feff}")], Unwritable::Nan),
        ])
    );
}

#[test]
fn a_reserved_key_is_reported_first_and_at_the_root_wherever_it_sits() {
    assert_eq!(
        stringify(&map(&[("__proto__", n(1.0))])),
        Err(vec![fault(&[], Unwritable::ReservedKey)])
    );
    assert_eq!(
        stringify(&map(&[
            ("z", n(f64::NAN)),
            ("a", Value::Seq(vec![map(&[("__proto__", n(1.0))])]))
        ])),
        Err(vec![fault(&[], Unwritable::ReservedKey), fault(&[key("z")], Unwritable::Nan),])
    );
}

#[test]
fn every_place_without_a_spelling_is_reported_in_walk_order() {
    let value = map(&[
        ("first", Value::Seq(vec![n(f64::NAN), s("\u{feff}")])),
        ("second", map(&[("inner", Value::BigInt("9007199254740993".into()))])),
    ]);
    assert_eq!(
        stringify(&value),
        Err(vec![
            fault(&[key("first"), Step::Index(0)], Unwritable::Nan),
            fault(&[key("first"), Step::Index(1)], Unwritable::ByteOrderMark),
            fault(&[key("second"), key("inner")], Unwritable::BigInt),
        ])
    );
}

/// Nested long keys over many leaves with no spelling: each fault repeats its
/// path, so the list is bounded by weight and ends in `Overflow`.
fn heavy(keys: usize, key_bytes: usize, leaves: usize) -> Value {
    let leaf = Value::Seq((0..leaves).map(|_| n(f64::NAN)).collect());
    (0..keys).fold(leaf, |inner, at| Value::Map(vec![(format!("{at:0>key_bytes$}"), inner)]))
}

#[test]
fn faults_past_the_budget_end_the_list_with_an_overflow() {
    let faults = stringify(&heavy(60, 1000, 5000)).expect_err("every leaf is a NaN");
    let last = faults.last().expect("a list that ends");
    assert_eq!(last, &Fault { path: vec![], why: Unwritable::Overflow });
    // Each fault weighs about 60 KB, so a score fit and none repeats the full path after.
    assert!((10..30).contains(&faults.len()), "{} faults", faults.len());
    let kept = faults.iter().take(faults.len() - 1);
    assert!(kept.clone().all(|f| f.why == Unwritable::Nan && f.path.len() == 61));
    let bytes: usize = kept
        .map(|f| {
            f.path.iter().map(|s| if let Step::Key(k) = s { k.len() } else { 0 }).sum::<usize>()
        })
        .sum();
    assert!(bytes <= MAX_FAULT_BYTES, "{bytes} bytes of keys kept");
}

#[test]
fn faults_within_the_budget_are_all_listed_with_no_overflow() {
    let faults = stringify(&heavy(2, 10, 1000)).expect_err("every leaf is a NaN");
    assert_eq!(faults.len(), 1000);
    assert!(faults.iter().all(|f| f.why == Unwritable::Nan));
    // The budget is spent by weight, not by count: one fault more than fits overflows.
    let edge = MAX_FAULT_BYTES / 40 + 1;
    let faults = stringify(&Value::Seq((0..edge).map(|_| n(f64::NAN)).collect())).unwrap_err();
    assert_eq!(faults.last().map(|f| f.why), Some(Unwritable::Overflow));
}

#[test]
fn a_fault_that_weighs_exactly_the_budget_fits() {
    // A fault weighs 32 and 8 a step, and the key's own bytes.
    let at = |key_bytes: usize| stringify(&map(&[(&"k".repeat(key_bytes), n(f64::NAN))]));
    let fits = MAX_FAULT_BYTES - 40;
    assert_eq!(at(fits).unwrap_err().len(), 1);
    assert_eq!(at(fits).unwrap_err()[0].why, Unwritable::Nan);
    assert_eq!(at(fits + 1).unwrap_err(), vec![Fault { path: vec![], why: Unwritable::Overflow }]);
}

#[test]
fn a_value_nested_past_the_writer_is_reported_where_it_goes_too_deep() {
    let nest = |levels: usize| (0..levels).fold(Value::Null, |inner, _| Value::Seq(vec![inner]));
    assert!(stringify(&nest(MAX_PARSE_DEPTH)).is_ok());
    let path = vec![Step::Index(0); MAX_PARSE_DEPTH];
    assert_eq!(
        stringify(&nest(MAX_PARSE_DEPTH + 1)),
        Err(vec![Fault { path, why: Unwritable::TooDeep }])
    );
}

#[test]
fn what_is_written_reads_back_as_written() {
    let long = "k".repeat(1025);
    let value = map(&[
        (&long, s(&prose())),
        ("folded", s(&prose())),
        ("block", s("one\ntwo\n")),
        ("tab", s("x\n\ty")),
        ("c1", s("x\u{85}\u{7f}y")),
        ("quote", s("a'b\"c")),
        ("number-like", s("0x10")),
        (
            "list",
            Value::Seq(vec![
                s("a: b"),
                n(-0.0),
                n(1e21),
                Value::Null,
                map(&[("k", Value::Seq(vec![]))]),
            ]),
        ),
    ]);
    assert_eq!(read(&write(&value)), value);
}

#[test]
fn a_last_value_ending_in_two_newlines_loses_one_as_serialize_okf_does() {
    // `yaml` keeps the blank lines of a `|+` scalar and ends the document at
    // the last of them; `serializeOkf` then strips one newline, which here is
    // content. The Rust writer answers what the recorded oracle records, so
    // the loss is shared until both are changed together.
    let lossy = write(&map(&[("a", s("x\n\n"))]));
    assert_eq!(lossy, "a: |+\n  x\n");
    assert_eq!(read(&lossy), map(&[("a", s("x\n"))]));
    let kept = write(&map(&[("a", s("x\n\n")), ("b", n(1.0))]));
    assert_eq!(kept, "a: |+\n  x\n\nb: 1");
    assert_eq!(read(&kept), map(&[("a", s("x\n\n")), ("b", n(1.0))]));
}

#[test]
fn a_long_more_indented_line_is_folded_at_a_space_as_serialize_okf_does() {
    // `yaml` 2.9 writes a long string that starts with a space and ends in a
    // newline as a folded scalar and folds its first, more-indented line,
    // where a reader keeps the line break: the space comes back as a
    // newline. These are the bytes `serializeOkf` writes for this value, and
    // the loss is shared until both are changed together.
    let a = "word0 word1 word2 word3 word4 wordkkkkkkkkkkkk+kkkkkken text";
    let first = format!(" {}+{}4", "k".repeat(11), "k".repeat(51));
    let second = format!("word3{}8 wor{}d3kk", "k".repeat(25), "k".repeat(15));
    let value = map(&[("a", s(a)), ("c", s(&format!("{first} {second}\n")))]);
    let written = write(&value);
    assert_eq!(written, format!("a: {a}\nc: >2\n  {first}\n  {second}"));
    assert_eq!(read(&written), map(&[("a", s(a)), ("c", s(&format!("{first}\n{second}\n")))]));
}

#[test]
fn writes_a_block_scalar_at_the_root_as_yaml_does() {
    for (text, expected) in [
        (" a\nb", "|1-\n a\nb"),
        ("\n\n x\ny", "|1-\n\n\n x\ny"),
        ("x\ny", "|-\nx\ny"),
        ("---\nx", "|-\n  ---\n  x"),
        ("a\n---\nb", "|-\n  a\n  ---\n  b"),
        ("...\nx", "|-\n  ...\n  x"),
        ("%x\ny", "|-\n  %x\n  y"),
        ("---", "|-\n  ---"),
        ("a\n\nb\n", "|\na\n\nb"),
    ] {
        assert_eq!(write(&s(text)), expected, "{text:?}");
    }
    let long = prose();
    assert_eq!(write(&s(&format!(" {long}\nx"))), format!(">1-\n {long}\nx"));
    assert_eq!(write(&Value::Seq(vec![s("x\n---\ny")])), "- |-\n  x\n  ---\n  y");
    assert_eq!(write(&Value::Seq(vec![s("  a\nb")])), "- |2-\n    a\n  b");
}

#[test]
fn the_parse_goes_on_past_the_depth_it_refuses_so_malformed_is_named_malformed() {
    let open =
        |levels: usize, closed: usize| format!("a: {}1{}", "[".repeat(levels), "]".repeat(closed));
    // The root mapping is the first level: 63 flow levels make 64.
    assert_eq!(class(&open(63, 63)), "depth");
    assert_eq!(class(&open(63, 62)), "syntax");
    assert_eq!(class(&open(64, 64)), "depth");
    assert_eq!(class(&open(64, 63)), "depth");
    // Sibling collections do not add up.
    let siblings = format!("a: [{}]", "[],".repeat(70));
    assert_eq!(read(&siblings), map(&[("a", Value::Seq(vec![Value::Seq(vec![]); 70]))]));
}

#[test]
fn properties_on_lines_of_their_own_are_bounded_by_the_parse_depth() {
    // Each property-only line hands the node to the next line, so a text of
    // them nests one level per line; the depth cap has to count them, or a
    // text under MAX_BYTES recurses until the stack runs out.
    for property in ["!t\n", "&a\n"] {
        let lines = MAX_BYTES / property.len() - 1;
        assert_eq!(parse(&property.repeat(lines)), Err(Refusal::Depth), "{property:?}");
        assert_eq!(
            parse(&format!("a:\n{}", format!("  {property}").repeat(lines / 2))),
            Err(Refusal::Depth)
        );
    }
    // Under the cap the reading is unchanged: a tag on its own line is still
    // the subset refusal it was.
    assert_eq!(class("!t\nx\n"), "subset");
}
