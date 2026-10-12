/**
 * In-app clipboard (editor-completeness slice 4): one module-level slot
 * holding the last copied fragment, shared by every editor mount in the
 * tab — which is exactly what makes cross-canvas paste work (navigate to
 * another canvas, Cmd+V). Deliberately NOT the OS clipboard: that
 * integration (slice 5) layers on top of this store, and an in-memory
 * slot needs no permissions and cannot race an unmount.
 *
 * Stored pictures travel by reference in the slot, and their bytes beside
 * it: where those bytes live is per keeper (the daemon keeps them per
 * workspace), so a paste elsewhere needs them. They are read after the copy,
 * so the slot holds them as a promise beside the fragment.
 */
import type { ClipboardFragment } from '@kamiazya/whiteboard-model'

type CarriedFiles = NonNullable<ClipboardFragment['files']>

let current: ClipboardFragment | null = null
let carried: { readonly copyId: string; readonly files: Promise<CarriedFiles> } | null = null

export function writeClipboardFragment(
  fragment: ClipboardFragment,
  files?: Promise<CarriedFiles>,
): void {
  current = fragment
  const copyId = fragment.source?.copyId
  carried = copyId === undefined || files === undefined ? null : { copyId, files }
}

/**
 * The picture bytes this tab read for the copy `copyId`, or undefined once a
 * later copy replaced it. Keyed by the copy rather than by the fragment
 * object, because a paste that arrives as clipboard TEXT parses a new one.
 */
export function carriedClipboardFiles(copyId: string): Promise<CarriedFiles> | undefined {
  return carried?.copyId === copyId ? carried.files : undefined
}

export function readClipboardFragment(): ClipboardFragment | null {
  return current
}

export function hasClipboardFragment(): boolean {
  return current !== null && current.nodes.length > 0
}

/**
 * Edge ids a cut's boundary reconnection created, per cut id. Module-scoped
 * like the slot: the "reconnect once" rule must hold even when the paste
 * arrives via the OS clipboard (Ctrl+V re-parses the JSON fresh each time,
 * so the envelope itself cannot be consumed). Kept as the CREATED ids, not
 * a boolean, so the decision can follow the document: an undone paste
 * removes these edges from the canvas, and the next paste is a first paste
 * again. An empty result is never recorded — a cross-canvas paste that
 * found no peers must not erase the record of a real reconnection at home.
 */
const reconnections = new Map<string, readonly string[]>()

export function recordedReconnection(cutId: string): readonly string[] {
  return reconnections.get(cutId) ?? []
}

export function recordReconnection(cutId: string, edgeIds: readonly string[]): void {
  if (edgeIds.length > 0) reconnections.set(cutId, edgeIds)
}

/** Test isolation only — production never clears the slot. */
export function clearClipboardFragmentForTests(): void {
  current = null
  carried = null
  reconnections.clear()
}
