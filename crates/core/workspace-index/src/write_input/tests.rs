use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

#[test]
fn an_id_is_a_canonical_ulid() {
    assert_eq!(require_id(ID), Ok(()));
    assert_eq!(require_id("01ARZ3NDEKTSV4RRFFQ69G5FA"), Err(IndexError::InvalidInput));
    assert_eq!(require_id("81ARZ3NDEKTSV4RRFFQ69G5FAV"), Err(IndexError::InvalidInput));
    assert_eq!(require_id(""), Err(IndexError::InvalidInput));
}

#[test]
fn a_path_is_held_to_the_grammar() {
    assert_eq!(require_path("a/b-c"), Ok(()));
    for refused in ["", "/bad", "a b", "a//b", "a/", "-a"] {
        assert_eq!(require_path(refused), Err(IndexError::InvalidInput), "{refused:?}");
    }
}

#[test]
fn a_name_is_bounded_in_utf16_units_and_may_be_blank() {
    assert_eq!(require_name(""), Ok(()));
    assert_eq!(require_name("   "), Ok(()));
    assert_eq!(require_name(&"n".repeat(200)), Ok(()));
    assert_eq!(require_name(&"n".repeat(201)), Err(IndexError::InvalidInput));
    assert_eq!(require_name(&"\u{1f600}".repeat(100)), Ok(()));
    assert_eq!(require_name(&"\u{1f600}".repeat(101)), Err(IndexError::InvalidInput));
}

#[test]
fn a_folder_name_is_refused_for_blank_a_slash_or_length_after_trimming() {
    for refused in ["", "  ", "\u{feff}", "a/b", " / ", &"n".repeat(201)] {
        assert!(folder_name_refused(refused), "{refused:?}");
        assert_eq!(require_folder_name(refused), Err(IndexError::InvalidInput));
    }
    for kept in ["Plan", &format!(" {} ", "n".repeat(200)), &"\u{1f600}".repeat(100)] {
        assert!(!folder_name_refused(kept), "{kept:?}");
        assert_eq!(require_folder_name(kept), Ok(()));
    }
    assert!(folder_name_refused(&"\u{1f600}".repeat(101)));
}

#[test]
fn a_create_is_checked_in_every_field() {
    assert_eq!(check_create(ID, "a", "markdown", None), Ok(()));
    assert_eq!(check_create(ID, "a", "spatial", Some("Name")), Ok(()));
    let invalid = Err(IndexError::InvalidInput);
    assert_eq!(check_create("x", "a", "markdown", None), invalid);
    assert_eq!(check_create(ID, "/a", "markdown", None), invalid);
    assert_eq!(check_create(ID, "a", "canvas", None), invalid);
    assert_eq!(check_create(ID, "a", "markdown", Some("")), invalid);
    assert_eq!(check_create(ID, "a", "markdown", Some(&"n".repeat(201))), invalid);
}
