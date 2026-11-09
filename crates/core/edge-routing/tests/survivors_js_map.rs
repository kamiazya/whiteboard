//! `JsMap` answers that cargo-mutants showed no other test pinned. The
//! oracle is the JavaScript `Map` it mirrors: `map.size === 0`.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::js_map::JsMap;

#[test]
fn a_map_is_empty_until_set_and_again_after_its_last_delete() {
    let mut map: JsMap<u32, &str> = JsMap::default();
    assert!(map.is_empty());
    map.set(7, "a");
    assert!(!map.is_empty());
    assert!(map.delete(&7));
    assert!(map.is_empty());
}
