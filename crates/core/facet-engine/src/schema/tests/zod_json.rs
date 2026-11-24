//! `published` held to what `z.toJSONSchema` (Zod 4.6.7) answered for the Zod
//! `cargo xtask codegen` generates from each contract below, every construct
//! of the dialect the facet walk compiles reached once. The expected texts
//! were printed by Zod for that generated Zod, written out by hand.

use whiteboard_model::{Value, json};

use super::super::{CompileError, Contracts, External, Host, Refusal};
use super::lower;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A contract the generator leaves `Color` to, as the model's is.
const MODEL: &str = r##"{"$defs": {
    "Pre": {"type": "string", "enum": ["1"]},
    "Hex": {"type": "string", "pattern": "^#$", "x-wb-matcher": "lower"},
    "Color": {"anyOf": [{"$ref": "#/$defs/Pre"}, {"$ref": "#/$defs/Hex"}], "x-wb-registered": true}
}}"##;

const PLAIN: &str = r##"{"$defs": {
    "Key": {"type": "string", "pattern": "^[a-z]+$", "x-wb-matcher": "lower"},
    "Reg": {"type": "string", "x-wb-minUtf16": 2, "x-wb-registered": true},
    "Arm1": {"type": "object", "properties": {"k": {"type": "string", "const": "a"}},
        "required": ["k"], "x-wb-order": ["k"], "additionalProperties": false, "x-wb-unknownKeys": "refuse"},
    "Arm2": {"type": "object", "properties": {"k": {"type": "string", "const": "b"}, "n": {"type": "number"}},
        "required": ["k", "n"], "x-wb-order": ["k", "n"], "additionalProperties": true, "x-wb-unknownKeys": "strip"},
    "Either": {"anyOf": [{"$ref": "#/$defs/Arm1"}, {"$ref": "#/$defs/Arm2"}], "x-wb-describe": "one or other"},
    "Tagged": {"oneOf": [{"$ref": "#/$defs/Arm1"}, {"$ref": "#/$defs/Arm2"}], "discriminator": {"propertyName": "k"}},
    "Capped": {"type": "object", "propertyNames": {"$ref": "#/$defs/Key"}, "additionalProperties": {"type": "boolean"},
        "maxProperties": 2, "x-wb-maxPropertiesMessage": "at most 2, not {count}"},
    "All": {"type": "object", "properties": {
        "s": {"type": "string", "x-wb-minUtf16": 1, "pattern": "^[a-z]+$", "x-wb-matcher": "lower", "x-wb-check": "even"},
        "e": {"type": "string", "enum": ["x", "y"]},
        "n": {"type": "number", "minimum": 0},
        "g": {"type": "number", "exclusiveMinimum": 1.5},
        "b": {"type": "boolean"},
        "a": {"type": "array", "items": {"$ref": "#/$defs/Reg"}, "minItems": 1, "maxItems": 3, "x-wb-maxItemsMessage": "too many"},
        "r": {"type": "object", "additionalProperties": {"x-wb-any": true}, "default": {}},
        "l": {"type": "array", "items": {"type": "string"}, "default": []},
        "m": {"$ref": "#/$defs/Capped", "x-wb-describe": "capped map"},
        "u": {"$ref": "#/$defs/Either"},
        "t": {"$ref": "#/$defs/Tagged"},
        "o": {"$ref": "#/$defs/Reg", "x-wb-describe": "optional reg"},
        "q": {"$ref": "#/$defs/Reg", "x-wb-describe": "required reg"},
        "x": {"x-wb-any": true}
    }, "required": ["s", "e", "n", "g", "a", "m", "u", "t", "q", "x"],
    "x-wb-order": ["s", "e", "n", "g", "b", "a", "r", "l", "m", "u", "t", "o", "q", "x"],
    "additionalProperties": false, "x-wb-unknownKeys": "refuse"}
}}"##;

