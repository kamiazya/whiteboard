import { nodeText } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'

// Real browser: the Add-note path opens a focused textarea and Escape is a
// real key event through the editor's own handlers — the exact sequence a
// first-time user hits when they change their mind about a note.

// No vitest `globals`, so testing-library's auto-cleanup never registers:
// a surviving editor from the previous test would double every query.
afterEach(() => {
  cleanup()
})

describe('Escape while typing a brand-new note (real browser)', () => {
  it('takes the note with the discarded text instead of leaving an empty box', async () => {
    const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
    render(<Host />)

    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Note' }))
    const editor = await screen.findByRole('textbox')
    await waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))

    await userEvent.type(editor, 'changed my mind')
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(latest.canvas.nodes).toHaveLength(0))
  })

  it('keeps the box when Escape lands before any typing — sketching layouts', async () => {
    const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
    render(<Host />)

    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Note' }))
    await screen.findByRole('textbox')
    await waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))

    await userEvent.keyboard('{Escape}')

    // The editor closes; the empty box stays. Someone placing boxes to think
    // about a layout is not cancelling the box — only the typing.
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    expect(latest.canvas.nodes).toHaveLength(1)
    expect(
      latest.canvas.nodes[0] === undefined
        ? 'unset'
        : (nodeText(latest.canvas.nodes[0]) ?? 'unset'),
    ).toBe('')
  })

  it('keeps an existing note and its stored text when the edit is cancelled', async () => {
    const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
    render(<Host />)

    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Note' }))
    const editor = await screen.findByRole('textbox')
    await userEvent.type(editor, 'kept')
    // Commit, then reopen the SAME node and cancel: the node survives.
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => {
      const node = latest.canvas.nodes[0]
      expect(node === undefined ? undefined : nodeText(node)).toBe('kept')
    })

    const box = await screen.findByText('kept')
    await userEvent.dblClick(box)
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
    const kept = latest.canvas.nodes[0]
    expect(kept === undefined ? undefined : nodeText(kept)).toBe('kept')
  })
})
