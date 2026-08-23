import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { EmptyWorkspaceState } from './EmptyWorkspaceState.js'

// A phone put the two choice cards in a COLUMN (fixed card width + wrap):
// the chooser's whole point is one glance at both objects, so the pair
// must share a row even at phone width.

afterEach(async () => {
  await page.viewport(1280, 800)
})

describe('onboarding chooser layout', () => {
  it('keeps both choices on one row at phone width', async () => {
    await page.viewport(375, 700)
    render(<EmptyWorkspaceState onCreate={() => {}} />)

    const canvas = document.querySelector('button[aria-label="Create a canvas"]')
    const note = document.querySelector('button[aria-label="Create a markdown note"]')
    if (!canvas || !note) throw new Error('choice buttons missing')
    const a = canvas.getBoundingClientRect()
    const b = note.getBoundingClientRect()
    expect(a.top).toBe(b.top)
    // And neither card is squeezed into an unreadable sliver.
    expect(a.width).toBeGreaterThan(120)
    expect(b.width).toBeGreaterThan(120)
  })
})
