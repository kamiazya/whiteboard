//! `ln` against `Math.log`'s bits on Node 24, as `bits(x) bits(Math.log(x))`
//! per line: the shapes a BM25 idf takes (`1 + (n - c + 0.5) / (c + 0.5)`),
//! a seeded stream across the exponent range, values within 2**-20 of one,
//! and the subnormal and extreme doubles. Frozen: it is V8's answer, and
//! `libm`'s `log` fails it.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_det::fdlibm::ln;

const RECORDING: &str = include_str!("ln_v8.txt");

#[test]
fn ln_answers_every_recorded_double_bit_for_bit() {
    let mut replayed = 0;
    for line in RECORDING.lines() {
        let (input, answer) = line.split_once(' ').unwrap_or_default();
        let input = f64::from_bits(u64::from_str_radix(input, 16).unwrap_or_default());
        let answer = u64::from_str_radix(answer, 16).unwrap_or_default();
        assert_eq!(ln(input).to_bits(), answer, "ln({input:e})");
        replayed += 1;
    }
    assert_eq!(replayed, 1466);
}
