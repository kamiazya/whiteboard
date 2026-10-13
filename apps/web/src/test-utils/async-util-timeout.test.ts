/**
 * The jsdom project's `findBy*`/`waitFor` ceiling is raised in
 * `vitest.setup.ts`, the way `browser-setup.ts` raises the browser one. Held
 * here because the failure it prevents only shows on a loaded machine, where
 * it reads as a regression in whatever the diff touched.
 */
import { getConfig } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('the jsdom async-util ceiling', () => {
  it('is raised above the library default of 1000ms', () => {
    expect(getConfig().asyncUtilTimeout).toBeGreaterThanOrEqual(5_000)
  })
})
