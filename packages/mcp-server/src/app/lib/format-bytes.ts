// Render a byte count as a short human-readable label. Two significant
// digits at MiB+ resolution is enough for the storage footer; we only need
// users to spot orders-of-magnitude differences at a glance.
//
// Binary units (KiB / MiB / GiB) match what users see in macOS Finder /
// Linux du -h and are unambiguous in a system-administration context.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  // Show no decimals for raw bytes, one decimal for KiB+, to keep widths
  // tight in the IndexPage footer.
  let formatted = unit === 0 ? Math.round(value).toString() : value.toFixed(1)
  // Values just under a unit boundary (e.g. 1023.6 B) survive the division
  // loop but round up to a displayed "1024" — bump to the next unit instead
  // of showing "1024 B" / "1024.0 KiB". At the TiB cap the rounding stands.
  if ((formatted === '1024' || formatted === '1024.0') && unit < UNITS.length - 1) {
    unit += 1
    formatted = '1.0'
  }
  return `${formatted} ${UNITS[unit]}`
}
