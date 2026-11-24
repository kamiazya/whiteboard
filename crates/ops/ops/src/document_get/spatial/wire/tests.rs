use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn map(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

#[test]
fn a_value_measures_as_its_wire_text() {
    let value = map(&[
        (
            "a",
            Value::Seq(vec![
                Value::Null,
                Value::Bool(true),
                Value::Bool(false),
                Value::Number(1.5),
                Value::Number(-0.0),
                Value::Number(-7.0),
                Value::Number(9_007_199_254_740_991.0),
                Value::Number(9_007_199_254_740_992.0),
                Value::Number(f64::NAN),
                Value::BigInt("12".into()),
            ]),
        ),
        ("é\u{1}", Value::String("\"\\\u{8}\u{c}\n\r\t🎨".into())),
    ]);
    let wire = concat!(
        r#"["m","a",["s",null,true,false,["f","3ff8000000000000"],["f","8000000000000000"],-7,"#,
        r#"9007199254740991,["f","4340000000000000"],["f","7ff8000000000000"],["b","12"]],"#,
        r#""é\u0001","\"\\\b\f\n\r\t🎨"]"#
    );
    assert_eq!(size(&value, 0), Some(wire.len() as u64));
}

/// `levels` lists, each holding the next.
fn nested(levels: usize) -> Value {
    (1..levels).fold(Value::Seq(Vec::new()), |inner, _| Value::Seq(vec![inner]))
}

#[test]
fn an_object_past_the_shims_depth_is_no_wire() {
    assert!(size(&nested(WIRE_DEPTH + 1), 0).is_some());
    assert_eq!(size(&nested(WIRE_DEPTH + 2), 0), None);
    let in_map = map(&[("k", nested(WIRE_DEPTH + 1))]);
    assert_eq!(size(&in_map, 0), None);
    assert!(!carried(&in_map));
}

#[test]
fn a_wire_is_carried_up_to_the_caps_bytes() {
    // `["m","t",` and `]` around the quoted text: 10 bytes and the text's.
    let text = |s: String| map(&[("t", Value::String(s))]);
    let fill = usize::try_from(MAX_WIRE).expect("a size") - 12;
    assert!(carried(&text("a".repeat(fill))));
    assert!(!carried(&text("a".repeat(fill + 1))));
    // Two bytes and one unit each: the bytes are what the export refuses.
    assert!(carried(&text("é".repeat(fill / 2))));
    assert!(!carried(&text("é".repeat(fill / 2 + 1))));
}
