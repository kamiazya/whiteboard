//! What judging a value does, construct by construct.

use serde_json::{Value as Json, json};
use whiteboard_model::Value;

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[test]
fn a_string_is_judged_by_its_bound_its_matcher_and_its_check_in_that_order() {
    let defs = json!({ "S": { "type": "string", "x-wb-minUtf16": 3, "pattern": "^x$",
        "x-wb-matcher": "lower", "x-wb-message": "lower please", "x-wb-check": "even" } });
    assert!(answer(&defs, "S", &json!("abcd")).is_ok());
    let all = answer(&defs, "S", &json!("A"));
    assert_eq!(
        shape(&all),
        vec![
            issue("", Code::TooSmall, true),
            issue("", Code::InvalidFormat, true),
            issue("", Code::Custom, true)
        ]
    );
    let issues = all.expect_err("refused");
    assert_eq!(issues[1].detail, Detail::Message("lower please".into()));
    assert_eq!(shape(&answer(&defs, "S", &json!(5))), vec![issue("", Code::InvalidType, false)]);
}

#[test]
fn a_bound_counts_a_string_as_zod_does_in_code_points_where_the_units_cannot_decide() {
    let defs = json!({ "S": { "type": "string", "x-wb-minUtf16": 3 } });
    // Four UTF-16 units, two code points: the units are inside [3, 6).
    assert_eq!(
        shape(&answer(&defs, "S", &json!("\u{1d7d8}\u{1d7d8}"))),
        vec![issue("", Code::TooSmall, true)]
    );
    // Eight units: outside, so units decide.
    assert!(answer(&defs, "S", &json!("\u{1d7d8}\u{1d7d8}\u{1d7d8}\u{1d7d8}")).is_ok());
    assert!(answer(&defs, "S", &json!("abc")).is_ok());
    assert_eq!(shape(&answer(&defs, "S", &json!("ab"))), vec![issue("", Code::TooSmall, true)]);
}

#[test]
fn a_length_check_runs_on_what_has_a_length_even_when_the_type_is_wrong() {
    let defs = json!({
        "S": { "type": "string", "x-wb-minUtf16": 1 },
        "L": { "type": "array", "items": { "type": "boolean" }, "minItems": 1, "maxItems": 2 },
    });
    assert_eq!(
        shape(&answer(&defs, "S", &json!([]))),
        vec![issue("", Code::InvalidType, false), issue("", Code::TooSmall, true)]
    );
    assert_eq!(shape(&answer(&defs, "S", &json!([1]))), vec![issue("", Code::InvalidType, false)]);
    let object = answer(&defs, "S", &json!({ "length": 0 }));
    assert_eq!(
        shape(&object),
        vec![issue("", Code::InvalidType, false), issue("", Code::TooSmall, true)]
    );
    for odd in [json!({ "length": "x" }), json!({}), json!(null), json!(true)] {
        assert_eq!(
            shape(&answer(&defs, "S", &odd)),
            vec![issue("", Code::InvalidType, false)],
            "{odd}"
        );
    }
    assert_eq!(
        shape(&answer(&defs, "L", &json!(""))),
        vec![issue("", Code::InvalidType, false), issue("", Code::TooSmall, true)]
    );
    assert_eq!(
        shape(&answer(&defs, "L", &json!("abc"))),
        vec![issue("", Code::InvalidType, false), issue("", Code::TooBig, true)]
    );
}

#[test]
fn a_number_is_finite_and_above_its_bound() {
    let defs = json!({
        "N": { "type": "number", "minimum": 0 },
        "G": { "type": "number", "exclusiveMinimum": 0 },
        "F": { "type": "number" },
    });
    assert!(answer(&defs, "N", &json!(0)).is_ok());
    assert_eq!(shape(&answer(&defs, "N", &json!(-1))), vec![issue("", Code::TooSmall, true)]);
    assert!(answer(&defs, "G", &json!(0.5)).is_ok());
    assert_eq!(shape(&answer(&defs, "G", &json!(0))), vec![issue("", Code::TooSmall, true)]);
    assert!(answer(&defs, "F", &json!(-1.5)).is_ok());
    let contracts = compiled(&defs);
    let def = contracts.resolve("c.json#/$defs/F").expect("F");
    for refused in [
        Value::Number(f64::NAN),
        Value::Number(f64::INFINITY),
        Value::BigInt("9".into()),
        Value::Null,
    ] {
        let issues = contracts.validate(def, &refused).expect_err("refused");
        assert_eq!(issues[0].code, Code::InvalidType, "{refused:?}");
    }
}

