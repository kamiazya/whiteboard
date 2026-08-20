// The full editing surface a canvas node's body gets when its own box is
// too small: the same MarkdownEditor a document uses, over the canvas, with
// the inline editor's commit grammar (close = commit, Escape = discard) so
// there is only one thing to learn.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { NodeTextEditorOverlay } from './NodeTextEditorOverlay.js'

afterEach(cleanup)

const BODY = '# Plan\n\n- one\n- two'

const TARGET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TARGET_NAME = 'Weekly review'
const targets = [{ id: TARGET_ID, name: TARGET_NAME, kind: 'markdown' as const }]
const resolveAlias = (alias: string) => (alias === TARGET_NAME ? TARGET_ID : null)

function renderOverlay(
  overrides: { onCommit?: (text: string) => void; onClose?: () => void } = {},
) {
  const onCommit = overrides.onCommit ?? vi.fn()
  const onClose = overrides.onClose ?? vi.fn()
  const view = render(
    <NodeTextEditorOverlay
      initialViewMode="write"
      title="Weekly review"
      initialText={BODY}
      linkTargets={targets}
      onCommit={onCommit}
      onClose={onClose}
    />,
  )
  return { ...view, onCommit, onClose }
}

async function typeInto(container: HTMLElement, text: string): Promise<void> {
  const editable = container.querySelector('[contenteditable="true"]')
  if (!editable) throw new Error('expected a contenteditable CodeMirror host')
  await userEvent.click(editable.querySelector('.cm-line') as HTMLElement)
  await userEvent.keyboard('{Control>}{End}{/Control}')
  await userEvent.keyboard(text)
}

describe('the node text overlay (real browser)', () => {
  it('opens on the node body and commits the edit when closed', async () => {
    const { container, getByRole, onCommit, onClose } = renderOverlay()

    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())
    expect(container.querySelector('.cm-content')?.textContent).toContain('# Plan')

    await typeInto(container, ' three')
    await userEvent.click(getByRole('button', { name: 'Back to canvas' }))

    expect(onCommit).toHaveBeenCalledWith(`${BODY} three`)
    expect(onClose).toHaveBeenCalled()
  })

  // Same grammar as the inline node editor, so nothing new has to be learned.
  it('discards the edit on Escape', async () => {
    const { container, onCommit, onClose } = renderOverlay()
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())

    await typeInto(container, ' three')
    await userEvent.keyboard('{Escape}')

    expect(onCommit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('commits on ⌘Enter without waiting for the close', async () => {
    const { container, onCommit } = renderOverlay()
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())

    await typeInto(container, ' three')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')

    expect(onCommit).toHaveBeenCalledWith(`${BODY} three`)
  })

  // Closing with nothing typed must not write a revision that says nothing.
  it('does not commit when the text is unchanged', async () => {
    const { container, getByRole, onCommit, onClose } = renderOverlay()
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())

    await userEvent.click(getByRole('button', { name: 'Back to canvas' }))

    expect(onCommit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  // Escape belongs to the innermost thing that can take it. The overlay
  // listens at the window in the CAPTURE phase, which fires before any
  // nested popup's own handler — so without a guard, dismissing a link
  // picker would discard the whole edit instead.
  it('lets a nested popup take Escape for itself', async () => {
    const { container, getByRole, onClose, onCommit } = renderOverlay()
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())

    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Link' }))
    await waitFor(() =>
      expect(container.querySelector('[data-testid="link-picker"]')).not.toBeNull(),
    )

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(container.querySelector('[data-testid="link-picker"]')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    // The surface is still there to keep editing on.
    expect(container.querySelector('.cm-content')).not.toBeNull()
  })

  it('lets the catalog take Escape for itself', async () => {
    const { container, getByRole, onClose } = renderOverlay()
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())

    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    await waitFor(() =>
      expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull(),
    )

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('names the node it is editing', async () => {
    const { getByText } = renderOverlay()
    expect(getByText('Weekly review')).toBeTruthy()
  })

  // A wiki link is the same affordance here as in a document, so it has to
  // navigate here too. Leaving the surface by following one is a close, so
  // the edit in progress is kept rather than dropped on the floor.
  it('follows a wiki link, committing first', async () => {
    const onOpenDocument = vi.fn()
    const onCommit = vi.fn()
    const { container, getByRole } = render(
      <NodeTextEditorOverlay
        initialViewMode="write"
        title="Weekly review"
        initialText={`See [[${TARGET_NAME}]]`}
        linkTargets={targets}
        resolveAlias={resolveAlias}
        onCommit={onCommit}
        onClose={vi.fn()}
        onOpenDocument={onOpenDocument}
      />,
    )
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())

    await typeInto(container, '!')
    await userEvent.click(getByRole('button', { name: 'Read' }))

    const anchor = await waitFor(() => {
      const found = container.querySelector(`a[href="${TARGET_ID}"]`)
      if (!found) throw new Error('expected the wiki link to render as an anchor')
      return found as HTMLElement
    })
    await userEvent.click(anchor)

    expect(onOpenDocument).toHaveBeenCalledWith(TARGET_ID)
    expect(onCommit).toHaveBeenCalledWith(`See [[${TARGET_NAME}]]!`)
    // The ORDER is the design: navigating first would leave the host writing
    // the edit into a document it has already switched away from. Both being
    // called says nothing about that.
    expect(onCommit.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenDocument.mock.invocationCallOrder[0],
    )
  })
})