const DESCRIBED: &str = r##"{"x-wb-describe": true, "$defs": {
    "Color": {"description": "colour", "type": "string", "x-wb-external": "../m.js"},
    "Kind": {"description": "a kind", "type": "string", "enum": ["p", "q"]},
    "Inner": {"description": "inner obj", "type": "object",
        "properties": {"v": {"type": "string", "description": "v field"}},
        "required": ["v"], "x-wb-order": ["v"], "additionalProperties": false, "x-wb-unknownKeys": "refuse"},
    "Named": {"description": "named reg", "type": "string", "x-wb-registered": true},
    "Capped": {"description": "capped", "type": "object", "propertyNames": {"$ref": "#/$defs/Kind"},
        "additionalProperties": {"type": "boolean"}, "maxProperties": 1, "x-wb-maxPropertiesMessage": "{count}"},
    "Top": {"description": "top", "type": "object", "properties": {
        "k": {"$ref": "#/$defs/Kind", "description": "kind field"},
        "ko": {"$ref": "#/$defs/Kind", "description": "kind opt"},
        "io": {"$ref": "#/$defs/Inner", "description": "io"},
        "nm": {"$ref": "#/$defs/Named", "description": "named"},
        "c": {"$ref": "#/$defs/Color", "description": "col"},
        "cap": {"$ref": "#/$defs/Capped", "description": "cap field"},
        "cl": {"type": "array", "items": {"$ref": "#/$defs/Capped"}, "description": "list"}
    }, "required": ["k", "nm", "cap", "cl"], "x-wb-order": ["k", "ko", "io", "nm", "c", "cap", "cl"],
    "additionalProperties": true, "x-wb-unknownKeys": "strip"}
}}"##;

fn parse(text: &str) -> Value {
    json::parse(text).expect("JSON")
}

fn even(text: &str) -> bool {
    text.len().is_multiple_of(2)
}

fn published(contract: &str, name: &str) -> Option<Value> {
    let host = Host {
        matchers: &[("lower", lower)],
        checks: &[("even", even)],
        externals: &[
            ("Color", External::Defined { contract: MODEL, validator: None }),
            // Supplied for a definition that is not external: never read.
            ("Key", External::Defined { contract: MODEL, validator: None }),
        ],
    };
    let contract = parse(contract);
    let contracts = Contracts::load(&[("c.json", &contract)], &host).expect("it compiles");
    contracts.published(contracts.resolve(&format!("c.json#/$defs/{name}"))?)
}

#[test]
fn every_construct_is_written_as_zod_writes_it() {
    let zod = r##"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"s":{"type":"string","minLength":1,"pattern":"^[a-z]+$"},"e":{"type":"string","enum":["x","y"]},"n":{"type":"number","minimum":0},"g":{"type":"number","exclusiveMinimum":1.5},"b":{"type":"boolean"},"a":{"minItems":1,"maxItems":3,"type":"array","items":{"$ref":"#/$defs/Reg"}},"r":{"default":{},"type":"object","propertyNames":{"type":"string"},"additionalProperties":{}},"l":{"default":[],"type":"array","items":{"type":"string"}},"m":{"description":"capped map","type":"object","propertyNames":{"type":"string","pattern":"^[a-z]+$"},"additionalProperties":{"type":"boolean"}},"u":{"anyOf":[{"type":"object","properties":{"k":{"type":"string","const":"a"}},"required":["k"],"additionalProperties":false},{"type":"object","properties":{"k":{"type":"string","const":"b"},"n":{"type":"number"}},"required":["k","n"],"additionalProperties":false}],"description":"one or other"},"t":{"oneOf":[{"type":"object","properties":{"k":{"type":"string","const":"a"}},"required":["k"],"additionalProperties":false},{"type":"object","properties":{"k":{"type":"string","const":"b"},"n":{"type":"number"}},"required":["k","n"],"additionalProperties":false}]},"o":{"description":"optional reg","$ref":"#/$defs/Reg"},"q":{"description":"required reg","$ref":"#/$defs/Reg"},"x":{}},"required":["s","e","n","g","a","r","l","m","u","t","q","x"],"additionalProperties":false,"$defs":{"Reg":{"type":"string","minLength":2}}}"##;
    assert_eq!(published(PLAIN, "All"), Some(parse(zod)));
}

