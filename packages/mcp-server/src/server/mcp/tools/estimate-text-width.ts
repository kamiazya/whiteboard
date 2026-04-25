// Approximate text-width estimator for box_with_label. It is tuned for
// Excalidraw's Virgil font. Exact metrics are browser-dependent, so the server
// uses a four-bucket character model instead:
//   very-narrow (i l I |)
//   narrow      (typical ASCII)
//   very-wide   (M W)
//   wide        (CJK / emoji / full-width)
//
// This reduces text overflow surprises and improves horizontal centering for
// multiline content. Treating runs of i or M uniformly causes false negatives
// and false positives in overflow detection.

const VERY_NARROW_RATIO = 0.3 // i l I |, especially narrow in Virgil
const NARROW_RATIO = 0.55 // typical Virgil ASCII width
const VERY_WIDE_RATIO = 0.9 // M W, especially wide within ASCII
const WIDE_RATIO = 1.0 // CJK / emoji / full-width are roughly square

const VERY_NARROW_CHARS = new Set(['i', 'l', 'I', '|'])
const VERY_WIDE_CHARS = new Set(['M', 'W'])

// Treat most code points >= 0x2E80 as wide. Approximate ranges:
//   0x2E80-0x9FFF    : CJK Radicals / Kangxi / Han
//   0xA000-0xA4CF    : Yi
//   0xAC00-0xD7AF    : Hangul Syllables
//   0xF900-0xFAFF    : CJK Compatibility Ideographs
//   0xFE30-0xFE4F    : CJK Compatibility Forms
//   0xFF00-0xFFEF    : Half/Full-width Forms
//   0x1F000-0x1FFFF  : Symbols / Emoji
function isWideCodePoint(cp: number): boolean {
  if (cp >= 0x2e80 && cp <= 0xd7af) return true
  if (cp >= 0xf900 && cp <= 0xfaff) return true
  if (cp >= 0xfe30 && cp <= 0xfe4f) return true
  if (cp >= 0xff00 && cp <= 0xffef) return true
  if (cp >= 0x1f000 && cp <= 0x1ffff) return true
  return false
}

function ratioForChar(ch: string): number {
  if (VERY_NARROW_CHARS.has(ch)) return VERY_NARROW_RATIO
  if (VERY_WIDE_CHARS.has(ch)) return VERY_WIDE_RATIO
  const cp = ch.codePointAt(0) ?? 0
  if (isWideCodePoint(cp)) return WIDE_RATIO
  return NARROW_RATIO
}

export function estimateTextWidth(text: string, fontSize: number = 20): number {
  let width = 0
  // Iterate code points correctly so surrogate pairs count as one character.
  for (const ch of text) {
    width += fontSize * ratioForChar(ch)
  }
  return width
}
