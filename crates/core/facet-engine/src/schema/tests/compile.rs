//! What compiling a contract refuses, by name, and what it takes.

use serde_json::{Value as Json, json};
use whiteboard_model::Value;

use super::super::*;
use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[test]
fn a_keyword_the_dialect_does_not_have_is_refused_by_name() {
    let top = val(&json!({ "$defs": {}, "oneOf": [] }));
    let error = Contracts::load(&[("c.json", &top)], &host()).err().expect("refused");
    assert_eq!(error.refusal, Refusal::UnknownKeyword("oneOf".into()));
    let node = refusal(&json!({ "A": { "type": "string", "format": "email" } }));
    assert_eq!(node, Refusal::UnknownKeyword("format".into()));
    let arm = refusal(&json!({
        "A": { "oneOf": [{ "$ref": "#/$defs/B", "format": "x" }], "discriminator": { "propertyName": "k" } },
        "B": { "type": "object", "properties": { "k": { "type": "string", "const": "b" } },
            "x-wb-order": ["k"], "x-wb-unknownKeys": "strip" },
    }));
    assert_eq!(arm, Refusal::UnknownKeyword("format".into()));
}

#[test]
fn a_reference_outside_the_contracts_own_definitions_is_refused() {
    for target in ["#/definitions/A", "other.json#/$defs/A", "#/$defs/Missing", "A"] {
        let refused = refusal(&json!({ "A": { "type": "boolean" }, "B": { "$ref": target } }));
        assert_eq!(refused, Refusal::BadRef(target.into()), "{target}");
    }
    assert_eq!(
        refusal(&json!({ "A": { "type": "boolean" }, "B": { "$ref": 3 } })),
        Refusal::Malformed("a string")
    );
}

#[test]
fn a_definition_that_reaches_itself_is_refused() {
    let own = refusal(&json!({ "A": { "$ref": "#/$defs/A" } }));
    assert_eq!(own, Refusal::RefCycle("A".into()));
    let loop_of_two = refusal(&json!({
        "A": { "$ref": "#/$defs/B" },
        "B": { "type": "array", "items": { "$ref": "#/$defs/A" } },
    }));
    assert!(matches!(loop_of_two, Refusal::RefCycle(_)));
    let leads_to_it = refusal(&json!({
        "Leaf": { "type": "boolean" },
        "A": { "$ref": "#/$defs/A" },
        "B": { "$ref": "#/$defs/A" },
    }));
    assert_eq!(leads_to_it, Refusal::RefCycle("A".into()));
    // The same definition reached twice is no cycle.
    assert!(
        load(&json!({
            "Leaf": { "type": "boolean" },
            "Pair": { "type": "object", "properties": {
                "a": { "$ref": "#/$defs/Leaf" }, "b": { "$ref": "#/$defs/Leaf" },
            }, "required": ["a", "b"], "x-wb-order": ["a", "b"], "x-wb-unknownKeys": "strip" },
        }))
        .is_ok()
    );
}

#[test]
fn what_the_host_does_not_supply_is_refused_by_name() {
    let pattern = json!({ "type": "string", "pattern": "^x$", "x-wb-matcher": "upper" });
    assert_eq!(refusal(&json!({ "A": pattern })), Refusal::UnsuppliedMatcher("upper".into()));
    let check = json!({ "type": "string", "x-wb-check": "odd" });
    assert_eq!(refusal(&json!({ "A": check })), Refusal::UnsuppliedCheck("odd".into()));
    let external = json!({ "type": "string", "x-wb-external": "./x.js" });
    assert_eq!(refusal(&json!({ "Other": external })), Refusal::UnsuppliedExternal("Other".into()));
}

#[test]
fn a_pattern_without_its_matcher_is_refused() {
    let refused = refusal(&json!({ "A": { "type": "string", "pattern": "^x$" } }));
    assert_eq!(refused, Refusal::Malformed("a pattern has no x-wb-matcher"));
}

