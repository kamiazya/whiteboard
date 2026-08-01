// Pure branching logic extracted from widget-entry.ts so it can be unit
// tested without a real document/FontFace/fetch — widget-entry.ts wires
// these against the actual browser APIs, this module only decides WHAT
// descriptor/URL to use.

export interface FontDescriptorSource {
  weight?: string
  style?: string
  unicodeRange?: string
}

// FontFaceDescriptors omits any key whose source value is absent instead of
// passing `undefined` through — the FontFace constructor treats an explicit
// `undefined` descriptor differently from an omitted one on some engines.
export function buildFontFaceDescriptors(font: FontDescriptorSource): FontFaceDescriptors {
  const descriptors: FontFaceDescriptors = {}
  if (font.weight) descriptors.weight = font.weight
  if (font.style) descriptors.style = font.style
  if (font.unicodeRange) descriptors.unicodeRange = font.unicodeRange
  return descriptors
}
