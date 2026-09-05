// @vitest-environment jsdom

/**
 * The history panel is a COLUMN of the editor row, not a popover.
 *
 * It used to be a 340x480 box floating over the canvas, anchored to the
 * spatial dock. A past state cannot be previewed inside that, and a markdown
 * document had no dock to anchor it to — so the shell that both pages already
 * stand in is where the column belongs, and both pages get it at once.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentPageShell } from './DocumentPageShell.js'

afterEach(() => cleanup())

describe('DocumentPageShell places the history column', () => {
  it('renders the aside beside the editor row, both inside the row that owns the remaining height', () => {
    render(
      <DocumentPageShell
        srTitle="doc"
        header={<div data-testid="hdr" />}
        aside={<aside data-testid="pane">history</aside>}
      >
        <div data-testid="editor" />
      </DocumentPageShell>,
    )
    const editor = screen.getByTestId('editor')
    const pane = screen.getByTestId('pane')
    // Same row: the editor's column and the pane are siblings under one parent.
    expect(editor.parentElement?.parentElement).toBe(pane.parentElement)
    // The header is NOT in that row — a column beside the editor must not
    // push the top bar sideways.
    expect(screen.getByTestId('hdr').parentElement).not.toBe(pane.parentElement)
  })

  it('keeps the editor mounted when an aside arrives, rather than re-parenting the row around it', () => {
    // The row is wrapped whether or not there is an aside. Wrapping it only
    // once one arrived moved the editor to a new parent, and React remounts
    // what changes parent — the spatial editor lost its viewport and
    // selection every time the history column or the comments rail opened.
    const { rerender } = render(
      <DocumentPageShell srTitle="doc" header={<div />}>
        <div data-testid="editor" />
      </DocumentPageShell>,
    )
    const editorBefore = screen.getByTestId('editor')
    rerender(
      <DocumentPageShell
        srTitle="doc"
        header={<div />}
        aside={<aside data-testid="pane">history</aside>}
      >
        <div data-testid="editor" />
      </DocumentPageShell>,
    )
    // The same DOM node, still attached: a remount would have replaced it.
    expect(screen.getByTestId('editor')).toBe(editorBefore)
    expect(editorBefore.isConnected).toBe(true)
  })
})
