// A tooltip must not outlive the gesture that raised it.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.js'

afterEach(cleanup)

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
