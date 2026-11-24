use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_reference_graph::facts::BearerKind;

fn texts(texts: &[&str]) -> Vec<String> {
    texts.iter().map(|text| (*text).to_owned()).collect()
}

#[test]
fn an_opening_is_the_first_text_that_is_not_blank() {
    assert_eq!(opening_of(&texts(&[" \u{feff}\n", "first", "second"])), Some(texts(&["first"])));
    assert_eq!(opening_of(&texts(&["", "  "])), Some(Vec::new()));
    assert_eq!(opening_of(&[]), Some(Vec::new()));
    // U+0085 is white space to Rust and not to JavaScript's `trim`.
    assert_eq!(opening_of(&texts(&["\u{85}"])), Some(texts(&["\u{85}"])));
}

#[test]
fn an_opening_is_cut_at_its_unit_budget_and_never_inside_a_pair() {
    let exact = "x".repeat(OPENING_UNITS);
    assert_eq!(opening_of(std::slice::from_ref(&exact)), Some(vec![exact.clone()]));
    let longer = format!("{exact}y");
    assert_eq!(opening_of(&[longer]), Some(vec![exact.clone()]));
    let paired = format!("{}🚀z", "x".repeat(OPENING_UNITS - 2));
    assert_eq!(
        opening_of(std::slice::from_ref(&paired)),
        Some(vec![paired[..paired.len() - 1].to_owned()])
    );
    let split = format!("{}🚀", "x".repeat(OPENING_UNITS - 1));
    assert_eq!(opening_of(&[split]), None);
}

fn bearer(text: &str, tags: &[&str]) -> TagBearer {
    TagBearer { what: BearerKind::Node, id: None, text: text.to_owned(), tags: texts(tags) }
}

#[test]
fn one_bearer_has_to_carry_every_wanted_tag() {
    let bearers = [bearer("a", &["x", "y"]), bearer("", &["x", "y", "z"]), bearer("b", &["x"])];
    let wanted = |tags: &[&'static str]| tags.iter().copied().collect::<BTreeSet<&str>>();
    assert_eq!(named_carrying(&bearers, &wanted(&["x", "y"])), Some(texts(&["a"])));
    assert_eq!(named_carrying(&bearers, &wanted(&["x"])), Some(texts(&["a", "b"])));
    assert_eq!(named_carrying(&bearers, &wanted(&["z"])), Some(Vec::new()));
    assert_eq!(named_carrying(&bearers, &wanted(&["y", "w"])), None);
    let repeated = [bearer("c", &["x", "x"])];
    assert_eq!(named_carrying(&repeated, &wanted(&["x", "y"])), None);
}
