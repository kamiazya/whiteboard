import type { Scene, SceneNode } from '@kamiazya/whiteboard-canvas-render'

/**
 * The font families this render DECLARED and the renderer could not provide.
 *
 * `undrawableCharacters` answers the other half of ADR-0011 decision 3 — "the
 * resolved font set is part of the render contract, and is reported" — and it
 * is family-blind by construction: it asks whether ANY loaded face has a
 * glyph, never whether the face a run NAMED was among them. So a run declaring
 * a family nobody installed reports nothing, renders in the fallback, and
 * looks correct: every character present, the wrong face, and silence.
 *
 * That is exactly the "silent variation by ambient state" the ADR calls the
 * failure class this repo keeps paying for, arriving through the one door its
 * report could not see. It costs something today: a fenced code block declares
 * the markdown theme's mono chain, and a Roboto-only export resolves none of
 * it.
 *
 * Deliberately about DECLARATIONS, not about what a reader loses. A missing
 * family still draws readable text in the fallback face, which is why this is
 * a separate answer from `undrawable` rather than folded into it.
 */
export function unresolvedFamilies(
  scene: Scene,
  availableFamilies: readonly string[],
): readonly string[] {
  // No face at all means the render already degraded to system fonts, which is
  // logged where it happens. Every declaration would be "unresolved" there,
  // which is a louder and less true answer than saying nothing — the same rule
  // `undrawableCharacters` follows.
  if (availableFamilies.length === 0) return []
  const available = new Set(availableFamilies.map(normalize))
  const seen = new Set<string>()
  const unresolved: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const entry = node as SceneNode & {
      appearance?: { fontFamily?: string }
      runs?: unknown[]
      children?: unknown[]
      items?: unknown[]
      cells?: unknown[]
      rows?: unknown[]
    }
    const declared = entry.appearance?.fontFamily
    if (declared !== undefined && declared !== '' && !seen.has(declared)) {
      seen.add(declared)
      // A CSS chain is a preference list, and resvg takes the first name it
      // has — so the declaration is resolved if ANY name in it is loaded. A
      // generic keyword is not a resolution: nothing here backs `monospace`
      // with a real face, which is the whole point of reporting this.
      if (!splitFamilies(declared).some((name) => available.has(name))) unresolved.push(declared)
    }
    for (const key of ['runs', 'children', 'items', 'cells', 'rows'] as const) {
      for (const child of entry[key] ?? []) visit(child)
    }
  }
  for (const node of scene.nodes) visit(node)
  return unresolved
}

function splitFamilies(declared: string): string[] {
  return declared.split(',').map(normalize)
}

function normalize(name: string): string {
  return name
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
}
