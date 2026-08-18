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

function renderOverlay(
  overrides: { onCommit?: (text: string) => void; onClose?: () => void } = {},
) {
  const onCommit = overrides.onCommit ?? vi.fn()
  const onClose = overrides.onClose ?? vi.fn()
  const view = render(
    <NodeTextEditorOverlay
      title="Weekly review"
      initialText={BODY}
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

  it('names the node it is editing', async () => {
    const { getByText } = renderOverlay()
    expect(getByText('Weekly review')).toBeTruthy()
  })
})
