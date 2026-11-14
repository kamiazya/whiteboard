//! The digest the TypeScript recorders keep of a canonical tree.

/// FNV-1a 64 over the UTF-8 of `text`, as 16 hex digits.
pub(crate) fn fnv64(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}