#[test]
fn a_boolean_a_constant_and_an_enum_take_their_values_and_nothing_else() {
    let defs = json!({
        "B": { "type": "boolean" },
        "K": { "type": "string", "const": "only" },
        "E": { "type": "string", "enum": ["a", "b"] },
    });
    assert!(answer(&defs, "B", &json!(false)).is_ok());
    assert_eq!(
        shape(&answer(&defs, "B", &json!("false"))),
        vec![issue("", Code::InvalidType, false)]
    );
    assert!(answer(&defs, "K", &json!("only")).is_ok());
    assert!(answer(&defs, "E", &json!("b")).is_ok());
    for (name, wrong) in
        [("K", json!("other")), ("K", json!(1)), ("E", json!("c")), ("E", json!(null))]
    {
        assert_eq!(shape(&answer(&defs, name, &wrong)), vec![issue("", Code::InvalidValue, false)]);
    }
}

#[test]
fn a_list_judges_each_element_then_its_length_and_a_list_past_its_bound_is_refused_alone() {
    let defs = json!({ "L": { "type": "array", "items": { "type": "boolean" },
        "minItems": 2, "maxItems": 3, "x-wb-maxItemsMessage": "too many" } });
    assert!(answer(&defs, "L", &json!([true, false, true])).is_ok());
    assert_eq!(
        shape(&answer(&defs, "L", &json!([1]))),
        vec![issue("0", Code::InvalidType, false), issue("", Code::TooSmall, true)]
    );
    let over = answer(&defs, "L", &json!([1, 2, 3, 4]));
    assert_eq!(shape(&over), vec![issue("", Code::TooBig, false)]);
    assert_eq!(over.expect_err("refused")[0].detail, Detail::Message("too many".into()));
    let plain = json!({ "L": { "type": "array", "items": { "type": "boolean" }, "maxItems": 1 } });
    let issues = answer(&plain, "L", &json!([true, true])).expect_err("refused");
    assert_eq!(issues[0].detail, Detail::None);
    assert_eq!(
        shape(&answer(&plain, "L", &json!(null))),
        vec![issue("", Code::InvalidType, false)]
    );
}

fn union_defs() -> Json {
    json!({
        "Num": { "type": "object", "properties": { "n": { "type": "number" } },
            "required": ["n"], "x-wb-order": ["n"], "x-wb-unknownKeys": "strip" },
        "Txt": { "type": "object", "properties": { "t": { "type": "string", "x-wb-minUtf16": 1 } },
            "required": ["t"], "x-wb-order": ["t"], "x-wb-unknownKeys": "strip" },
        "Either": { "anyOf": [{ "$ref": "#/$defs/Num" }, { "$ref": "#/$defs/Txt" }] },
    })
}

#[test]
fn a_union_takes_the_first_arm_that_passes() {
    let defs = union_defs();
    assert_eq!(
        answer(&defs, "Either", &json!({ "t": "x" })).expect("accepted"),
        val(&json!({ "t": "x" }))
    );
    assert_eq!(
        answer(&defs, "Either", &json!({ "n": 1, "t": "x" })).expect("accepted"),
        val(&json!({ "n": 1 }))
    );
}

#[test]
fn a_union_speaks_with_its_one_live_arm_or_names_every_arm() {
    let defs = union_defs();
    // The text arm nearly fit: its refusal does not stop, the number arm's does.
    let near = answer(&defs, "Either", &json!({ "t": "" }));
    assert_eq!(shape(&near), vec![issue("t", Code::TooSmall, true)]);
    let none = answer(&defs, "Either", &json!({ "t": 3 }));
    assert_eq!(shape(&none), vec![issue("", Code::InvalidUnion, false)]);
    let Detail::Arms(arms) = &none.expect_err("refused")[0].detail else { panic!("arms") };
    assert_eq!(arms.len(), 2);
    assert_eq!(arms[0][0].path, vec![PathStep::Key("n".into())]);
    assert_eq!(arms[1][0].code, Code::InvalidType);
    // Two arms that both nearly fit are no single answer either.
    let both = json!({
        "A": { "type": "string", "x-wb-minUtf16": 2 }, "B": { "type": "string", "x-wb-minUtf16": 3 },
        "U": { "anyOf": [{ "$ref": "#/$defs/A" }, { "$ref": "#/$defs/B" }] },
    });
    assert_eq!(shape(&answer(&both, "U", &json!("a"))), vec![issue("", Code::InvalidUnion, false)]);
}

fn tagged_defs() -> Json {
    json!({
        "Shape": { "type": "object", "properties": { "kind": { "type": "string", "const": "shape" },
            "name": { "type": "string" } }, "required": ["kind", "name"],
            "x-wb-order": ["kind", "name"], "x-wb-unknownKeys": "refuse" },
        "Char": { "type": "object", "properties": { "kind": { "type": "string", "const": "char" } },
            "required": ["kind"], "x-wb-order": ["kind"], "x-wb-unknownKeys": "refuse" },
        "Glyph": { "oneOf": [{ "$ref": "#/$defs/Shape" }, { "$ref": "#/$defs/Char" }],
            "discriminator": { "propertyName": "kind" } },
    })
}

