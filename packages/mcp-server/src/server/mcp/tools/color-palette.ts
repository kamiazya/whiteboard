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
