#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| whiteboard_fuzz::targets::edge_route_layout(data));