#[test]
fn a_described_contract_describes_as_zod_wraps_and_registers() {
    let zod = r##"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"k":{"type":"string","enum":["p","q"],"description":"kind field"},"ko":{"description":"kind opt","type":"string","enum":["p","q"]},"io":{"description":"io","type":"object","properties":{"v":{"type":"string","description":"v field"}},"required":["v"],"additionalProperties":false},"nm":{"description":"named","$ref":"#/$defs/Named"},"c":{"description":"col","$ref":"#/$defs/Color"},"cap":{"description":"cap field","type":"object","propertyNames":{"type":"string","enum":["p","q"],"description":"a kind"},"additionalProperties":{"type":"boolean"},"required":["p","q"]},"cl":{"type":"array","items":{"type":"object","propertyNames":{"type":"string","enum":["p","q"],"description":"a kind"},"additionalProperties":{"type":"boolean"},"required":["p","q"]},"description":"list"}},"required":["k","nm","cap","cl"],"additionalProperties":false,"description":"top","$defs":{"Named":{"type":"string"},"Color":{"anyOf":[{"type":"string","enum":["1"]},{"type":"string","pattern":"^#$"}]}}}"##;
    assert_eq!(published(DESCRIBED, "Top"), Some(parse(zod)));
}

#[test]
fn a_registered_root_is_a_reference_beside_its_definition() {
    let zod = r##"{"$schema":"https://json-schema.org/draft/2020-12/schema","$ref":"#/$defs/Named","$defs":{"Named":{"type":"string"}}}"##;
    assert_eq!(published(DESCRIBED, "Named"), Some(parse(zod)));
    assert_eq!(published(DESCRIBED, "Missing"), None);
}

#[test]
fn an_external_left_to_text_that_is_not_a_contract_is_refused() {
    let contract = parse(r#"{"$defs": {"Color": {"type": "string", "x-wb-external": "m"}}}"#);
    for text in ["{", "{}", r#"{"$defs": []}"#] {
        let host = Host {
            matchers: &[],
            checks: &[],
            externals: &[("Color", External::Defined { contract: text, validator: None })],
        };
        let refused = Contracts::load(&[("c.json", &contract)], &host).err();
        let malformed = Refusal::Malformed("an external's contract is not JSON with $defs");
        assert_eq!(refused, Some(CompileError { at: "c.json".to_owned(), refusal: malformed }));
    }
}

/// A record whose keys are a closed set names every key `required`, as Zod's
/// record writes the `_zod.values` of its key: a constant, an enum, a union
/// of those; a union with an open arm names none.
#[test]
fn a_record_over_a_closed_key_set_requires_every_key() {
    let keys = r##"{"$defs": {
        "OnlyK": {"type": "string", "const": "k"},
        "Xy": {"type": "string", "enum": ["x", "y"]},
        "Kxy": {"anyOf": [{"$ref": "#/$defs/OnlyK"}, {"$ref": "#/$defs/Xy"}]},
        "Open": {"anyOf": [{"$ref": "#/$defs/OnlyK"}, {"type": "string"}]},
        "Keys": {"type": "object", "properties": {
            "kk": {"type": "object", "propertyNames": {"$ref": "#/$defs/OnlyK"},
                "additionalProperties": {"type": "boolean"}},
            "ku": {"type": "object", "propertyNames": {"$ref": "#/$defs/Kxy"},
                "additionalProperties": {"type": "boolean"}},
            "ko": {"type": "object", "propertyNames": {"$ref": "#/$defs/Open"},
                "additionalProperties": {"type": "boolean"}}
        }, "required": ["kk", "ku", "ko"], "x-wb-order": ["kk", "ku", "ko"],
        "additionalProperties": false, "x-wb-unknownKeys": "refuse"}
    }}"##;
    let zod = r#"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"kk":{"type":"object","propertyNames":{"type":"string","const":"k"},"additionalProperties":{"type":"boolean"},"required":["k"]},"ku":{"type":"object","propertyNames":{"anyOf":[{"type":"string","const":"k"},{"type":"string","enum":["x","y"]}]},"additionalProperties":{"type":"boolean"},"required":["k","x","y"]},"ko":{"type":"object","propertyNames":{"anyOf":[{"type":"string","const":"k"},{"type":"string"}]},"additionalProperties":{"type":"boolean"}}},"required":["kk","ku","ko"],"additionalProperties":false}"#;
    assert_eq!(published(keys, "Keys"), Some(parse(zod)));
}

