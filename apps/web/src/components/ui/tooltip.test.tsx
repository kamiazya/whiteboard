import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.js'

afterEach(() => vi.unstubAllGlobals())

function coarsePointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
  }))
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

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

describe('Tooltip on a coarse pointer', () => {
  it('does not open from a pointer entering the trigger', async () => {
    coarsePointer(true)
    render(<Fixture />)
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Target' }), { pointerType: 'mouse' })
    await tick()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not open from a tap focusing the trigger', async () => {
    coarsePointer(true)
    render(<Fixture />)
    const target = screen.getByRole('button', { name: 'Target' })
    fireEvent.pointerEnter(target, { pointerType: 'touch' })
    fireEvent.focus(target)
    await tick()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('still opens for keyboard focus', async () => {
    coarsePointer(true)
    render(<Fixture />)
    screen.getByRole('button', { name: 'Target' }).focus()
    expect((await screen.findAllByRole('tooltip')).length).toBeGreaterThan(0)
  })

  it('opens on hover with a fine pointer', async () => {
    coarsePointer(false)
    render(<Fixture />)
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Target' }), { pointerType: 'mouse' })
    expect((await screen.findAllByRole('tooltip')).length).toBeGreaterThan(0)
  })
})