#[test]
fn the_constructs_only_the_model_port_has_are_refused_by_name() {
    let cases = [
        (json!({ "type": "integer" }), "integer"),
        (
            json!({ "type": "object", "properties": { "a": { "type": "string", "x-wb-lenient": true } },
            "x-wb-order": ["a"], "x-wb-unknownKeys": "strip" }),
            "x-wb-lenient",
        ),
        (
            json!({ "type": "object", "properties": { "a": { "type": "string" } },
            "x-wb-order": ["a"], "x-wb-unknownKeys": "keep" }),
            "x-wb-unknownKeys keep",
        ),
        (
            json!({ "type": "object", "properties": { "a": { "type": "string" } },
            "x-wb-order": ["a"], "x-wb-unknownKeys": "strip", "x-wb-extends": "Base" }),
            "x-wb-extends",
        ),
        (
            json!({ "type": "object", "properties": { "a": { "type": "string" } },
            "x-wb-order": ["a"], "x-wb-unknownKeys": "strip", "x-wb-check": "even" }),
            "x-wb-check on an object",
        ),
        (
            json!({ "type": "object", "additionalProperties": { "x-wb-any": true },
            "x-wb-check": "even" }),
            "x-wb-check on a record",
        ),
    ];
    for (node, name) in cases {
        assert_eq!(refusal(&json!({ "A": node })), Refusal::ModelOnly(name), "{name}");
    }
}

#[test]
fn a_keyword_of_the_wrong_shape_is_refused_where_it_stands() {
    let chunks = [
        malformed_shape_1,
        malformed_shape_2,
        malformed_shape_3,
        malformed_shape_4,
        malformed_nested_1,
        malformed_nested_2,
        malformed_nested_3,
    ];
    for (defs, what) in chunks.into_iter().flat_map(|chunk| chunk()) {
        assert_eq!(refusal(&defs), Refusal::Malformed(what), "{defs}");
    }
}

#[test]
fn a_bound_that_is_not_finite_is_refused() {
    for bound in [f64::INFINITY, f64::NAN] {
        let number = ordered(&[("type", text("number")), ("minimum", Value::Number(bound))]);
        let contract = ordered(&[("$defs", ordered(&[("A", number)]))]);
        let refused = Contracts::load(&[("c.json", &contract)], &host()).err();
        assert_eq!(refused.map(|e| e.refusal), Some(Refusal::Malformed("a finite number")));
    }
}

#[test]
fn a_contract_file_must_be_an_object_with_definitions() {
    let host = host();
    let load_raw = |contract: Json| Contracts::load(&[("c.json", &val(&contract))], &host);
    assert_eq!(load_raw(json!([])).err().map(|e| e.refusal), Some(Refusal::Malformed("an object")));
    assert_eq!(load_raw(json!({})).err().map(|e| e.refusal), Some(Refusal::Malformed("no $defs")));
    assert_eq!(
        load_raw(json!({ "$defs": [] })).err().map(|e| e.refusal),
        Some(Refusal::Malformed("an object"))
    );
    let one = val(&json!({ "$defs": {} }));
    let twice = Contracts::load(&[("c.json", &one), ("c.json", &one)], &host);
    assert_eq!(
        twice.err().map(|e| e.refusal),
        Some(Refusal::Malformed("a contract is loaded twice"))
    );
}

