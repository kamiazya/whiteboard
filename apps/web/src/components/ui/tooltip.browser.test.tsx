// A tooltip must not outlive the gesture that raised it.
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Fixture() {
  return (
    <div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">Target</button>
        </TooltipTrigger>
        <TooltipContent>Target hint</TooltipContent>
      </Tooltip>
      <button type="button">Elsewhere</button>
    </div>
  )
}

it('closes when the pointer leaves the trigger', async () => {
  render(<Fixture />)
  await userEvent.hover(page.getByRole('button', { name: 'Target' }))
  await expect.element(page.getByRole('tooltip')).toBeVisible()
  await userEvent.unhover(page.getByRole('button', { name: 'Target' }))
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
})

it('closes on a click of the trigger and stays closed', async () => {
  render(<Fixture />)
  const target = page.getByRole('button', { name: 'Target' })
  await userEvent.hover(target)
  await expect.element(page.getByRole('tooltip')).toBeVisible()
  await userEvent.click(target)
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
})

it('closes when keyboard focus moves on from the trigger', async () => {
  render(<Fixture />)
  await userEvent.tab()
  await expect.element(page.getByRole('button', { name: 'Target' })).toHaveFocus()
  await expect.element(page.getByRole('tooltip')).toBeVisible()
  await userEvent.tab()
  await expect.element(page.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
})

it('closes on Escape while the trigger keeps focus', async () => {
  render(<Fixture />)
  await userEvent.tab()
  await expect.element(page.getByRole('tooltip')).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
})

it('closes when focus moves on after the pointer had also been over the trigger', async () => {
  render(<Fixture />)
  const target = page.getByRole('button', { name: 'Target' })
  await userEvent.hover(target)
  await expect.element(page.getByRole('tooltip')).toBeVisible()
  await userEvent.tab()
  await userEvent.tab()
  await expect.element(page.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
})

it('closes when the focused trigger is replaced while its tooltip is showing', async () => {
  function Swapping() {
    const [swapped, setSwapped] = useState(false)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            key={swapped ? 'b' : 'a'}
            type="button"
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSwapped(true)
            }}
          >
            {swapped ? 'Swapped' : 'Target'}
          </button>
        </TooltipTrigger>
        <TooltipContent>Target hint</TooltipContent>
      </Tooltip>
    )
  }
  render(<Swapping />)
  await userEvent.tab()
  await expect.element(page.getByRole('tooltip')).toBeVisible()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('button', { name: 'Swapped' })).toBeInTheDocument()
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
})

// A coarse pointer refuses the tap-raised tooltip (tooltip.test.tsx) but a
// keyboard user still gets one: focus that arrives by Tab is :focus-visible.
it('on a coarse pointer, Tab onto the trigger still opens it', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
  render(<Fixture />)
  await userEvent.keyboard('{Tab}')
  await expect.element(page.getByRole('tooltip')).toBeVisible()
})
