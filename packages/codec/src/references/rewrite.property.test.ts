/**
 * The two invariants the rewrite pass exists for, held under randomly
 * colliding naming tables:
 *
 *   FOLLOW    — a reference that uniquely resolved to the moved document
 *               before the change still resolves to it after the change.
 *   UNTOUCHED — a reference that did not is byte-identical.
 *
 * The independent model below re-implements resolution naively (flat alias
 * space over paths and names, ambiguity resolves to nothing, a document id
 * always resolves to itself) so the property cannot inherit a bug from the
 * code under test.
 *
 * The generator draws every alias — paths, names, the new path — from ONE
 * five-string pool, so collisions (an old name shared by
 * two documents, a new name landing on someone else's path) are the common
 * case rather than the 1-in-2^40 one. A uniform generator here would pass
 * with the ambiguity rules deleted.
 */
import { canonicalUlidArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { planReferenceRewrite, rewriteReferenceTargets } from './rewrite.js'
import { scanReferences } from './scan.js'

const ALIAS_POOL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const
const aliasArbitrary = fc.constantFrom(...ALIAS_POOL)

interface TableEntry {
  id: string
  path: string
  name?: string
}

const tableArbitrary = fc
  .tuple(
    fc.uniqueArray(canonicalUlidArbitrary, { minLength: 2, maxLength: 4 }),
    fc.infiniteStream(aliasArbitrary),
    fc.infiniteStream(fc.boolean()),
  )
  .map(([ids, aliases, hasName]) => {
    const iter = aliases[Symbol.iterator]()
    const flags = hasName[Symbol.iterator]()
    const next = (): string => (iter.next() as IteratorYieldResult<string>).value
    return ids.map(
      (id): TableEntry => ({
        id,
        path: next(),
        ...((flags.next() as IteratorYieldResult<boolean>).value ? { name: next() } : {}),
      }),
    )
  })

/**
 * The naive model: what does `alias` resolve to under `table`? A direct id
 * wins outright — which is why the plan reserves every live id as an owner.
 */
function modelResolve(alias: string, table: readonly TableEntry[]): string | null {
  if (table.some((entry) => entry.id === alias)) return alias
  const owners = table.filter((entry) => entry.path === alias || entry.name === alias)
  return owners.length === 1 ? (owners[0] as TableEntry).id : null
}

function applyChange(
  table: readonly TableEntry[],
  movedId: string,
  path: { from: string; to: string },
): TableEntry[] {
  return table.map((entry) => (entry.id === movedId ? { ...entry, path: path.to } : entry))
}

const bodyPieceArbitrary = fc.oneof(
  fc.constant('plain text '),
  aliasArbitrary.map((alias) => `[[${alias}]] `),
  aliasArbitrary.map((alias) => `![[${alias}]] `),
  aliasArbitrary.map((alias) => `[[${alias}|label]] `),
)

describe('rewrite invariants', () => {
  fcTest.prop(
    [tableArbitrary, fc.array(bodyPieceArbitrary, { minLength: 1, maxLength: 8 }), aliasArbitrary],
    withDefaults(),
  )('follow + untouched, under a colliding table', (table, pieces, newPath) => {
    const moved = table[0] as TableEntry
    const body = pieces.join('')
    const path = { from: moved.path, to: newPath }

    const plan = planReferenceRewrite({ entries: table, moves: [{ movedId: moved.id, ...path }] })
    const after = rewriteReferenceTargets(body, plan)
    const newTable = applyChange(table, moved.id, path)

    const refsBefore = scanReferences(body)
    const refsAfter = scanReferences(after)
    expect(refsAfter.length).toBe(refsBefore.length)

    for (let i = 0; i < refsBefore.length; i++) {
      const before = refsBefore[i] as (typeof refsBefore)[number]
      const rewritten = refsAfter[i] as (typeof refsBefore)[number]
      if (modelResolve(before.target, table) === moved.id) {
        // FOLLOW: still resolves to the moved document under the new table.
        expect(modelResolve(rewritten.target, newTable)).toBe(moved.id)
      } else {
        // UNTOUCHED: byte-identical, label and embed marker included.
        expect(rewritten.full).toBe(before.full)
      }
      expect(rewritten.isEmbed).toBe(before.isEmbed)
      expect(rewritten.alias).toBe(before.alias)
    }
  })
})
