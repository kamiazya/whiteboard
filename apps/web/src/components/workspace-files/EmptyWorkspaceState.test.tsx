// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmptyWorkspaceState } from './EmptyWorkspaceState.js'

afterEach(cleanup)

describe('EmptyWorkspaceState chooser', () => {
  // The first screen a fresh user sees asks a question and shows the two
  // OBJECTS — not a verb button whose label they must decode.
  it('asks what to make first and offers both kinds as visual choices', () => {
    const onCreate = vi.fn()
    render(<EmptyWorkspaceState onCreate={onCreate} subtitle="stays here" />)

    // The brand lockup from the README greets arrivals here: the signature
    // draws itself once (wb-scribble one-shot, never a loop) and the
    // wordmark names the product — this is the one surface where the name
    // is not already in the surrounding chrome.
    expect(document.querySelector('[data-mark="welcome"] .wb-scribble')).toBeTruthy()
    expect(screen.getByText('Whiteboard')).toBeTruthy()
    expect(screen.getByText('What will you make first?')).toBeTruthy()
    expect(screen.getByText('stays here')).toBeTruthy()
    // Each card teaches its kind in one line.
    expect(screen.getByText('Place notes and connect them in space.')).toBeTruthy()
    expect(screen.getByText('Start writing. Put it on a canvas later.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create a markdown note' }))
    expect(onCreate.mock.calls).toEqual([['spatial'], ['markdown']])
  })

  it('disables both choices while a create is in flight', () => {
    render(<EmptyWorkspaceState onCreate={() => {}} disabled />)
    expect(screen.getByRole('button', { name: 'Create a canvas' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(
      screen.getByRole('button', { name: 'Create a markdown note' }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('omits the subtitle line when none is given', () => {
    render(<EmptyWorkspaceState onCreate={() => {}} />)
    expect(screen.queryByTestId('empty-state-subtitle')).toBeNull()
  })
})
