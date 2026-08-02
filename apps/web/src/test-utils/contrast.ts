/**
 * WCAG 2.x relative luminance / contrast ratio, computed from sRGB hex —
 * test-only. Used to check editor theme palettes against their canvas
 * surface by formula (WCAG 1.4.3 / 1.4.11) instead of eyeballing colors.
 */

function channelToLinear(channel8bit: number): number {
  const c = channel8bit / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Relative luminance of an sRGB `#rrggbb` color. */
function relativeLuminance(hex: string): number {
  const rgb = hex.replace('#', '')
  const r = channelToLinear(Number.parseInt(rgb.slice(0, 2), 16))
  const g = channelToLinear(Number.parseInt(rgb.slice(2, 4), 16))
  const b = channelToLinear(Number.parseInt(rgb.slice(4, 6), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, always >= 1. */
export function contrast(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}
