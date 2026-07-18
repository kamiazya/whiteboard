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

// Mirrors the three RequestInfo|URL input shapes `fetch()` accepts: a plain
// string, a URL instance, and a Request instance (whose `.url` carries the
// resolved URL string). Returns the matching embedded data URI, or
// `undefined` when the requested filename isn't one this build embedded —
// callers fall through to the real fetch in that case.
export function resolveFontFetchDataUri(
  input: RequestInfo | URL,
  filenameMap: Readonly<Record<string, string>>,
): string | undefined {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const filename = url.split('/').pop() ?? ''
  return filenameMap[filename]
}
