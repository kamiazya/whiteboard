use serde_json::{Value as Json, json};
use whiteboard_canvas_render::sfnt;

use super::{
    Fonts, MAX_FACES, MAX_HANDLES, MAX_HELD_BYTES, register_layout_fonts, release_layout_fonts,
};
use crate::input_caps::REGISTER_LAYOUT_FONTS;
use crate::spatial_layout::request::Face;
use crate::spatial_layout::tests::{ROBOTO, answer, board, m, request, s};

fn wire_face(from: usize, to: usize) -> Json {
    m(&[
        ("family", json!("Roboto")),
        ("bold", json!(false)),
        ("italic", json!(false)),
        ("from", json!(from)),
        ("to", json!(to)),
    ])
}

fn registered(bytes: &[u8], faces: &[Json]) -> Json {
    let wire = s(faces.to_vec()).to_string();
    serde_json::from_str(&register_layout_fonts(bytes, &wire)).unwrap_or(Json::Null)
}

fn by_handle(handle: &Json) -> Json {
    m(&[("kind", json!("fonts")), ("handle", handle.clone())])
}

fn laid(measure: Json) -> Json {
    answer(&request(board("hello"), &[("measure", measure)]))
}

#[test]
fn a_layout_measures_with_the_faces_its_handle_names_until_they_are_released() {
    let ok = registered(ROBOTO, &[wire_face(0, ROBOTO.len())]);
    assert_eq!(ok.get(0), Some(&json!("ok")), "{ok}");
    let handle = ok.get(1).cloned().unwrap_or_default();
    let id = handle.as_u64().and_then(|h| u32::try_from(h).ok()).unwrap_or(u32::MAX);
    let by_font = laid(by_handle(&handle));
    assert_eq!(by_font.get(0), Some(&json!("ok")), "{by_font}");
    assert_ne!(by_font, laid(m(&[("kind", json!("ratio"))])));
    let marked = request(board("cafe\u{301} \u{200d}"), &[("measure", by_handle(&handle))]);
    assert_eq!(answer(&marked).get(0), Some(&json!("ok")));
    assert!(release_layout_fonts(id));
    assert!(!release_layout_fonts(id));
    assert_eq!(laid(by_handle(&handle)), json!(["refused", "malformed", "font-handle"]));
    let again = registered(ROBOTO, &[wire_face(0, ROBOTO.len())]);
    assert_ne!(again.get(1), Some(&handle), "a handle is never reused");
    assert_eq!(laid(by_handle(again.get(1).unwrap_or(&Json::Null))), by_font);
}

#[test]
fn a_registration_with_no_face_measures_by_the_ratio_estimate() {
    let ok = registered(&[], &[]);
    let by_fonts = laid(by_handle(ok.get(1).unwrap_or(&Json::Null)));
    let by_ratio = laid(m(&[("kind", json!("ratio"))]));
    assert_eq!(by_fonts.get(0), Some(&json!("ok")));
    assert_eq!(by_fonts, by_ratio);
    assert_ne!(by_ratio, answer(&request(board("hello"), &[])));
}

#[test]
fn a_handle_that_is_not_a_whole_number_is_no_request() {
    for handle in [
        json!(["f", "bff0000000000000"]),
        json!(["f", "3fe0000000000000"]),
        json!(4_294_967_296_u64),
        json!("0"),
    ] {
        assert_eq!(laid(by_handle(&handle)), json!(["refused", "malformed", "request"]));
    }
}

#[test]
fn faces_that_are_not_fonts_or_past_the_cap_are_refused() {
    let refused = |code: &str, class: &str| json!(["refused", code, class]);
    let padded = |n: usize| format!("[\"s\"]{}", " ".repeat(n - 5));
    let past = register_layout_fonts(&[0], &padded(REGISTER_LAYOUT_FONTS.max_bytes));
    assert_eq!(past, refused("input-too-large", "too-large").to_string());
    let at_cap = register_layout_fonts(&[0], &padded(REGISTER_LAYOUT_FONTS.max_bytes - 1));
    let held: Json = serde_json::from_str(&at_cap).unwrap_or_default();
    assert_eq!(held.get(0), Some(&json!("ok")), "{held}");
    let id = held.get(1).and_then(Json::as_u64).and_then(|h| u32::try_from(h).ok());
    assert!(id.is_some_and(release_layout_fonts));
    let not_faces = |wire: &str| register_layout_fonts(&[], wire);
    for wire in ["{", "[\"m\"]", "[\"s\",1]", "[\"s\",[\"m\",\"family\",\"F\"]]"] {
        assert_eq!(not_faces(wire), refused("malformed", "faces").to_string(), "{wire}");
    }
    assert_eq!(registered(&[0, 1], &[wire_face(1, 3)]), refused("malformed", "font"));
    assert_eq!(registered(&[0, 1], &[wire_face(0, 4)]), refused("input-too-large", "face-bytes"));
    assert_eq!(registered(&[0, 1], &[wire_face(0, 2)]), refused("malformed", "font"));
}

