//! The style-randomness primitive (`layout/seed.ts`, package-canvas-render.md
//! decision #10): every "random" choice a style makes is a pure function of a
//! node's identity, never of ambient state or of geometry, so a styled canvas
//! renders byte-identically twice and a moved box draws the same ink moved.

/// FNV-1a over the UTF-16 code units of `id`, as an unsigned 32-bit seed. Chosen
/// for determinism and no dependencies, not for cryptography: a collision only
/// makes two nodes share a jitter pattern.
///
/// The TypeScript multiplies by the FNV prime through shifts in 32-bit integer
/// arithmetic, which is the product modulo 2^32: a wrapping multiply.
#[must_use]
pub fn seed_from_id(id: &str) -> u32 {
    id.encode_utf16()
        .fold(0x811c_9dc5_u32, |hash, unit| (hash ^ u32::from(unit)).wrapping_mul(16_777_619))
}
