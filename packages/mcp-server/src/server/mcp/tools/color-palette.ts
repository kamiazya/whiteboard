// Semantic color palette for whiteboard annotations. It lets MCP callers use
// meaningful names instead of memorizing hex values.
export const SEMANTIC_PALETTE = {
  primary: '#1971c2',
  success: '#2f9e44',
  danger: '#e03131',
  warning: '#f08c00',
  neutral: '#6c757d',
  info: '#0c8599',
} as const satisfies Record<string, string>

export type SemanticColorKey = keyof typeof SEMANTIC_PALETTE

const PALETTE_KEYS: ReadonlySet<string> = new Set(Object.keys(SEMANTIC_PALETTE))
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/
export const DEFAULT_PALETTE_FALLBACK = '#999999'

// Normalize an input color.
// - undefined passes through so the caller can use DEFAULT_COLORS
// - semantic keys (case-insensitive) map to SEMANTIC_PALETTE hex values
// - everything else (hex, CSS color names, unknown tokens) passes through to Excalidraw
export function normalizeColor(input: string | undefined): string | undefined {
  if (input === undefined) return undefined
  const lower = input.toLowerCase()
  if (PALETTE_KEYS.has(lower)) {
    return SEMANTIC_PALETTE[lower as SemanticColorKey]
  }
  return input
}

export interface PaletteResolution {
  color: string
  warningKey?: string
}

export function isExplicitHexColor(input: string): boolean {
  return HEX_COLOR_RE.test(input)
}

// WCAG 2.x relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance).
// Returns null for anything that isn't a 3/6-digit hex color — CSS named
// colors pass through this module unresolved, and the contrast guard simply
// skips them rather than guessing.
export function relativeLuminance(hex: string): number | null {
  // Accepts 3/4/6/8-digit hex. An alpha channel (4th/8th) is dropped: the
  // effective luminance of a translucent fill depends on the canvas behind
  // it, which is unknown here, so the guard treats the color as opaque.
  const m = /^#(?:([0-9a-f]{3,4})|([0-9a-f]{6})|([0-9a-f]{8}))$/i.exec(hex)
  if (!m) return null
  let digits: string
  if (m[1]) {
    digits = [...m[1].slice(0, 3)].map((c) => c + c).join('')
  } else {
    digits = (m[2] ?? m[3]!).slice(0, 6)
  }
  const channel = (i: number) => {
    const v = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

// WCAG contrast ratio, 1 (identical) .. 21 (black on white). Null when either
// side isn't parseable hex.
export function contrastRatio(hexA: string, hexB: string): number | null {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  if (la === null || lb === null) return null
  const [dark, light] = la < lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

// Inks used when the guard replaces an unreadable one. The dark ink matches
// DEFAULT_COLORS.text in annotate.ts; the light one is plain white — both
// clear WCAG large-text contrast (3:1) against any fill the other doesn't.
export const READABLE_DARK_INK = '#1e1e2e'
export const READABLE_LIGHT_INK = '#ffffff'

export function readableInkForFill(fillHex: string): string | null {
  const lum = relativeLuminance(fillHex)
  if (lum === null) return null
  const darkContrast = contrastRatio(READABLE_DARK_INK, fillHex)
  const lightContrast = contrastRatio(READABLE_LIGHT_INK, fillHex)
  if (darkContrast === null || lightContrast === null) return null
  return darkContrast >= lightContrast ? READABLE_DARK_INK : READABLE_LIGHT_INK
}

export function resolvePaletteColor(
  input: string,
  sessionPalette: Record<string, string>,
): PaletteResolution {
  if (HEX_COLOR_RE.test(input)) {
    return { color: input }
  }
  const exact = sessionPalette[input]
  if (typeof exact === 'string') {
    return { color: exact }
  }
  const normalized = normalizeColor(input)
  if (normalized !== input) {
    return { color: normalized! }
  }
  // dotted keys are treated as semantic palette tokens; plain CSS color names still pass through.
  if (input.includes('.')) {
    return { color: DEFAULT_PALETTE_FALLBACK, warningKey: input }
  }
  return { color: input }
}