#[test]
fn an_external_definition_is_the_hosts_validator_or_its_own_shape() {
    let defs = json!({
        "Loud": { "type": "string", "x-wb-external": "./loud.js" },
        "Plain": { "type": "string", "enum": ["a"], "x-wb-external": "./plain.js" },
        "Quiet": { "type": "string", "x-wb-external": "" },
    });
    // `Quiet` has no supplier, so the contract is refused; without it, both load.
    assert_eq!(refusal(&defs), Refusal::UnsuppliedExternal("Quiet".into()));
    let defs = json!({
        "Loud": { "type": "string", "x-wb-external": "./loud.js" },
        "Plain": { "type": "string", "enum": ["a"], "x-wb-external": "./plain.js" },
    });
    assert_eq!(answer(&defs, "Loud", &json!("hey")), Ok(Value::String("HEY".into())));
    assert_eq!(shape(&answer(&defs, "Loud", &json!(3))), vec![issue("", Code::Custom, true)]);
    assert!(answer(&defs, "Plain", &json!("a")).is_ok());
    assert_eq!(
        shape(&answer(&defs, "Plain", &json!("b"))),
        vec![issue("", Code::InvalidValue, false)]
    );
}

#[test]
fn a_definition_is_found_by_the_pointer_a_manifest_writes() {
    let contracts = compiled(&json!({ "A": { "type": "boolean" }, "B": { "type": "number" } }));
    let a = contracts.resolve("c.json#/$defs/A").expect("A");
    assert_eq!(contracts.name(a), Some("A"));
    assert_ne!(contracts.resolve("c.json#/$defs/B"), Some(a));
    for pointer in ["c.json#/$defs/Missing", "d.json#/$defs/A", "c.json", "c.json#/defs/A"] {
        assert_eq!(contracts.resolve(pointer), None, "{pointer}");
    }
    let other = compiled(&json!({ "A": { "type": "boolean" } }));
    let foreign = other.resolve("c.json#/$defs/A").expect("A");
    assert_eq!(foreign, a);
    let empty = Contracts::load(&[], &host()).expect("an empty set loads");
    assert_eq!(empty.name(a), None);
    let refused = empty.validate(a, &Value::Null).expect_err("no such definition");
    assert_eq!(refused[0].code, Code::Custom);
}

#[test]
fn a_definition_declares_the_fields_of_the_object_it_is_or_names() {
    let contracts = compiled(&json!({
        "Mark": { "type": "object", "properties": { "tone": { "type": "string" } },
            "required": ["tone"], "x-wb-order": ["tone"], "x-wb-unknownKeys": "strip" },
        "Alias": { "$ref": "#/$defs/Mark" },
        "Text": { "type": "string" },
    }));
    let of = |name: &str| contracts.resolve(&format!("c.json#/$defs/{name}")).expect("a def");
    assert!(contracts.declares(of("Mark"), "tone"));
    assert!(contracts.declares(of("Alias"), "tone"));
    assert!(!contracts.declares(of("Mark"), "other"));
    assert!(!contracts.declares(of("Text"), "tone"));
    let empty = Contracts::load(&[], &host()).expect("an empty set loads");
    assert!(!empty.declares(of("Mark"), "tone"));
}

fn blob() -> Json {
    json!({ "type": "blob" })
}

/// A union definition naming one arm, with `extra` keywords added to it.
fn tagged(extra: &Json) -> Json {
    let mut defs = json!({
        "A": { "oneOf": [{ "$ref": "#/$defs/B" }], "discriminator": { "propertyName": "k" } },
        "B": { "type": "object", "properties": { "k": { "type": "string", "const": "b" } },
            "x-wb-order": ["k"], "x-wb-unknownKeys": "strip" },
    });
    for (key, value) in extra.as_object().into_iter().flatten() {
        defs["A"][key] = value.clone();
    }
    defs
}

/// A string definition with `extra` keywords added to it.
fn string(extra: &Json) -> Json {
    let mut node = json!({ "type": "string" });
    for (key, value) in extra.as_object().into_iter().flatten() {
        node[key] = value.clone();
    }
    json!({ "A": node })
}

