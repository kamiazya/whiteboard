// @vitest-environment node
// The one place the keyboard-docked bar learns which CodeMirror host it is
// talking to. Registration is by identity so a host that unmounts after a
// newer one took over cannot clear the newer one.
import { describe, expect, it, vi } from 'vitest'
import {
  type ActiveMarkdownEditor,
  clearActiveMarkdownEditor,
  getActiveMarkdownEditor,
  setActiveMarkdownEditor,
  subscribeActiveMarkdownEditor,
} from './active-markdown-editor.js'

function fakeEditor(): ActiveMarkdownEditor {
  return { run: vi.fn(), headingLevel: () => 0 }
}

describe('active markdown editor registry', () => {
  it('holds the most recent registration', () => {
    const a = fakeEditor()
    setActiveMarkdownEditor(a)
    expect(getActiveMarkdownEditor()).toBe(a)
    clearActiveMarkdownEditor(a)
    expect(getActiveMarkdownEditor()).toBeNull()
  })

  it('ignores a stale clear from an editor that was already replaced', () => {
    const a = fakeEditor()
    const b = fakeEditor()
    setActiveMarkdownEditor(a)
    setActiveMarkdownEditor(b)
    clearActiveMarkdownEditor(a)
    expect(getActiveMarkdownEditor()).toBe(b)
    clearActiveMarkdownEditor(b)
  })

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    const seen: (ActiveMarkdownEditor | null)[] = []
    const unsubscribe = subscribeActiveMarkdownEditor(() => seen.push(getActiveMarkdownEditor()))
    const a = fakeEditor()
    setActiveMarkdownEditor(a)
    clearActiveMarkdownEditor(a)
    unsubscribe()
    setActiveMarkdownEditor(a)
    clearActiveMarkdownEditor(a)
    expect(seen).toEqual([a, null])
  })
})