#[test]
fn a_tagged_union_is_judged_by_the_arm_its_tag_names() {
    let defs = tagged_defs();
    assert!(answer(&defs, "Glyph", &json!({ "kind": "char" })).is_ok());
    assert_eq!(
        shape(&answer(&defs, "Glyph", &json!({ "kind": "shape" }))),
        vec![issue("name", Code::InvalidType, false)]
    );
    for stranger in
        [json!({ "kind": "x" }), json!({ "kind": 3 }), json!({}), json!({ "other": "char" })]
    {
        let refused = answer(&defs, "Glyph", &stranger);
        assert_eq!(shape(&refused), vec![issue("kind", Code::InvalidUnion, false)], "{stranger}");
        assert_eq!(refused.expect_err("refused")[0].detail, Detail::Arms(Vec::new()));
    }
    assert_eq!(
        shape(&answer(&defs, "Glyph", &json!("char"))),
        vec![issue("", Code::InvalidType, false)]
    );
}

fn object_defs() -> Json {
    json!({
        "Any": { "x-wb-any": true },
        "Item": { "type": "object", "properties": {
            "a": { "type": "string" },
            "b": { "type": "boolean" },
            "list": { "type": "array", "items": { "type": "boolean" }, "default": [] },
            "rec": { "type": "object", "additionalProperties": { "x-wb-any": true }, "default": {} },
            "any": { "$ref": "#/$defs/Any" },
        }, "required": ["a", "any"], "x-wb-order": ["a", "b", "list", "rec", "any"],
            "x-wb-unknownKeys": "strip" },
        "Strict": { "type": "object", "properties": { "a": { "type": "string" } },
            "required": ["a"], "x-wb-order": ["a"], "x-wb-unknownKeys": "refuse" },
    })
}

#[test]
fn an_object_keeps_its_declared_keys_in_order_fills_defaults_and_drops_the_rest() {
    let contracts = compiled(&object_defs());
    let item = contracts.resolve("c.json#/$defs/Item").expect("Item");
    let written = ordered(&[
        ("zz", Value::Number(1.0)),
        ("any", val(&json!([1]))),
        ("b", Value::Bool(true)),
        ("a", text("x")),
    ]);
    let expected = ordered(&[
        ("a", text("x")),
        ("b", Value::Bool(true)),
        ("list", Value::Seq(Vec::new())),
        ("rec", Value::Map(Vec::new())),
        ("any", val(&json!([1]))),
    ]);
    assert_eq!(contracts.validate(item, &written), Ok(expected));
    let parsed = answer(
        &object_defs(),
        "Item",
        &json!({ "a": "x", "any": null, "list": [true], "rec": { "k": 1 } }),
    );
    let expected = ordered(&[
        ("a", text("x")),
        ("list", val(&json!([true]))),
        ("rec", val(&json!({ "k": 1 }))),
        ("any", Value::Null),
    ]);
    assert_eq!(parsed, Ok(expected));
}

#[test]
fn a_missing_field_is_refused_where_the_schema_says_so() {
    let defs = object_defs();
    // `any` accepts an absent value, so only the object notices it is gone.
    assert_eq!(
        shape(&answer(&defs, "Item", &json!({ "a": "x" }))),
        vec![issue("any", Code::InvalidType, false)]
    );
    assert_eq!(
        shape(&answer(&defs, "Item", &json!({ "any": 1 }))),
        vec![issue("a", Code::InvalidType, false)]
    );
    assert_eq!(
        shape(&answer(&defs, "Item", &json!({ "a": 1, "b": 2, "any": 1 }))),
        vec![issue("a", Code::InvalidType, false), issue("b", Code::InvalidType, false)]
    );
    assert_eq!(
        shape(&answer(&defs, "Item", &json!([]))),
        vec![issue("", Code::InvalidType, false)]
    );
}

#[test]
fn an_object_that_refuses_unknown_keys_names_them_in_input_order_after_its_fields() {
    let contracts = compiled(&object_defs());
    let strict = contracts.resolve("c.json#/$defs/Strict").expect("Strict");
    assert!(contracts.validate(strict, &val(&json!({ "a": "x" }))).is_ok());
    let written = ordered(&[
        ("z", Value::Number(1.0)),
        ("a", Value::Number(2.0)),
        ("__proto__", Value::Number(3.0)),
        ("y", Value::Number(4.0)),
    ]);
    let refused = contracts.validate(strict, &written);
    assert_eq!(
        shape(&refused),
        vec![issue("a", Code::InvalidType, false), issue("", Code::UnrecognizedKeys, true)]
    );
    assert_eq!(
        refused.expect_err("refused")[1].detail,
        Detail::Keys(vec!["z".into(), "__proto__".into(), "y".into()])
    );
}