fn malformed_shape_1() -> Vec<(Json, &'static str)> {
    vec![
        (json!({ "A": 3 }), "an object"),
        (json!({ "A": { "type": 3 } }), "a string"),
        (json!({ "A": { "type": "blob" } }), "an unknown type"),
        (json!({ "A": { "description": "x" } }), "no type, $ref, anyOf, oneOf or x-wb-any"),
        (json!({ "A": { "type": "string", "x-wb-minUtf16": -1 } }), "a whole non-negative number"),
        (json!({ "A": { "type": "string", "x-wb-minUtf16": 1.5 } }), "a whole non-negative number"),
        (json!({ "A": { "type": "string", "enum": "abc" } }), "a list"),
        (json!({ "A": { "type": "string", "enum": [1] } }), "a string"),
    ]
}

fn malformed_shape_2() -> Vec<(Json, &'static str)> {
    vec![
        (json!({ "A": { "type": "string", "const": 1 } }), "a string"),
        (json!({ "A": { "type": "number", "minimum": "0" } }), "a finite number"),
        (json!({ "A": { "type": "array" } }), "an array has no items"),
        (
            json!({ "A": { "type": "array", "items": { "type": "boolean" }, "x-wb-maxItemsMessage": 1,
            "maxItems": 1 } }),
            "a string",
        ),
        (json!({ "A": { "type": "object" } }), "a record has no additionalProperties"),
        (
            json!({ "A": { "type": "object", "additionalProperties": { "x-wb-any": true },
            "maxProperties": 1 } }),
            "maxProperties and its message need each other",
        ),
        (
            json!({ "A": { "type": "object", "properties": {}, "x-wb-unknownKeys": "other" } }),
            "x-wb-unknownKeys is refuse or strip",
        ),
        (
            json!({ "A": { "type": "object", "properties": {}, "x-wb-unknownKeys": "strip" } }),
            "an object has properties and x-wb-order",
        ),
    ]
}

fn malformed_shape_3() -> Vec<(Json, &'static str)> {
    vec![
        (
            json!({ "A": { "type": "object", "properties": {}, "x-wb-unknownKeys": "strip",
            "x-wb-order": ["gone"] } }),
            "x-wb-order names a property that is not declared",
        ),
        (
            json!({ "A": { "type": "object", "properties": { "a": { "type": "boolean", "default": 3 } },
            "x-wb-unknownKeys": "strip", "x-wb-order": ["a"] } }),
            "a default is an empty list or an empty object",
        ),
        (
            json!({ "A": { "type": "object", "properties": { "a": { "type": "boolean", "default": [1] } },
            "x-wb-unknownKeys": "strip", "x-wb-order": ["a"] } }),
            "a default is an empty list or an empty object",
        ),
        (
            json!({ "A": { "type": "object", "properties": 3, "x-wb-unknownKeys": "strip",
            "x-wb-order": [] } }),
            "an object",
        ),
        (
            json!({ "A": { "type": "object", "properties": { "a": 3 }, "x-wb-unknownKeys": "strip",
            "x-wb-order": ["a"] } }),
            "an object",
        ),
        (json!({ "A": { "anyOf": 3 } }), "a list"),
        (json!({ "A": { "oneOf": [] } }), "a oneOf needs its discriminator"),
        (json!({ "A": { "oneOf": [], "discriminator": 3 } }), "an object"),
    ]
}

fn malformed_shape_4() -> Vec<(Json, &'static str)> {
    vec![
        (
            json!({ "A": { "oneOf": [], "discriminator": {} } }),
            "a discriminator needs its propertyName",
        ),
        (json!({ "A": { "oneOf": [], "discriminator": { "propertyName": 3 } } }), "a string"),
        (json!({ "A": { "oneOf": [3], "discriminator": { "propertyName": "k" } } }), "an object"),
        (
            json!({ "A": { "oneOf": [{ "type": "boolean" }], "discriminator": { "propertyName": "k" } } }),
            "a union arm is a $ref to a definition",
        ),
        (
            json!({ "A": { "oneOf": [{ "$ref": "#/$defs/B" }], "discriminator": { "propertyName": "k" } },
            "B": { "type": "boolean" } }),
            "a union arm names its tag as a const",
        ),
        (
            json!({ "A": { "oneOf": [{ "$ref": "#/$defs/B" }], "discriminator": { "propertyName": "k" } },
            "B": { "type": "object", "properties": { "k": { "type": "string" } },
                "x-wb-order": ["k"], "x-wb-unknownKeys": "strip" } }),
            "a union arm names its tag as a const",
        ),
        (
            json!({ "A": { "oneOf": [{ "$ref": "#/$defs/B" }], "discriminator": { "propertyName": "k" } },
            "B": { "type": "object", "properties": { "j": { "type": "string" } },
                "x-wb-order": ["j"], "x-wb-unknownKeys": "strip" } }),
            "a union arm names its tag as a const",
        ),
    ]
}

