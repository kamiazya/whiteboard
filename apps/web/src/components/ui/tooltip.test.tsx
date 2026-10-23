import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Radix opens on a timer even at zero delay; let any such open happen. */
const tick = () => act(() => vi.advanceTimersByTimeAsync(50))

function coarsePointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
  }))
}

function Fixture() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button">Target</button>
      </TooltipTrigger>
      <TooltipContent>Target hint</TooltipContent>
    </Tooltip>
  )
}

// The positive half — keyboard focus still opens one — is a browser test
// (tooltip.browser.test.tsx): jsdom treats only the FIRST focus in a document
// as :focus-visible, so under a repeated run the gate would refuse for the
// wrong reason.
describe('Tooltip on a coarse pointer', () => {
  it('does not open from a pointer entering the trigger', async () => {
    vi.useFakeTimers()
    coarsePointer(true)
    render(<Fixture />)
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Target' }), { pointerType: 'mouse' })
    await tick()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not open from a tap focusing the trigger', async () => {
    vi.useFakeTimers()
    coarsePointer(true)
    render(<Fixture />)
    const target = screen.getByRole('button', { name: 'Target' })
    fireEvent.pointerEnter(target, { pointerType: 'touch' })
    fireEvent.focus(target)
    await tick()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on hover with a fine pointer', async () => {
    coarsePointer(false)
    render(<Fixture />)
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Target' }), { pointerType: 'mouse' })
    expect((await screen.findAllByRole('tooltip')).length).toBeGreaterThan(0)
  })
})
