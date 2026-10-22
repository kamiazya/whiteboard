import { EditorView } from '@codemirror/view'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

const TARGETS = [
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'release-plan', name: 'Release plan' },
  { id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', path: 'retro-notes', name: 'Retro notes' },
]

function sourceView(container: HTMLElement): EditorView {
  const dom = container.querySelector('[data-testid="markdown-source-pane"] .cm-content')
  const view = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null
  if (view === null) throw new Error('no source view')
  return view
}

/** A real mousedown on the text at `offset`, with the given modifier. */
function mousedownAt(view: EditorView, offset: number, modifier: 'ctrlKey' | 'metaKey' | null) {
  const rect = view.coordsAtPos(offset)
  if (rect === null) throw new Error('offset is not laid out')
  const event = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: rect.left + 1,
    clientY: (rect.top + rect.bottom) / 2,
    ...(modifier === null ? {} : { [modifier]: true }),
  })
  view.contentDOM.dispatchEvent(event)
  return event
}

const VALUE = 'see [[release-plan|Release plan]] and [[Nope]]'

describe('following a [[link]] from the source pane (real browser)', () => {
  it('Ctrl+click on a resolved link opens its document', () => {
    const onOpenDocument = vi.fn()
    const { container } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="write"
        value={VALUE}
        onChange={() => {}}
        linkTargets={TARGETS}
        onOpenDocument={onOpenDocument}
      />,
    )
    const event = mousedownAt(sourceView(container), 10, 'ctrlKey')
    expect(onOpenDocument).toHaveBeenCalledWith('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(event.defaultPrevented).toBe(true)
  })

  it('Cmd+click works the same', () => {
    const onOpenDocument = vi.fn()
    const { container } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="write"
        value={VALUE}
        onChange={() => {}}
        linkTargets={TARGETS}
        onOpenDocument={onOpenDocument}
      />,
    )
    mousedownAt(sourceView(container), 10, 'metaKey')
    expect(onOpenDocument).toHaveBeenCalledTimes(1)
  })

  it('a plain click and a click on an unresolved link open nothing', () => {
    const onOpenDocument = vi.fn()
    const { container } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="write"
        value={VALUE}
        onChange={() => {}}
        linkTargets={TARGETS}
        onOpenDocument={onOpenDocument}
      />,
    )
    const view = sourceView(container)
    mousedownAt(view, 10, null)
    mousedownAt(view, VALUE.length - 4, 'ctrlKey')
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('the editing catalog offers Open link with the caret inside a resolved link', async () => {
    const onOpenDocument = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="write"
        value={VALUE}
        onChange={() => {}}
        linkTargets={TARGETS}
        onOpenDocument={onOpenDocument}
      />,
    )
    await focusEditable(() =>
      container.querySelector('.markdown-editor-source [contenteditable="true"]'),
    )
    sourceView(container).dispatch({ selection: { anchor: 10 } })
    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Open link under caret' }))
    expect(onOpenDocument).toHaveBeenCalledWith('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('the catalog offers Create for an unresolved link and no Open row elsewhere', async () => {
    const onCreateLinkTarget = vi.fn()
    const { container, getByRole, queryByRole } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="write"
        value={VALUE}
        onChange={() => {}}
        linkTargets={TARGETS}
        onOpenDocument={() => {}}
        onCreateLinkTarget={onCreateLinkTarget}
      />,
    )
    await focusEditable(() =>
      container.querySelector('.markdown-editor-source [contenteditable="true"]'),
    )
    sourceView(container).dispatch({ selection: { anchor: VALUE.length - 4 } })
    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    expect(queryByRole('menuitem', { name: 'Open link under caret' })).toBeNull()
    await userEvent.click(getByRole('menuitem', { name: "Create 'Nope'" }))
    expect(onCreateLinkTarget).toHaveBeenCalledWith('Nope')
  })
})

describe('creating a link target from [[ completion (real browser)', () => {
  it('typing a name that matches nothing offers Create and Enter makes the note and the link', async () => {
    let value = ''
    const onCreateLinkTarget = vi.fn()
    const { container } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="write"
        value=""
        onChange={(next) => {
          value = next
        }}
        linkTargets={TARGETS}
        onCreateLinkTarget={onCreateLinkTarget}
      />,
    )
    await focusEditable(() =>
      container.querySelector('.markdown-editor-source [contenteditable="true"]'),
    )
    await userEvent.keyboard('see [[[[Nope')
    await vi.waitFor(() => {
      const selected = document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')
      expect(selected?.textContent).toContain("Create 'Nope'")
    })
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => {
      expect(value).toBe('see [[Nope]]')
    })
    expect(onCreateLinkTarget).toHaveBeenCalledWith('Nope')
  })

  it('shows Create only once the text matches nothing, naming the current text', async () => {
    const { container } = render(
      <MarkdownEditor
        theme="light"
        initialViewMode="write"
        value=""
        onChange={() => {}}
        linkTargets={TARGETS}
        onCreateLinkTarget={() => {}}
      />,
    )
    await focusEditable(() =>
      container.querySelector('.markdown-editor-source [contenteditable="true"]'),
    )
    await userEvent.keyboard('[[[[Re')
    await vi.waitFor(() => {
      expect(document.querySelector('.cm-tooltip-autocomplete')?.textContent).toContain(
        'Release plan',
      )
    })
    expect(document.querySelector('.cm-tooltip-autocomplete')?.textContent).not.toContain('Create')
    await userEvent.keyboard('x')
    await vi.waitFor(() => {
      expect(document.querySelector('.cm-tooltip-autocomplete')?.textContent).toContain(
        "Create 'Rex'",
      )
    })
  })
})
