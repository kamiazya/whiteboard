/**
 * The two invariants the rewrite pass exists for, held under randomly
 * colliding naming tables:
 *
 *   FOLLOW    — a reference that uniquely resolved to the moved document
 *               before the change still resolves to it after the change.
 *   UNTOUCHED — a reference that did not is byte-identical.
 *
 * The independent model below re-implements resolution naively (aliases are
 * paths + document ids ONLY — display names are retired from resolution —
 * and a direct id always resolves to itself) so the property cannot inherit
 * a bug from the code under test.
 *
 * The generator draws paths, names and the new path from ONE five-string
 * pool, so a display name colliding with a path is the COMMON case — and
 * the model ignores names entirely, which is exactly the claim: a name can
 * no longer shadow a path. Paths themselves are unique per table and the
 * new path never lands on another live path, because the input domain is a
 * workspace listing after a SUCCESSFUL move — the index enforces both.
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
    fc.uniqueArray(aliasArbitrary, { minLength: 4, maxLength: 4 }),
    fc.infiniteStream(aliasArbitrary),
    fc.infiniteStream(fc.boolean()),
  )
  .map(([ids, paths, aliases, hasName]) => {
    const iter = aliases[Symbol.iterator]()
    const flags = hasName[Symbol.iterator]()
    const next = (): string => (iter.next() as IteratorYieldResult<string>).value
    return ids.map(
      (id, i): TableEntry => ({
        id,
        path: paths[i] as string,
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
  // Paths only: the table still CARRIES display names, and this line is
  // where they are ignored — a name matching the alias must change nothing.
  const owners = table.filter((entry) => entry.path === alias)
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
    // A move the index would have refused (onto a live path) is outside the
    // domain; onto its own path is the no-op the plan skips.
    fc.pre(!table.some((entry) => entry.id !== moved.id && entry.path === newPath))
    const path = { from: moved.path, to: newPath }

    const plan = planReferenceRewrite({
      entries: table.map(({ id, path: entryPath }) => ({ id, path: entryPath })),
      moves: [{ movedId: moved.id, ...path }],
    })
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