/// The generator writes an object's properties in `x-wb-order`, which is the
/// order Zod's JSON Schema lists them in, whatever order the contract
/// declares them in.
#[test]
fn properties_are_written_in_the_order_the_contract_names() {
    let reordered = r#"{"$defs": {"Pair": {"type": "object",
        "properties": {"b": {"type": "string"}, "a": {"type": "boolean"}},
        "required": ["b", "a"], "x-wb-order": ["a", "b"],
        "additionalProperties": false, "x-wb-unknownKeys": "refuse"}}}"#;
    let zod = r#"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"a":{"type":"boolean"},"b":{"type":"string"}},"required":["a","b"],"additionalProperties":false}"#;
    assert_eq!(published(reordered, "Pair"), Some(parse(zod)));
}

/// A contract a definition is left to is not compiled, so it is published
/// however it is written: a member of a shape the dialect does not have
/// constrains nothing, an order names what it can, and a root referenced
/// twice inside itself is `#` both times.
#[test]
fn a_definition_left_to_an_uncompiled_contract_is_published_as_written() {
    const OTHER: &str = r##"{"$defs": {
        "Odd": {"type": "object", "properties": 5},
        "Listed": {"type": "array", "items": 7},
        "Ordered": {"type": "object", "properties": {"a": {"type": "string"}}, "x-wb-order": [1, "a"]},
        "Twice": {"type": "object", "properties": {
            "l": {"$ref": "#/$defs/Twice"}, "r": {"$ref": "#/$defs/Twice"}}}
    }}"##;
    const LEFT: External = External::Defined { contract: OTHER, validator: None };
    let host = Host {
        matchers: &[],
        checks: &[],
        externals: &[("Odd", LEFT), ("Listed", LEFT), ("Ordered", LEFT), ("Twice", LEFT)],
    };
    let left = |name: &str| format!(r#""{name}": {{"type": "string", "x-wb-external": "m"}}"#);
    let names = ["Odd", "Listed", "Ordered", "Twice"];
    let defs: Vec<String> = names.iter().map(|name| left(name)).collect();
    let contract = parse(&format!(r#"{{"$defs": {{{}}}}}"#, defs.join(",")));
    let contracts = Contracts::load(&[("c.json", &contract)], &host).expect("it compiles");
    let published = |name: &str| {
        contracts.published(contracts.resolve(&format!("c.json#/$defs/{name}")).expect("held"))
    };
    let dialect = r#""$schema":"https://json-schema.org/draft/2020-12/schema""#;
    let object = |properties: &str| {
        parse(&format!(
            r#"{{{dialect},"type":"object","properties":{properties},"additionalProperties":false}}"#
        ))
    };
    assert_eq!(published("Odd"), Some(object("{}")));
    assert_eq!(
        published("Listed"),
        Some(parse(&format!(r#"{{{dialect},"type":"array","items":{{}}}}"#)))
    );
    assert_eq!(published("Ordered"), Some(object(r#"{"a":{"type":"string"}}"#)));
    assert_eq!(published("Twice"), Some(object(r##"{"l":{"$ref":"#"},"r":{"$ref":"#"}}"##)));
}
