/**
 * Code-unit order, spelled out.
 *
 * Identical to a bare `.sort()` for strings — and written explicitly because
 * a bare one reads as an oversight, and a static analyser (Sonar S2871) asks
 * for `localeCompare` instead. Taking that advice would be a defect rather
 * than a fix: `localeCompare` reads the runtime's default locale and ICU
 * data, so anything built on the order — a digest, a canonical pair, a
 * render key, a serialised document — would differ between two machines
 * holding identical input.
 *
 * ONE definition, because the rationale above was copied beside four named
 * copies and a handful of inline ones, and a comparator whose whole value is
 * determinism is the last thing that should exist in several spellings.
 */
export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
