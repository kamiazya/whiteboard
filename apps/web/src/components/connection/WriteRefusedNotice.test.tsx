import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDocumentSync } from '../../hooks/useDocumentSync.js'
import {
  dismissWriteRefusal,
  getWriteRefusal,
  showWriteRefusal,
} from '../../lib/write-refusal-store.js'
import { WriteRefusedNotice } from './WriteRefusedNotice.js'

afterEach(() => {
  cleanup()
  dismissWriteRefusal()
})

describe('the notice for a change the keeper refused', () => {
  it('says the change was not saved and why, in words about what was done', () => {
    render(<WriteRefusedNotice />)
    expect(screen.queryByRole('alert')).toBeNull()

    act(() => showWriteRefusal({ code: 'markdown_too_large', message: 'body of 300000' }))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Your last change was not saved.')
    expect(alert.textContent).toContain('longer than one document may be')
    expect(alert.textContent).toContain('It was undone, with anything typed after it')
  })

  it("speaks the keeper's own sentence for a code this build cannot name", () => {
    render(<WriteRefusedNotice />)
    act(() => showWriteRefusal({ code: null, message: 'A newer keeper rule.' }))
    expect(screen.getByRole('alert').textContent).toContain('A newer keeper rule.')
  })

  it('goes away when dismissed', () => {
    render(<WriteRefusedNotice />)
    act(() => showWriteRefusal({ code: 'invalid_path', message: 'bad' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a document page whose keeper refuses a change', () => {
  function backendHandingOver(): {
    backend: DocumentBackend
    handlers: () => DocumentBackendHandlers
  } {
    let handlers: DocumentBackendHandlers | null = null
    const backend: DocumentBackend = {
      connect: (h) => {
        handlers = h
      },
      disconnect: () => {},
      pushLocalUpdate: () => Promise.resolve(),
      sendClientReady: () => {},
    }
    return { backend, handlers: () => handlers as unknown as DocumentBackendHandlers }
  }

  it('shows the notice, and takes it down with the document', () => {
    const { backend, handlers } = backendHandingOver()
    const { unmount } = renderHook(() => useDocumentSync(backend))
    const refusal = { code: 'node_text_too_large', message: 'too long' } as const

    act(() => handlers().onWriteRefused?.(refusal))
    expect(getWriteRefusal()).toEqual(refusal)

    unmount()
    expect(getWriteRefusal()).toBeNull()
  })
})
