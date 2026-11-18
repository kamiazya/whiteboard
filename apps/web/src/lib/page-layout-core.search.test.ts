import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'

const ready = vi.hoisted(() => ({ fail: undefined as Error | undefined }))
vi.mock('./search-core.js', () => ({
  searchReady: () => (ready.fail === undefined ? Promise.resolve() : Promise.reject(ready.fail)),
}))

import { startLayoutCore } from './page-layout-core.js'

// The boot sequence awaits startLayoutCore before the first render, so search
// failing to install must cost the page nothing: search stays unavailable and
// its callers degrade.

beforeEach(() => {
  ready.fail = undefined
})

describe('startLayoutCore when search cannot be installed', () => {
  it('settles, and logs why search is unavailable', async () => {
    ready.fail = new Error('search chunk failed to load')
    await expect(startLayoutCore()).resolves.toBeUndefined()
    await expectLoggedFailure('search did not install')
  })

  it('settles quietly when it installs', async () => {
    await expect(startLayoutCore()).resolves.toBeUndefined()
  })
})
