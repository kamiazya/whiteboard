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
  const formatted = unit === 0 ? Math.round(value).toString() : value.toFixed(1)
  return `${formatted} ${UNITS[unit]}`
}
