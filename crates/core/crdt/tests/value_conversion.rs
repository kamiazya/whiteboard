//! A loro value as npm loro-crdt's `toJSON` hands it to JavaScript.

use loro::{ContainerID, ContainerType, ID, LoroValue};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::loro_value_to_value;
use whiteboard_model::Value;

#[test]
fn the_largest_safe_integer_is_exact() {
    let n = 9_007_199_254_740_991_i64;
    assert_eq!(loro_value_to_value(&LoroValue::I64(n)), Value::Number(9_007_199_254_740_991.0));
    assert_eq!(loro_value_to_value(&LoroValue::I64(-n)), Value::Number(-9_007_199_254_740_991.0));
}

#[test]
fn an_integer_past_two_to_the_53_is_the_number_javascript_rounds_it_to() {
    // 2^53 + 1 has no double; JavaScript holds 2^53.
    assert_eq!(
        loro_value_to_value(&LoroValue::I64(9_007_199_254_740_993)),
        Value::Number(9_007_199_254_740_992.0)
    );
    // npm loro-crdt answers 2^62 as 4611686018427388000, the double 2^62.
    assert_eq!(
        loro_value_to_value(&LoroValue::I64(1 << 62)),
        Value::Number(4_611_686_018_427_387_904.0)
    );
}

#[test]
fn an_unresolved_container_is_its_id_as_loro_crdt_prints_it() {
    let root = ContainerID::new_root("doc", ContainerType::Map);
    assert_eq!(
        loro_value_to_value(&LoroValue::Container(root)),
        Value::String("cid:root-doc:Map".to_owned())
    );
    let child = ContainerID::new_normal(ID::new(7, 4), ContainerType::List);
    assert_eq!(
        loro_value_to_value(&LoroValue::Container(child)),
        Value::String("cid:4@7:List".to_owned())
    );
}
