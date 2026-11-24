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
fn an_external_left_to_text_that_is_not_json_is_refused() {
    let host = Host {
        matchers: &[],
        checks: &[],
        externals: &[("Color", External::Defined { contract: "{", validator: None })],
    };
    let contract = parse(r#"{"$defs": {"Color": {"type": "string", "x-wb-external": "m"}}}"#);
    let refused = Contracts::load(&[("c.json", &contract)], &host).err();
    let malformed = Refusal::Malformed("an external's contract is not JSON");
    assert_eq!(refused, Some(CompileError { at: "c.json".to_owned(), refusal: malformed }));
}
