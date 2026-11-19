/**
 * The oracle rows of the writers a batch carries beside the content ones: a
 * text splice, a trash entry forgotten and folder names re-applied. They are
 * added after every other row of the recorder, so the rows before them keep
 * the ids and the bytes they were recorded with.
 */
import type { documentEngine } from '@kamiazya/whiteboard-model'
import { setWorkspaceFolderName } from '../src/workspace-folder-name.js'
import { recordTrashEntry } from '../src/workspace-trash.js'
import { pick, type Rng, rngOf, sentence, WIDE } from './oracle-recorder-kit.js'
import { type ContentKind, type Scene, seedTreeIds, workspaceScene } from './oracle-write-scenes.js'

interface Recorder {
  add: (
    op: documentEngine.WriterName,
    tag: string,
    scene: Scene,
    args: unknown,
    writerPeer?: number,
  ) => void
  contentCases: (
    op: documentEngine.WriterName,
    contents: readonly ContentKind[],
    argsOf: (scene: Scene, rng: Rng, i: number) => unknown[],
    seed: number,
  ) => void
  /** The content kinds that hold a markdown body. */
  text: readonly ContentKind[]
}

export function addIndexWriteCases({ add, contentCases, text }: Recorder) {
  contentCases(
    'spliceText',
    text,
    (s, rng) => {
      const held = s.facts.text ?? ''
      return [
        { text: 'body', runs: [{ index: held.length, remove: 0, insert: ` ${pick(rng, WIDE)}` }] },
        { text: 'body', runs: [{ index: 0, remove: Math.min(2, held.length), insert: '😀é' }] },
        {
          text: 'body',
          runs: [
            { index: 0, remove: 0, insert: 'ab' },
            { index: 1, remove: 1, insert: '𝒳' },
          ],
        },
        { text: 'body', runs: [] },
        { text: 'body', runs: [{ index: 9999, remove: 0, insert: 'x' }] },
      ]
    },
    7000,
  )

  for (let i = 0; i < 3; i++) {
    const rng = rngOf(7100 + i)
    const scene = workspaceScene('markdown', rng)
    const [first, second] = seedTreeIds(scene)
    const entry = (documentId: string, at: number) => ({
      documentId,
      path: `gone/${at}`,
      deletedAt: at,
      blob: { algorithm: 'sha-256', digestHex: 'cd'.repeat(32) },
    })
    recordTrashEntry(scene.doc, entry(first?.id ?? 'absent', 100 + i))
    recordTrashEntry(scene.doc, entry(second?.id ?? 'other', 200 + i))
    add('forgetTrashEntry', `held-${i}`, scene, { documentId: first?.id ?? 'absent' })
    add('forgetTrashEntry', `other-${i}`, scene, { documentId: second?.id ?? 'other' })
    add('forgetTrashEntry', `absent-${i}`, scene, { documentId: 'absent' })
  }

  for (let i = 0; i < 3; i++) {
    const rng = rngOf(7200 + i)
    const scene = workspaceScene('markdown', rng)
    const named = workspaceScene('markdown', rngOf(7300 + i))
    setWorkspaceFolderName(named.doc, { path: 'notes', name: 'Kept' })
    add('reapplyFolderNames', `unnamed-${i}`, scene, {
      names: [{ path: 'notes', name: `${sentence(rng, 2)} ${pick(rng, WIDE)}` }],
    })
    add('reapplyFolderNames', `named-${i}`, named, { names: [{ path: 'notes', name: 'Replaced' }] })
    add('reapplyFolderNames', `invalid-${i}`, scene, { names: [{ path: 'notes', name: '' }] })
    add('reapplyFolderNames', `none-${i}`, scene, { names: [] })
    add('reapplyFolderNames', `absent-${i}`, scene, { names: [{ path: 'nope', name: 'x' }] })
  }
}
