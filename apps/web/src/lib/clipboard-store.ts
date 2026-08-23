/**
 * In-app clipboard (editor-completeness slice 4): one module-level slot
 * holding the last copied fragment, shared by every editor mount in the
 * tab — which is exactly what makes cross-canvas paste work (navigate to
 * another canvas, Cmd+V). Deliberately NOT the OS clipboard: that
 * integration (slice 5) layers on top of this store, and an in-memory
 * slot needs no permissions and cannot race an unmount.
 *
 * File-node references travel by reference, not inline bytes: in
 * browser mode the asset store is origin-global, so a same-tab
 * cross-canvas paste resolves them as-is. Inline `files` assets are the
 * OS-clipboard slice's concern.
 */
import type { ClipboardFragment } from '@kamiazya/whiteboard-model'

let current: ClipboardFragment | null = null

export function writeClipboardFragment(fragment: ClipboardFragment): void {
  current = fragment
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
  reconnections.clear()
}
