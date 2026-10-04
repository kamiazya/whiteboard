import { describe, expect, it } from 'vitest'

const modules = import.meta.glob<Record<string, unknown>>(
  ['./*.ts', '!./*.test.ts', '!./*.test-helper.ts', '!./index.ts'],
  { eager: true },
)

function isSchema(value: unknown): value is { _zod: { def: Record<string, unknown> } } {
  return typeof value === 'object' && value !== null && '_zod' in value
}

/**
 * The sorted key list of every object in `root`'s graph that `matches`,
 * de-duplicated by that key list: an object is known by what it carries,
 * since the schema that holds it may be anonymous.
 */
function objectsDeclaring(root: unknown, matches: (keys: string[]) => boolean): Set<string> {
  const found = new Set<string>()
  const seen = new Set<unknown>()
  const visit = (value: unknown): void => {
    if (!isSchema(value) || seen.has(value)) return
    seen.add(value)
    const def = value._zod.def
    if (def.type === 'object' && typeof def.shape === 'object' && def.shape !== null) {
      const keys = Object.keys(def.shape)
      if (matches(keys)) found.add(keys.sort().join(','))
    }
    for (const [key, held] of Object.entries(def)) {
      if (key === 'getter' && typeof held === 'function') visit(held())
      else if (key === 'shape' && typeof held === 'object' && held !== null) {
        for (const schema of Object.values(held)) visit(schema)
      } else if (Array.isArray(held)) for (const item of held) visit(item)
      else visit(held)
    }
  }
  visit(root)
  return found
}

const schemas = Object.values(modules).flatMap((mod) => Object.values(mod).filter(isSchema))

// A row addressed by a `path` is a document, and a document is `documentId`
// and `name` everywhere else (the port, `/api/v1`, every tool): a bare `id` or
// `displayName` beside a `path` is the spelling that disagreed. What remains
// is a different entity that has a path and an id of its own.
const NOT_A_DOCUMENT: ReadonlyMap<string, string> = new Map([
  [
    'attestation,auto,createdAt,elementCount,id,label,operator,path,restoredFrom',
    'a version entry: `id` is the version, and `path` the document it belongs to',
  ],
  [
    'approxBytes,family,id,license,path,scripts',
    'a font file: `id` is the font and `path` where its bytes are served',
  ],
])

const spelledAsADocument = (keys: string[]) =>
  keys.includes('path') && (keys.includes('id') || keys.includes('displayName'))

describe('api-contracts: a document is spelled documentId and name, as the model does', () => {
  const found = new Set(
    schemas.flatMap((schema) => [...objectsDeclaring(schema, spelledAsADocument)]),
  )

  it('reaches a real population of contracts, the document summary among them', () => {
    expect(schemas.length).toBeGreaterThan(60)
    const summaries = schemas.flatMap((schema) => [
      ...objectsDeclaring(
        schema,
        (keys) => keys.includes('path') && keys.includes('documentId') && keys.includes('name'),
      ),
    ])
    expect(summaries.length).toBeGreaterThan(0)
  })

  it('declares no row with a path and a bare id or displayName unless it is listed as not a document', () => {
    expect([...found].filter((keys) => !NOT_A_DOCUMENT.has(keys)).sort()).toEqual([])
  })

  it('lists no entity that no contract declares any more', () => {
    expect([...NOT_A_DOCUMENT.keys()].filter((keys) => !found.has(keys)).sort()).toEqual([])
  })
})
