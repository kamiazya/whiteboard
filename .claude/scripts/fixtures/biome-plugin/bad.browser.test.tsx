import { screen } from '@testing-library/react'
import { page } from 'vitest/browser'
import { userEvent } from '@testing-library/user-event'

// Four shapes the rule must catch: the plain receiver, a setup() alias, a
// template literal, and type()'s SECOND argument.
export async function badKeystrokes() {
  await userEvent.keyboard('リリース計画')
  const user = userEvent.setup()
  await user.keyboard('計画')
  await userEvent.keyboard(`hello — world`)
  await userEvent.type(screen.getByRole('textbox'), '計画')
}

// A screenshot call, with and without arguments.
export async function badScreenshots() {
  await page.screenshot({ path: 'out.png' })
  await page.screenshot()
}
