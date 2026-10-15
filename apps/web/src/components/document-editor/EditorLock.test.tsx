import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EditorLock } from './EditorLock.js'

const idle = {
  restoreInProgress: false,
  restoreLabel: null,
  backendError: null,
} as const

describe('EditorLock before the document has arrived', () => {
  it('takes no input and says the document is still opening', () => {
    render(
      <EditorLock sync={{ ...idle, loaded: false }} onLeave={undefined}>
        <button type="button">draw</button>
      </EditorLock>,
    )

    expect(screen.getByRole('button', { name: 'draw' }).closest('[inert]')).not.toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/Opening this document/)
    // Shown, not only announced: a sighted person sees why nothing takes input.
    expect(screen.getByRole('status').className).not.toMatch(/\bsr-only\b/)
  })

  it('takes input once it has', () => {
    render(
      <EditorLock sync={{ ...idle, loaded: true }} onLeave={undefined}>
        <button type="button">draw</button>
      </EditorLock>,
    )

    expect(screen.getByRole('button', { name: 'draw' }).closest('[inert]')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
