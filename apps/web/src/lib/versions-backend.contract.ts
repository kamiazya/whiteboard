import { expect, it } from 'vitest'
import type { PastDocument, VersionsBackend } from './versions-backend.js'

/**
 * The behavioural contract every `VersionsBackend` must satisfy, written once
 * and run against each keeper.
 *
 * Two ship — the daemon's, over its document routes, and the browser's, over
 * IndexedDB — and each grew its own suite, so a behaviour one of them got
 * wrong was only ever caught if somebody thought to write that case in that
 * file. The lineage case below is the clearest example: a restore records the
 * merge point it creates, and that was added to both keepers in one change
 * precisely because nothing would have noticed if it had reached only one.
 *
 * What a contract CANNOT catch, and why this is only half the answer: a
 * feature implemented in one keeper and never written in the other is an
 * absent test, not a failing one. `list` and `save` are here because both
 * keepers answer them; automatic checkpoints and thumbnails are not, because
 * only one keeper has them, and no assertion in this file would fire if the
 * other never got them. That gap is what a keeper-capability ledger is for.
 *
 * Cases are deliberately keeper-independent — no assertion about which
 * endpoint is called, which object store is written, or what the stored bytes
 * are. Only about what a caller of the seam is entitled to rely on.
 */
export interface VersionsBackendHarness {
  backend: VersionsBackend
  workspaceId: string
  path: string
  /** Write this text as the document's content, the way an edit would. */
  write(text: string): Promise<void>
  /** What the document holds NOW, however this keeper stores it. */
  read(): Promise<string | undefined>
  /**
   * A version id belonging to ANOTHER document in the same keeper, for the
   * refusal below. Omitted by a harness that cannot hold a second document —
   * the case then skips rather than asserting against a fixture it faked.
   */
  foreignVersionId?(): Promise<string>
  cleanup(): Promise<void>
}

/** The text a past state holds, without the contract knowing any CRDT. */
function textOf(past: PastDocument | null): string | undefined {
  if (past === null || past.kind !== 'spatial') return undefined
  const node = past.canvas.nodes[0]
  return node?.type === 'text' ? node.text : undefined
}

export function versionsBackendContract(
  create: () => VersionsBackendHarness | Promise<VersionsBackendHarness>,
): void {
  it('lists a saved point, newest first', async () => {
    const h = await create()
    try {
      await h.write('first')
      const older = await h.backend.save(h.workspaceId, h.path, { label: 'one' })
      await h.write('second')
      const newer = await h.backend.save(h.workspaceId, h.path, { label: 'two' })

      const listed = await h.backend.list(h.workspaceId, h.path)
      // The row `save` answered is the row `list` shows — a keeper that
      // minted an id for its answer and another for its record would pass
      // every other case here.
      expect(listed.map((v) => v.id)).toContain(older.id)
      expect(listed.map((v) => v.id)).toContain(newer.id)
      expect(listed.findIndex((v) => v.id === newer.id)).toBeLessThan(
        listed.findIndex((v) => v.id === older.id),
      )
    } finally {
      await h.cleanup()
    }
  })

  it('answers with the state a version HOLDS, not the state the document is in', async () => {
    const h = await create()
    try {
      await h.write('at the version')
      const saved = await h.backend.save(h.workspaceId, h.path, { label: 'mark' })
      await h.write('moved on since')

      expect(textOf(await h.backend.loadPast(h.workspaceId, h.path, saved.id))).toBe(
        'at the version',
      )
      // The document itself is untouched by looking at its past.
      expect(await h.read()).toBe('moved on since')
    } finally {
      await h.cleanup()
    }
  })

  it('refuses a version this document does not own', async () => {
    const h = await create()
    try {
      if (h.foreignVersionId === undefined) return
      await h.write('mine')
      const foreign = await h.foreignVersionId()

      // Null rather than a throw, and rather than another document's content:
      // an id alone must not read a history that is not this document's, for
      // the same reason restore refuses it.
      expect(await h.backend.loadPast(h.workspaceId, h.path, foreign)).toBeNull()
    } finally {
      await h.cleanup()
    }
  })

  it('puts a past state back into the document', async () => {
    const h = await create()
    try {
      await h.write('the good version')
      const saved = await h.backend.save(h.workspaceId, h.path, { label: 'good' })
      await h.write('the regrettable one')

      await h.backend.restore(h.workspaceId, h.path, saved.id)

      expect(await h.read()).toBe('the good version')
    } finally {
      await h.cleanup()
    }
  })

  it('records the merge a restore creates, naming what it restored', async () => {
    const h = await create()
    try {
      await h.write('original')
      const saved = await h.backend.save(h.workspaceId, h.path, { label: 'original' })
      await h.write('changed')

      const before = await h.backend.list(h.workspaceId, h.path)
      await h.backend.restore(h.workspaceId, h.path, saved.id)
      const after = await h.backend.list(h.workspaceId, h.path)

      // A restore is a MERGE — the result is a descendant of both the state
      // you were on and the one you went back to — so it leaves a point, and
      // that point says where it came from. Without it the history reads as a
      // straight line through a place two branches joined.
      expect(after.length).toBe(before.length + 1)
      expect(after[0]?.restoredFrom).toBe(saved.id)
    } finally {
      await h.cleanup()
    }
  })
}