fn face(from: usize, to: usize) -> Face {
    Face { family: "F".to_owned(), bold: false, italic: false, from, to }
}

#[test]
fn an_instance_holds_a_bounded_count_of_faces_registrations_and_bytes() {
    let mut fonts = Fonts::new();
    let len = ROBOTO.len();
    let faces = |n: usize| (0..n).map(|i| face(i * len, (i + 1) * len)).collect::<Vec<_>>();
    let many = ROBOTO.repeat(MAX_FACES);
    assert_eq!(fonts.register(&many, faces(MAX_FACES + 1)), Err(("input-too-large", "faces")));
    let twice = vec![face(0, len), face(0, len)];
    assert_eq!(fonts.register(ROBOTO, twice), Err(("input-too-large", "face-bytes")));
    let halves = vec![face(0, len), face(len, 2 * len), face(len, 2 * len)];
    assert_eq!(fonts.register(&many[..2 * len], halves), Err(("input-too-large", "face-bytes")));
    assert_eq!(fonts.register(&many, faces(MAX_FACES)), Ok(0));
    assert!(fonts.release(0));
    assert_eq!(fonts.register(ROBOTO, faces(1)), Ok(1));
    assert!(fonts.measurer(1).is_some());
    assert!(fonts.measurer(2).is_none());
    for handle in 2..=MAX_HANDLES {
        assert_eq!(fonts.register(&[], Vec::new()), Ok(u32::try_from(handle).unwrap_or(0)));
    }
    assert_eq!(fonts.register(&[], Vec::new()), Err(("input-too-large", "handles")));
    assert!(fonts.release(3));
    assert!(fonts.measurer(3).is_none());
    assert!(fonts.measurer(4).is_some());
    // Handle 1 holds Roboto and its one face's family, "F".
    let past = MAX_HELD_BYTES - (ROBOTO.len() + 1) + 1;
    assert_eq!(fonts.register(&vec![0; past], Vec::new()), Err(("input-too-large", "held")));
    assert!(fonts.register(&vec![0; past - 1], Vec::new()).is_ok());
}

#[test]
fn a_faces_family_is_held_with_the_bytes() {
    let mut fonts = Fonts::new();
    let named = |len: usize| Face { family: "F".repeat(len), ..face(0, ROBOTO.len()) };
    let room = MAX_HELD_BYTES - ROBOTO.len();
    assert_eq!(fonts.register(ROBOTO, vec![named(room + 1)]), Err(("input-too-large", "held")));
    assert_eq!(fonts.register(ROBOTO, vec![named(room)]), Ok(0));
    assert_eq!(fonts.register(&[0], Vec::new()), Err(("input-too-large", "held")));
    assert!(fonts.release(0));
    assert_eq!(fonts.register(&[0], Vec::new()), Ok(1));
}

#[test]
fn a_face_past_the_readers_own_cap_is_too_large_and_the_last_handle_is_never_minted() {
    let mut fonts = Fonts::new();
    let face_bytes = vec![0_u8; sfnt::MAX_BYTES + 1];
    let past = vec![face(0, face_bytes.len())];
    assert_eq!(fonts.register(&face_bytes, past), Err(("input-too-large", "face")));
    fonts.next = u32::MAX - 1;
    assert_eq!(fonts.register(&[], Vec::new()), Ok(u32::MAX - 1));
    assert_eq!(fonts.register(&[], Vec::new()), Err(("input-too-large", "handles")));
    assert!(fonts.measurer(u32::MAX).is_none());
}
