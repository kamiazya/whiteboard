/**
 * The leaf positions a VALUE actually occupies, in the census's notation, so
 * a declaration can be compared against what a projection really did. A
 * facets bucket collapses to one `/*` entry for the reason the schema census
 * does not descend it.
 *
 * The collapse is by NAME here and structural in the census (an object schema
 * with no properties). They agree today because `facets` names an open record
 * at all three sites and nowhere else, and the collapse fires at the FIRST
 * `facets` key, so a plugin payload that happens to hold one of its own is
 * never reached. A field later named `facets` that is not an open record would
 * make the two notations disagree — which fails the comparison loudly
 * rather than hiding a loss, so this is a maintenance cost and not a hole.
 */
export function valueLeafPaths(value: unknown): readonly string[] {
  const out: string[] = []
  walkValue(value, '', out)
  return [...new Set(out)].sort()
}

function walkValue(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walkValue(item, `${path}[]`, out)
  } else if (value !== null && typeof value === 'object') {
    walkObject(value, path, out)
  } else {
    out.push(path)
  }
}

function walkObject(value: object, path: string, out: string[]): void {
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue
    const next = path === '' ? key : `${path}.${key}`
    if (key === 'facets') out.push(`${next}/*`)
    else walkValue(child, next, out)
  }
}
