//! `edge_route_layout` against the recorded TypeScript answers, bit for bit.
//!
//! canvas-render's `recorded-oracle.test.ts` writes `oracle/route_layout.f64`
//! from the TypeScript composer and fails when the file no longer equals what
//! the TypeScript answers. This replays it natively, which is what lets
//! cargo-mutants judge the edge crate's mutants by the same oracle the wasm
//! differentials use (QR-17). Format: `[count, then per case: input length,
//! input, answer length, answer]`, little-endian f64.

use whiteboard_wasm::spatial_edges::edge_route_layout;

fn recording() -> Vec<f64> {
    let bytes = include_bytes!("oracle/route_layout.f64");
    bytes
        .chunks_exact(8)
        .map(|c| <[u8; 8]>::try_from(c).map_or(f64::NAN, f64::from_le_bytes))
        .collect()
}

/// The whole, non-negative count at `at`.
fn count_at(values: &[f64], at: usize) -> usize {
    let n = values.get(at).copied().unwrap_or(f64::NAN);
    assert!(n >= 0.0 && n.fract() == 0.0 && n < 1e9, "the count at {at} is {n}");
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked whole, non-negative and small on the line above"
    )]
    let n = n as usize;
    n
}

/// The recorded cases as (input, answer) slices.
fn cases(values: &[f64]) -> Vec<(&[f64], &[f64])> {
    let take = |at: &mut usize| -> &[f64] {
        let len = count_at(values, *at);
        let start = *at + 1;
        *at = start + len;
        values.get(start..start + len).unwrap_or_default()
    };
    let mut at = 1;
    let out: Vec<_> = (0..count_at(values, 0)).map(|_| (take(&mut at), take(&mut at))).collect();
    assert_eq!(at, values.len(), "the recording has bytes past its last case");
    out
}

#[test]
fn every_recorded_layout_is_answered_as_the_typescript_answered_it() {
    let values = recording();
    let cases = cases(&values);
    assert!(cases.len() > 300, "{} recorded cases", cases.len());
    for (i, (input, answer)) in cases.iter().enumerate() {
        let out = edge_route_layout(input);
        let parts = out.iter().zip(answer.iter()).position(|(a, b)| a.to_bits() != b.to_bits());
        assert!(
            parts.is_none() && out.len() == answer.len(),
            "case {i}: parts at {parts:?} (rust {} numbers, recorded {})",
            out.len(),
            answer.len(),
        );
    }
}