/// A bad keyword inside each place a node holds another: the refusal reaches
/// the caller from every depth.
fn malformed_nested_1() -> Vec<(Json, &'static str)> {
    vec![
        (json!({ "A": { "type": "array", "items": 3 } }), "an object"),
        (json!({ "A": { "type": "array", "items": blob() } }), "an unknown type"),
        (json!({ "A": { "anyOf": [blob()] } }), "an unknown type"),
        (tagged(&json!({ "oneOf": 3 })), "a list"),
        (
            json!({ "A": { "oneOf": [{ "$ref": "#/$defs/B" }], "discriminator": { "propertyName": "k" } },
            "B": 3 }),
            "an object",
        ),
        (
            json!({ "A": { "oneOf": [{ "$ref": "#/$defs/B" }], "discriminator": { "propertyName": "k" } },
            "B": { "type": "object", "properties": { "k": 3 }, "x-wb-order": ["k"],
                "x-wb-unknownKeys": "strip" } }),
            "a union arm names its tag as a const",
        ),
        (string(&json!({ "x-wb-check": 3 })), "a string"),
        (string(&json!({ "x-wb-matcher": 3 })), "a string"),
    ]
}

fn malformed_nested_2() -> Vec<(Json, &'static str)> {
    vec![
        (
            string(&json!({ "pattern": "^x$", "x-wb-matcher": "lower", "x-wb-message": 3 })),
            "a string",
        ),
        (json!({ "A": { "type": "number", "exclusiveMinimum": "0" } }), "a finite number"),
        (
            json!({ "A": { "type": "array", "items": { "type": "boolean" }, "minItems": "1" } }),
            "a whole non-negative number",
        ),
        (
            json!({ "A": { "type": "array", "items": { "type": "boolean" }, "maxItems": 1.5 } }),
            "a whole non-negative number",
        ),
        (json!({ "A": { "type": "object", "additionalProperties": blob() } }), "an unknown type"),
        (
            json!({ "A": { "type": "object", "additionalProperties": { "x-wb-any": true },
            "propertyNames": blob() } }),
            "an unknown type",
        ),
        (
            json!({ "A": { "type": "object", "additionalProperties": { "x-wb-any": true },
            "maxProperties": "2", "x-wb-maxPropertiesMessage": "m" } }),
            "a whole non-negative number",
        ),
        (
            json!({ "A": { "type": "object", "additionalProperties": { "x-wb-any": true },
            "maxProperties": 2, "x-wb-maxPropertiesMessage": 3 } }),
            "a string",
        ),
    ]
}

fn malformed_nested_3() -> Vec<(Json, &'static str)> {
    vec![
        (
            json!({ "A": { "type": "object", "properties": {}, "x-wb-unknownKeys": 3, "x-wb-order": [] } }),
            "a string",
        ),
        (
            json!({ "A": { "type": "object", "properties": {}, "x-wb-unknownKeys": "strip",
            "x-wb-order": [], "required": "a" } }),
            "a list",
        ),
        (
            json!({ "A": { "type": "object", "properties": {}, "x-wb-unknownKeys": "strip",
            "x-wb-order": "a" } }),
            "a list",
        ),
    ]
}
