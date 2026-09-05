import type { StateCommand } from '@codemirror/state'
import { useSyncExternalStore } from 'react'

/**
 * What the keyboard-docked formatting bar needs from whichever CodeMirror
 * host currently holds the caret. Both hosts (the source pane and the
 * spatial node editor) register themselves here on focus and withdraw on
 * blur or unmount, so the bar — mounted once, outside every editor — has
 * exactly one place to look and never holds a view of its own.
 */
export interface ActiveMarkdownEditor {
  readonly run: (command: StateCommand) => void
  readonly headingLevel: () => number
  /**
   * Opens the host's link picker and answers true; false when it has nothing
   * to pick from, so the caller falls back to the verb's plain wrap. Absent
   * on hosts without a picker.
   */
  readonly openLinkPicker?: () => boolean
  /**
   * Opens the host's comment composer on the caret's scope and answers
   * true; false when there is nothing to comment on. Absent on a host
   * that draws no annotation layer.
   */
  readonly openCommentComposer?: () => boolean
}

let current: ActiveMarkdownEditor | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function getActiveMarkdownEditor(): ActiveMarkdownEditor | null {
  return current
}

export function setActiveMarkdownEditor(editor: ActiveMarkdownEditor): void {
  if (current === editor) return
  current = editor
  notify()
}

/**
 * By identity, never unconditionally: a host that blurs or unmounts after
 * another host registered must not clear the newer registration — the
 * blur of the old one and the focus of the new one arrive in either order.
 */
export function clearActiveMarkdownEditor(editor: ActiveMarkdownEditor): void {
  if (current !== editor) return
  current = null
  notify()
}

export function subscribeActiveMarkdownEditor(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useActiveMarkdownEditor(): ActiveMarkdownEditor | null {
  return useSyncExternalStore(subscribeActiveMarkdownEditor, getActiveMarkdownEditor, () => null)
}
