//! Big-endian reads that answer `None` past the end instead of indexing.

pub(super) fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    let end = at.checked_add(2)?;
    <[u8; 2]>::try_from(data.get(at..end)?).ok().map(u16::from_be_bytes)
}

pub(super) fn i16_at(data: &[u8], at: usize) -> Option<i16> {
    u16_at(data, at).map(|v| i16::from_be_bytes(v.to_be_bytes()))
}

pub(super) fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    let end = at.checked_add(4)?;
    <[u8; 4]>::try_from(data.get(at..end)?).ok().map(u32::from_be_bytes)
}

/// `u32` as an index; a platform narrower than 32 bits answers `usize::MAX`,
/// which every bounds check then refuses.
pub(super) fn index(value: u32) -> usize {
    usize::try_from(value).unwrap_or(usize::MAX)
}
