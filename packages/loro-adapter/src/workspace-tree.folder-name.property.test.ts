/**
 * How a folder's display name merges: last writer wins per key, and the name
 * rides the folder NODE, so it follows the folder wherever a concurrent move
 * puts it.
 *
 * Two replicas fork from one base holding a folder `f`, then each names,
 * clears and moves it at random before they exchange updates. Checked after
 * the merge, in both directions: the replicas answer one listing; the name
 * shown is one a replica actually left (never a blend, never a name nobody
 * wrote last); and it is listed at whatever path the folder ended up at.
 * `reached` counts the races each run produced, with floors, so a generator
 * that stopped racing fails by name instead of passing vacuously.
 */
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  createWorkspaceDocumentAtPath,
  moveWorkspaceNodeToPath,
  readWorkspaceFolderNames,
  readWorkspaceNodes,
  setWorkspaceFolderName,
} from './workspace-tree.js'

const NAMES = ['Week 6', 'Archive', 'Plans'] as const
const PLACES = ['f', 'g', 'h/f'] as const

type Op =
  | { readonly kind: 'name'; readonly name: (typeof NAMES)[number] }
  | { readonly kind: 'clear' }
  | { readonly kind: 'move'; readonly to: (typeof PLACES)[number] }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(...NAMES).map((name) => ({ kind: 'name', name }) as const),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'clear' } as const) },
  { weight: 2, arbitrary: fc.constantFrom(...PLACES).map((to) => ({ kind: 'move', to }) as const) },
)
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 5 })

/** The folder holding the base's one document, read wherever it now sits. */
function folderOf(doc: LoroDoc): { path: string; name: string | undefined } {
  const nodes = readWorkspaceNodes(doc)
  const note = nodes.find((node) => node.type === 'document')
  if (note === undefined) throw new Error('the document went missing')
  const path = note.path.slice(0, note.path.lastIndexOf('/'))
  const folder = nodes.find((node) => node.type === 'folder' && node.path === path)
  if (folder === undefined || folder.type !== 'folder') throw new Error(`no folder at ${path}`)
  return { path, name: folder.name }
}

function apply(doc: LoroDoc, ops: readonly Op[]): void {
  for (const op of ops) {
    const at = folderOf(doc).path
    if (op.kind === 'name') setWorkspaceFolderName(doc, { path: at, name: op.name })
    else if (op.kind === 'clear') setWorkspaceFolderName(doc, { path: at })
    else if (op.to !== at) moveWorkspaceNodeToPath(doc, at, op.to)
  }
}

const reached = { bothNamed: 0, nameAgainstMove: 0, nameAgainstClear: 0 }

describe('a folder name across two replicas', () => {
  afterAllFloor(['converges on a name one replica left, at the path the folder reached'], () => {
    expect(reached.bothNamed).toBeGreaterThan(5)
    expect(reached.nameAgainstMove).toBeGreaterThan(5)
    expect(reached.nameAgainstClear).toBeGreaterThan(2)
  })

  fcTest.prop([opsArb, opsArb], withDefaults())(
    'converges on a name one replica left, at the path the folder reached',
    (leftOps, rightOps) => {
      const base = new LoroDoc()
      base.setPeerId(1n)
      createWorkspaceDocumentAtPath(base, {
        path: 'f/note',
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        kind: 'markdown',
      })
      const left = LoroDoc.fromSnapshot(base.export({ mode: 'snapshot' }))
      left.setPeerId(2n)
      const right = LoroDoc.fromSnapshot(base.export({ mode: 'snapshot' }))
      right.setPeerId(3n)

      apply(left, leftOps)
      apply(right, rightOps)
      const leftName = folderOf(left).name
      const rightName = folderOf(right).name
      const names = (ops: readonly Op[]) => ops.some((op) => op.kind !== 'move')
      const moves = (ops: readonly Op[]) => ops.some((op) => op.kind === 'move')
      if (leftName !== undefined && rightName !== undefined) reached.bothNamed++
      if ((names(leftOps) && moves(rightOps)) || (names(rightOps) && moves(leftOps))) {
        reached.nameAgainstMove++
      }
      if ((leftName === undefined) !== (rightName === undefined)) reached.nameAgainstClear++

      const fromLeft = left.export({ mode: 'update' })
      left.import(right.export({ mode: 'update' }))
      right.import(fromLeft)

      expect(readWorkspaceFolderNames(left)).toEqual(readWorkspaceFolderNames(right))
      const merged = folderOf(left)
      // Only a replica that wrote the name at all can have won it.
      const candidates = [
        ...(names(leftOps) ? [leftName] : []),
        ...(names(rightOps) ? [rightName] : []),
      ]
      if (candidates.length === 0) expect(merged.name).toBeUndefined()
      else expect(candidates).toContain(merged.name)
      expect(readWorkspaceFolderNames(left)).toEqual(
        merged.name === undefined ? [] : [{ path: merged.path, name: merged.name }],
      )
    },
  )
})
