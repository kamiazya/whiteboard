//! What a tag change does to a stored set, and what a library holds against
//! the set that results.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::{Map, json};

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn change(add: &[&str], remove: &[&str], rename: &[(&str, &str)]) -> TagEdit {
    TagEdit::of(&TagChange {
        add: strings(add),
        remove: strings(remove),
        rename: rename.iter().map(|(from, to)| ((*from).to_owned(), (*to).to_owned())).collect(),
    })
}

#[test]
fn an_add_keeps_what_is_there_and_a_tag_added_twice_is_one() {
    let held = strings(&["a", "b"]);
    let edit = change(&["c", "a", "c"], &[], &[]);
    assert_eq!(edit.apply(Some(&held)), strings(&["a", "b", "c"]));
    assert_eq!(edit.apply(None), strings(&["c", "a"]));
}

#[test]
fn a_removal_drops_by_name_and_names_the_new_spelling_after_a_rename() {
    let held = strings(&["a", "b", "c"]);
    assert_eq!(change(&[], &["b", "zz"], &[]).apply(Some(&held)), strings(&["a", "c"]));
    let renamed = change(&[], &["z"], &[("a", "z")]);
    assert_eq!(renamed.apply(Some(&held)), strings(&["b", "c"]));
    let old_name = change(&[], &["a"], &[("a", "z")]);
    assert_eq!(old_name.apply(Some(&held)), strings(&["z", "b", "c"]));
}

#[test]
fn a_rename_onto_a_present_tag_merges_and_of_two_renames_the_first_wins() {
    let held = strings(&["a", "b"]);
    assert_eq!(change(&[], &[], &[("a", "b")]).apply(Some(&held)), strings(&["b"]));
    let two = change(&[], &[], &[("a", "x"), ("a", "y")]);
    assert_eq!(two.apply(Some(&held)), strings(&["x", "b"]));
}

#[test]
fn a_rename_reaches_only_a_set_that_carries_a_renamed_tag() {
    let edit = change(&["n"], &["r"], &[("a", "x")]);
    assert!(edit.reaches(Some(&strings(&["q", "a"]))));
    assert!(!edit.reaches(Some(&strings(&["q"]))));
    assert!(!edit.reaches(None));
    assert!(edit.renames_any());
    assert!(edit.has_adds());
    assert!(!change(&[], &["r"], &[]).renames_any());
    assert!(!change(&[], &["r"], &[]).has_adds());
}

#[test]
fn the_rename_half_alone_adds_and_removes_nothing() {
    let edit = change(&["n"], &["a"], &[("a", "x")]);
    let renames = edit.renames_only().expect("a rename");
    assert_eq!(renames.apply(Some(&strings(&["a", "b"]))), strings(&["x", "b"]));
    assert!(change(&["n"], &[], &[]).renames_only().is_none());
}

#[test]
fn tags_are_read_only_from_a_list_of_strings() {
    let list = Value::Seq(vec![Value::String("a".into()), Value::String("b".into())]);
    assert_eq!(tags_of(Some(&list)), Some(strings(&["a", "b"])));
    assert_eq!(tags_of(Some(&Value::Seq(vec![Value::Null]))), None);
    assert_eq!(tags_of(Some(&Value::String("a".into()))), None);
    assert_eq!(tags_of(None), None);
}

fn library() -> Map {
    let parsed = json::parse(
        r#"{"health":{"exclusive":true,"values":{"ok":{},"failing":{}}},"region":{"values":{"us":{},"eu":{}}},"loose":{}}"#,
    )
    .expect("a library");
    match parsed {
        Value::Map(entries) => entries,
        _ => Vec::new(),
    }
}

#[test]
fn a_value_a_key_does_not_admit_is_refused_naming_what_it_admits_sorted() {
    assert_eq!(
        objection(&library(), &strings(&["plain", "region:asia"])),
        Some(Objection::Undeclared {
            tag: "region:asia".into(),
            key: "region".into(),
            admitted: strings(&["eu", "us"]),
        })
    );
}

#[test]
fn two_values_under_an_exclusive_key_are_refused_with_everything_carried() {
    assert_eq!(
        objection(&library(), &strings(&["health:ok", "region:eu", "health:failing"])),
        Some(Objection::Exclusive {
            key: "health".into(),
            carried: strings(&["health:ok", "health:failing"]),
        })
    );
}

#[test]
fn a_plain_tag_an_undeclared_key_and_a_key_that_is_not_exclusive_pass() {
    let tags = strings(&["plain", "other:thing", "region:eu", "region:us", "loose:a", "loose:b"]);
    assert_eq!(objection(&library(), &tags), None);
    assert_eq!(objection(&[], &strings(&["a:b", "a:c"])), None);
}

#[test]
fn a_value_not_admitted_is_judged_before_exclusivity() {
    let tags = strings(&["health:ok", "health:failing", "region:asia"]);
    assert!(matches!(objection(&library(), &tags), Some(Objection::Undeclared { .. })));
}
