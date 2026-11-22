use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn names(held: &[&str]) -> Vec<String> {
    held.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn a_copy_is_called_copy_and_then_the_first_free_number() {
    assert_eq!(derive_copy_name("Foo", &names(&["Foo"])), "Foo (copy)");
    assert_eq!(derive_copy_name("Foo", &names(&["Foo", "Foo (copy)"])), "Foo (copy 2)");
    assert_eq!(derive_copy_name("Foo", &names(&["Foo (copy)", "Foo (copy 3)"])), "Foo (copy 2)");
    assert_eq!(
        derive_copy_name("Foo", &names(&["Foo (copy)", "Foo (copy 2)", "Foo (copy 3)"])),
        "Foo (copy 4)"
    );
}

#[test]
fn a_taken_name_is_compared_as_the_siblings_rule_compares_it() {
    assert_eq!(derive_copy_name("Foo", &names(&["  FOO (COPY) "])), "Foo (copy 2)");
    assert_eq!(derive_copy_name("Foo", &names(&["Foo (copy 2)"])), "Foo (copy)");
}

#[test]
fn a_base_at_the_bound_is_shortened_to_make_room_for_the_suffix() {
    let base = "x".repeat(200);
    let copy = derive_copy_name(&base, &[]);
    assert_eq!(copy, format!("{} (copy)", "x".repeat(193)));
    assert_eq!(utf16::len(&copy), 200);
    let second = derive_copy_name(&base, &names(&[&copy]));
    assert_eq!(second, format!("{} (copy 2)", "x".repeat(191)));
    assert_eq!(utf16::len(&second), 200);
}

#[test]
fn a_cut_drops_the_space_it_leaves_at_the_end_and_never_splits_a_pair() {
    let spaced = format!("{} yyyy", "x".repeat(192));
    assert_eq!(derive_copy_name(&spaced, &[]), format!("{} (copy)", "x".repeat(192)));
    let paired = format!("{}\u{1f600}", "a".repeat(192));
    assert_eq!(derive_copy_name(&paired, &[]), format!("{} (copy)", "a".repeat(192)));
    assert_eq!(fit_to_length("ab\u{1f600}c", 3), "ab");
    assert_eq!(fit_to_length("ab\u{1f600}c", 4), "ab\u{1f600}");
    assert_eq!(fit_to_length("abc", 3), "abc");
    assert_eq!(fit_to_length("abc", 0), "");
}

fn paths(held: &[&str]) -> Vec<String> {
    names(held)
}

#[test]
fn a_copy_lands_beside_its_source_in_its_folder() {
    assert_eq!(derive_copy_path("a", &[]), Some("a-copy".to_owned()));
    assert_eq!(derive_copy_path("notes/roadmap", &[]), Some("notes/roadmap-copy".to_owned()));
    assert_eq!(
        derive_copy_path("notes/roadmap", &paths(&["notes/roadmap-copy"])),
        Some("notes/roadmap-copy-2".to_owned())
    );
    assert_eq!(
        derive_copy_path("a", &paths(&["a-copy", "a-copy-2", "a-copy-3"])),
        Some("a-copy-4".to_owned())
    );
    assert_eq!(derive_copy_path("a", &paths(&["a-copy", "a-copy-3"])), Some("a-copy-2".to_owned()));
}

#[test]
fn a_copy_segment_is_cut_to_fit_the_path_bound_without_a_trailing_hyphen() {
    let folder = format!("{}/", "f".repeat(1010));
    assert_eq!(
        derive_copy_path(&format!("{folder}abcdef"), &[]),
        Some(format!("{folder}abcdef-copy"))
    );
    assert_eq!(
        derive_copy_path(&format!("{folder}abcdefghijkl"), &[]),
        Some(format!("{folder}abcdefgh-copy"))
    );
    assert_eq!(
        derive_copy_path(&format!("{folder}abcdefg-hijkl"), &[]),
        Some(format!("{folder}abcdefg-copy"))
    );
    let numbered = format!("{folder}abcdefghijkl");
    assert_eq!(
        derive_copy_path(&numbered, &paths(&[&format!("{folder}abcdefgh-copy")])),
        Some(format!("{folder}abcdef-copy-2"))
    );
}

#[test]
fn a_folder_with_no_room_for_a_copy_segment_has_none() {
    let full = format!("{}/leaf", "f".repeat(1018));
    assert_eq!(derive_copy_path(&full, &[]), None);
    let exact = format!("{}/leaf", "f".repeat(1017));
    assert_eq!(derive_copy_path(&exact, &[]), Some(format!("{}/l-copy", "f".repeat(1017))));
}
