import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../lib/document-entry.js'
import {
  type ReplicaRecord,
  readReplicaContent,
  readReplicaLocks,
  writeReplicaLock,
  writeReplicaMarkdown,
  writeReplicaSpatial,
} from '../lib/replica-record.js'

/** Stable identity, so a canvas with no locks never re-renders the editor. */
const NO_LOCKS: ReturnType<typeof readReplicaLocks> = { nodes: new Set(), edges: new Set() }

/**
 * What is being edited on the offline replica, and what an edit does: the
 * record is the source on every selection switch, and a change writes
 * through the containers before the debounced save appends it.
 */
export function useReplicaEditing({
  record,
  selected,
  scheduleSave,
}: {
  record: ReplicaRecord | undefined
  selected: WorkspaceDocumentEntry | undefined
  scheduleSave: (record: ReplicaRecord) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const content = useMemo(
    () =>
      record === undefined || selected === undefined ? null : readReplicaContent(record, selected),
    [record, selected],
  )

  // The spatial draft mirrors the markdown one; `spatialPrev` is what the
  // visible-diff reconcile compares against, advanced on every commit.
  const [spatialDraft, setSpatialDraft] = useState<SpatialCanvas | null>(null)
  const spatialPrev = useRef<SpatialCanvas | null>(null)
  useEffect(() => {
    setDraft(content?.kind === 'markdown' ? content.body : null)
    spatialPrev.current = content?.kind === 'spatial' ? content.canvas : null
    setSpatialDraft(content?.kind === 'spatial' ? content.canvas : null)
  }, [content])

  const onSpatialChange = useCallback(
    (next: SpatialCanvas) => {
      if (record === undefined || selected === undefined || selected.kind !== 'spatial') return
      setSpatialDraft(next)
      const prev = spatialPrev.current
      if (prev !== null) writeReplicaSpatial(record, selected.documentId, prev, next)
      spatialPrev.current = next
      scheduleSave(record)
    },
    [record, selected, scheduleSave],
  )
  const onDraftChange = useCallback(
    (next: string) => {
      if (record === undefined || selected === undefined || selected.kind === 'spatial') return
      setDraft(next)
      writeReplicaMarkdown(record, selected.documentId, next)
      scheduleSave(record)
    },
    [record, selected, scheduleSave],
  )
  const spatialLocks = useReplicaLocks(record, selected, scheduleSave)
  return { content, draft, spatialDraft, spatialLocks, onDraftChange, onSpatialChange }
}

/**
 * The selected canvas's locks, as the editor's lock props. The editor binds
 * a lock only when it is handed the toggles too (`use-lock-policy`), so the
 * toggles are what make a lock the daemon set hold here; a toggle is a
 * data-plane write like any edit, saved through the same queue.
 */
function useReplicaLocks(
  record: ReplicaRecord | undefined,
  selected: WorkspaceDocumentEntry | undefined,
  scheduleSave: (record: ReplicaRecord) => void,
) {
  const documentId =
    record !== undefined && selected?.kind === 'spatial' ? selected.documentId : undefined
  const [locks, setLocks] = useState(NO_LOCKS)
  // The record is the source on every selection switch, as for the drafts.
  useEffect(() => {
    setLocks(
      record === undefined || documentId === undefined
        ? NO_LOCKS
        : readReplicaLocks(record, documentId),
    )
  }, [record, documentId])

  const toggleLock = useCallback(
    (target: { node: string } | { edge: string }, locked: boolean) => {
      if (record === undefined || documentId === undefined) return
      writeReplicaLock(record, documentId, target, locked)
      setLocks(readReplicaLocks(record, documentId))
      scheduleSave(record)
    },
    [record, documentId, scheduleSave],
  )
  return useMemo(
    () => ({
      lockedNodeIds: locks.nodes,
      lockedEdgeIds: locks.edges,
      onToggleNodeLock: (node: string, locked: boolean) => toggleLock({ node }, locked),
      onToggleEdgeLock: (edge: string, locked: boolean) => toggleLock({ edge }, locked),
    }),
    [locks, toggleLock],
  )
}
