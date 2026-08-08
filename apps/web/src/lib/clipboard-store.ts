/**
 * In-app clipboard (editor-completeness slice 4): one module-level slot
 * holding the last copied fragment, shared by every editor mount in the
 * tab — which is exactly what makes cross-canvas paste work (navigate to
 * another canvas, Cmd+V). Deliberately NOT the OS clipboard: that
 * integration (slice 5) layers on top of this store, and an in-memory
 * slot needs no permissions and cannot race an unmount.
 *
 * File-node references travel by reference, not inline bytes: in
 * browser-local mode the asset store is origin-global, so a same-tab
 * cross-canvas paste resolves them as-is. Inline `files` assets are the
 * OS-clipboard slice's concern.
 */
import type { ClipboardFragment } from '@kamiazya/whiteboard-canvas-model'

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

/** Test isolation only — production never clears the slot. */
export function clearClipboardFragmentForTests(): void {
  current = null
}