fn record_defs() -> Json {
    json!({
        "Key": { "type": "string", "pattern": "^x$", "x-wb-matcher": "lower" },
        "Flags": { "type": "object", "propertyNames": { "$ref": "#/$defs/Key" },
            "additionalProperties": { "type": "boolean" } },
        "Capped": { "type": "object", "propertyNames": { "$ref": "#/$defs/Key" },
            "additionalProperties": { "type": "boolean" }, "maxProperties": 2,
            "x-wb-maxPropertiesMessage": "at most 2; this has {count}" },
        "Free": { "type": "object", "additionalProperties": { "x-wb-any": true } },
    })
}

#[test]
fn a_record_judges_each_key_then_its_value_and_stops_at_a_key_it_refuses() {
    let defs = record_defs();
    assert_eq!(
        answer(&defs, "Flags", &json!({ "a": true, "b": false })).expect("accepted"),
        val(&json!({ "a": true, "b": false }))
    );
    let refused = answer(&defs, "Flags", &json!({ "A": 1, "b": 2, "__proto__": 3 }));
    assert_eq!(
        shape(&refused),
        vec![issue("A", Code::InvalidKey, false), issue("b", Code::InvalidType, false)]
    );
    let Detail::Key(inner) = &refused.expect_err("refused")[0].detail else { panic!("a key") };
    assert_eq!((inner[0].code, inner[0].path.len()), (Code::InvalidFormat, 0));
    assert_eq!(
        shape(&answer(&defs, "Flags", &json!([]))),
        vec![issue("", Code::InvalidType, false)]
    );
}

#[test]
fn a_bounded_record_is_counted_before_any_entry_is_judged() {
    let defs = record_defs();
    assert!(answer(&defs, "Capped", &json!({ "a": true, "b": true })).is_ok());
    let over = answer(&defs, "Capped", &json!({ "a": 1, "B": 2, "c": 3 }));
    assert_eq!(shape(&over), vec![issue("", Code::Custom, true)]);
    assert_eq!(
        over.expect_err("refused")[0].detail,
        Detail::Message("at most 2; this has 3".into())
    );
    assert_eq!(
        shape(&answer(&defs, "Capped", &json!(7))),
        vec![issue("", Code::InvalidType, false)]
    );
}

#[test]
fn a_record_with_no_key_schema_takes_any_key() {
    let defs = record_defs();
    assert_eq!(
        answer(&defs, "Free", &json!({ "Any Key": [1], "__proto__": 2 })).expect("accepted"),
        val(&json!({ "Any Key": [1] }))
    );
}

#[test]
fn an_any_value_is_taken_as_it_is_and_an_absent_one_is_nothing() {
    let defs = json!({ "Any": { "x-wb-any": true } });
    assert_eq!(
        answer(&defs, "Any", &json!({ "k": [1, null] })).expect("accepted"),
        val(&json!({ "k": [1, null] }))
    );
}

#[test]
fn a_definition_ref_is_judged_as_the_definition_it_names() {
    let defs = json!({ "A": { "$ref": "#/$defs/B" }, "B": { "type": "string", "enum": ["x"] } });
    assert!(answer(&defs, "A", &json!("x")).is_ok());
    assert_eq!(shape(&answer(&defs, "A", &json!("y"))), vec![issue("", Code::InvalidValue, false)]);
}

#[test]
fn a_required_union_field_that_is_absent_names_every_arm() {
    let mut defs = union_defs();
    defs["Wrap"] = json!({ "type": "object", "properties": { "u": { "$ref": "#/$defs/Either" } },
        "required": ["u"], "x-wb-order": ["u"], "x-wb-unknownKeys": "strip" });
    assert_eq!(
        shape(&answer(&defs, "Wrap", &json!({}))),
        vec![issue("u", Code::InvalidUnion, false)]
    );
}

#[test]
fn an_external_validator_judges_only_what_is_there() {
    let defs = json!({
        "Loud": { "type": "string", "x-wb-external": "./loud.js" },
        "Wrap": { "type": "object", "properties": { "l": { "$ref": "#/$defs/Loud" } },
            "required": ["l"], "x-wb-order": ["l"], "x-wb-unknownKeys": "strip" },
    });
    assert_eq!(
        shape(&answer(&defs, "Wrap", &json!({}))),
        vec![issue("l", Code::InvalidType, false)]
    );
    assert_eq!(
        answer(&defs, "Wrap", &json!({ "l": "a" })).expect("accepted"),
        val(&json!({ "l": "A" }))
    );
}
