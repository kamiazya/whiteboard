// @vitest-environment jsdom

/**
 * The history panel is a COLUMN of the editor row, not a popover.
 *
 * It used to be a 340x480 box floating over the canvas, anchored to the
 * spatial dock. A past state cannot be previewed inside that, and a markdown
 * document had no dock to anchor it to — so the shell that both pages already
 * stand in is where the column belongs, and both pages get it at once.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentPageShell } from './DocumentPageShell.js'
import { InspectorPanel } from './InspectorPanel.js'

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

/**
 * The shell holds a leaving pane so it can animate out, and that hold has to
 * end even where nothing animates.
 *
 * jsdom runs no CSS animations, so the `animationend` the exit waits on
 * never arrives — and a build that dropped the animation utilities would
 * behave the same. Left to the shell's ceiling the pane sits over the
 * editor for a second, which is how this was found: a page test asserting
 * the History panel is gone after a second click on its toggle.
 *
 * `InspectorPanel` is the subject rather than a bare `<aside>`, because
 * letting go is its half of the contract.
 */
describe('DocumentPageShell lets a leaving pane go', () => {
  function Host({ open }: { readonly open: boolean }) {
    return (
      <DocumentPageShell
        srTitle="doc"
        header={<div />}
        {...(open
          ? {
              aside: (
                <InspectorPanel kind="comments" onClose={() => {}}>
                  <p>a conversation</p>
                </InspectorPanel>
              ),
            }
          : {})}
      >
        <div data-testid="editor" />
      </DocumentPageShell>
    )
  }

  it('at once when no animation runs, rather than leaving it over the editor', async () => {
    const { rerender } = render(<Host open />)
    expect(screen.queryByTestId('comments-rail')).not.toBeNull()

    rerender(<Host open={false} />)

    // Well inside the shell's 1000ms ceiling, and that bound is the whole
    // test: testing-library's default `waitFor` timeout is 1000ms too, so
    // the first version of this passed whether the pane left on the next
    // frame or sat until the ceiling dropped it — a guard that could not
    // fail. Mutation-checked at this timeout: removing the early let-go
    // fails it.
    await waitFor(() => expect(screen.queryByTestId('comments-rail')).toBeNull(), {
      timeout: 200,
    })
  })
})
