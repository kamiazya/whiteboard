import { useEffect, useMemo, useRef } from 'react'
import type { EditorSelection, SelectionSource } from '../../lib/spatial/editor-handle.js'

/**
 * The editor's selection as a source other surfaces can follow. The source
 * object is stable for the editor's life — it reads the latest committed
 * selection from a ref — so it can sit in the imperative handle without
 * re-creating the handle on every selection change. Listeners run in an
 * effect, after the render that produced the selection has committed.
 */
export function useSelectionSource(
  selectedId: string | null,
  selectedEdgeId: string | null,
  extraIds: ReadonlySet<string>,
): SelectionSource {
  const latest = useRef<EditorSelection>({ selectedId, selectedEdgeId, extraIds: [...extraIds] })
  const listeners = useRef(new Set<() => void>())
  const source = useMemo<SelectionSource>(
    () => ({
      getSelection: () => latest.current,
      subscribeSelection(listener) {
        listeners.current.add(listener)
        return () => {
          listeners.current.delete(listener)
        }
      },
    }),
    [],
  )
  useEffect(() => {
    const prev = latest.current
    const ids = [...extraIds]
    if (
      prev.selectedId === selectedId &&
      prev.selectedEdgeId === selectedEdgeId &&
      prev.extraIds.length === ids.length &&
      prev.extraIds.every((id, i) => id === ids[i])
    ) {
      return
    }
    latest.current = { selectedId, selectedEdgeId, extraIds: ids }
    for (const listener of listeners.current) listener()
  }, [selectedId, selectedEdgeId, extraIds])
  return source
}
