/**
 * Enter on a document row OPENS it, and does not also select it.
 *
 * A REAL browser, because jsdom cannot show this at all: pressing Enter on
 * a focused `<button>` fires a native click, and jsdom does not synthesize
 * that activation. So the `event.preventDefault()` in the row's `onKeyDown`
 * — whose whole job is to stop the click that would follow — is invisible
 * to every jsdom test. Measured: removing it left all 11 of them green.
 *
 * Without it the row runs BOTH callbacks for one keypress: `onActivate`
 * from the handler and `onOpen` from the click behind it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { WorkspaceFileTree } from './WorkspaceFileTree.js'

afterEach(cleanup)

const documents = [{ documentId: 'c-root', path: 'readme', name: 'Readme' }]

describe('a document row under the keyboard', () => {
  it('runs the open once on Enter, and never the select behind it', async () => {
    const onOpen = vi.fn()
    const onActivate = vi.fn()
    render(<WorkspaceFileTree documents={documents} onOpen={onOpen} onActivate={onActivate} />)

    const row = screen.getByText('Readme').closest('button') as HTMLElement
    row.focus()
    await userEvent.keyboard('{Enter}')

    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledWith(documents[0])
    // The one the preventDefault suppresses.
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('still selects on a plain click, which is the other half of the pair', async () => {
    const onOpen = vi.fn()
    const onActivate = vi.fn()
    render(<WorkspaceFileTree documents={documents} onOpen={onOpen} onActivate={onActivate} />)

    await userEvent.click(screen.getByText('Readme').closest('button') as HTMLElement)

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
  })
})
