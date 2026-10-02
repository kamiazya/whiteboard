/**
 * Strict requests, tolerant answers — held over the schemas as they ARE, not
 * over the text that declares them.
 *
 * arch-lint's `api-contract-response-tolerance.test.ts` reads top-level
 * `const`s for `.strict()` and cannot see a schema that arrives by `export {
 * x as y }`, nor one built from a strict piece declared in another package
 * (a search hit, a backlink, a tag count). So this walks the live schema
 * graph of everything this package publishes to the browser and finds every
 * object that refuses an unknown key.
 *
 * The walk is deliberately NOT `tolerantAnswer`'s: it descends into whatever
 * a definition holds rather than switching on the kinds that helper knows,
 * so a kind the helper forgot to reach still shows up here instead of
 * agreeing with it.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as barrel from './index.js'

const modules = import.meta.glob<Record<string, unknown>>(
  ['./*.ts', '!./*.test.ts', '!./*.test-helper.ts', '!./index.ts'],
  { eager: true },
)

function isSchema(value: unknown): value is { _zod: { def: Record<string, unknown> } } {
  return typeof value === 'object' && value !== null && '_zod' in value
}

/** Paths of every object in `root`'s graph that refuses a key it does not declare. */
function strictObjects(root: unknown): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, path: string): void => {
    if (!isSchema(value) || seen.has(value)) return
    seen.add(value)
    const def = value._zod.def
    if (def.type === 'object' && isSchema(def.catchall) && def.catchall._zod.def.type === 'never') {
      found.push(path)
    }
    for (const [key, held] of Object.entries(def)) {
      if (key === 'getter' && typeof held === 'function') visit(held(), `${path}()`)
      else if (key === 'shape' && typeof held === 'object' && held !== null) {
        for (const [field, schema] of Object.entries(held)) visit(schema, `${path}.${field}`)
      } else if (Array.isArray(held)) {
        for (const [i, item] of held.entries()) visit(item, `${path}[${i}]`)
      } else visit(held, `${path}.${key}`)
    }
  }
  visit(root, '')
  return found
}

const published: ReadonlyMap<string, unknown> = new Map([
  ...Object.entries(barrel),
  ...Object.entries(modules).flatMap(([file, mod]) =>
    Object.entries(mod).map(([name, value]) => [`${file.slice(2)}:${name}`, value] as const),
  ),
])

const schemas = [...published].filter(([name, value]) => isSchema(value) && name.length > 0)
// A request is the daemon's to refuse an undeclared field in; everything else
// here is an answer, a refusal, or a piece of one.
const answers = schemas.filter(([name]) => !/RequestSchema$/.test(name))

describe('api-contracts: no schema the browser parses refuses an unknown key', () => {
  it('walks a real population, with the strict half and the derived answers present', () => {
    expect(answers.length).toBeGreaterThan(60)
    const requests = schemas.filter(([name]) => /RequestSchema$/.test(name))
    expect(requests.some(([, schema]) => strictObjects(schema).length > 0)).toBe(true)
    expect(published.has('createDocumentV1ResponseSchema')).toBe(true)
    expect(published.has('documentSearchResponseSchema')).toBe(true)
  })

  it('recognises a nested strict object, so a clean walk is not a blind one', () => {
    const nested = z.object({ hits: z.array(z.object({ id: z.string() }).strict()) })
    expect(strictObjects(nested)).toEqual(['.hits.element'])
  })

  it.each(answers)('%s declares nothing strict, at any depth', (_name, schema) => {
    expect(strictObjects(schema)).toEqual([])
  })
})
