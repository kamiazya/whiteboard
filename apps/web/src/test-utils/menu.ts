import { waitFor } from '@testing-library/react'
import { expect } from 'vitest'

/**
 * Resolves once no Radix menu is mounted.
 *
 * Call this before activating a menu trigger for the SECOND time in a test.
 * The menus here are non-modal, so a click that arrives while the previous
 * one is still dismissing is consumed by the dismissal and the menu stays
 * shut. The failure then reads as "the list does not contain this item" when
 * no list was ever opened — measured at one such failure: no `[role="menu"]`,
 * trigger connected, `aria-expanded="false"` — so raising the following
 * query's timeout only buys a slower identical failure.
 */
export async function waitForMenuClosed(): Promise<void> {
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull(), {
    timeout: 10_000,
  })
}
