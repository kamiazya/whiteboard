#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| whiteboard_fuzz::targets::search_wasm(data));
