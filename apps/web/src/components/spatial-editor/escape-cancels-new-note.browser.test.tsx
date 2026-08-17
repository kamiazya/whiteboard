import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

// Real browser: the Add-note path opens a focused textarea and Escape is a
// real key event through the editor's own handlers — the exact sequence a
// first-time user hits when they change their mind about a note.
function Host({ onCanvas }: { onCanvas: (c: SpatialCanvas) => void }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>({ nodes: [], edges: [] })
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        canvas={canvas}
        defaultTool="select"
        onChange={(next) => {
          setCanvas(next)
          onCanvas(next)
        }}
      />
    </div>
  )
}

// No vitest `globals`, so testing-library's auto-cleanup never registers:
// a surviving editor from the previous test would double every query.
afterEach(() => {
  cleanup()
})

describe('Escape while typing a brand-new note (real browser)', () => {
  it('takes the note with the discarded text instead of leaving an empty box', async () => {
    let latest: SpatialCanvas = { nodes: [], edges: [] }
    render(<Host onCanvas={(c) => (latest = c)} />)

    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Note' }))
    const editor = await screen.findByRole('textbox')
    await waitFor(() => expect(latest.nodes).toHaveLength(1))

    await userEvent.type(editor, 'changed my mind')
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(latest.nodes).toHaveLength(0))
  })

  it('keeps the box when Escape lands before any typing — sketching layouts', async () => {
    let latest: SpatialCanvas = { nodes: [], edges: [] }
    render(<Host onCanvas={(c) => (latest = c)} />)

    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Note' }))
    await screen.findByRole('textbox')
    await waitFor(() => expect(latest.nodes).toHaveLength(1))

    await userEvent.keyboard('{Escape}')

    // The editor closes; the empty box stays. Someone placing boxes to think
    // about a layout is not cancelling the box — only the typing.
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    expect(latest.nodes).toHaveLength(1)
    expect(latest.nodes[0]?.type === 'text' ? latest.nodes[0].text : 'unset').toBe('')
  })

  it('keeps an existing note and its stored text when the edit is cancelled', async () => {
    let latest: SpatialCanvas = { nodes: [], edges: [] }
    render(<Host onCanvas={(c) => (latest = c)} />)

    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Note' }))
    const editor = await screen.findByRole('textbox')
    await userEvent.type(editor, 'kept')
    // Commit, then reopen the SAME node and cancel: the node survives.
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => {
      const node = latest.nodes[0]
      expect(node?.type === 'text' ? node.text : undefined).toBe('kept')
    })

    const box = await screen.findByText('kept')
    await userEvent.dblClick(box)
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(latest.nodes).toHaveLength(1))
    const kept = latest.nodes[0]
    expect(kept?.type === 'text' ? kept.text : undefined).toBe('kept')
  })
})
