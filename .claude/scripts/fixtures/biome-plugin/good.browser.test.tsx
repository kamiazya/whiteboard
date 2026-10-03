import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { page } from 'vitest/browser'

// ASCII keystrokes, a key descriptor, and the sanctioned remedy — fill —
// carrying the non-ASCII text: none of these may trip the rule.
export async function goodKeystrokes() {
  await userEvent.keyboard('hello world')
  await userEvent.keyboard('{Enter}plain ascii')
  await userEvent.fill(screen.getByRole('textbox'), 'リリース計画')
}

// Asserting on the DOM is the sanctioned alternative to a screenshot.
export async function goodAssertion() {
  await page.getByRole('button').click()
}
