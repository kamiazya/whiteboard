import { installSearchCore, searchCoreInstalled } from '@kamiazya/whiteboard-search'
import { afterEach, describe, expect, it } from 'vitest'
import { searchReady } from './search-core.js'

// `@kamiazya/whiteboard-search` has no TypeScript behind it, so a caller that
// can wait awaits `searchReady()`; it joins the page's one wasm load.

let realm: ReturnType<typeof installSearchCore>
afterEach(() => {
  installSearchCore(realm)
})

describe('searchReady', () => {
  it('installs the loaded core where none is installed, answering search through it', async () => {
    realm = installSearchCore(undefined)
    expect(searchCoreInstalled()).toBe(false)
    await searchReady()
    expect(searchCoreInstalled()).toBe(true)
    const installed = installSearchCore(undefined)
    expect(installed?.foldForSearch('Café')).toBe('cafe')
  })

  it('keeps a core the realm already installed', async () => {
    realm = installSearchCore(undefined)
    const own = { ...(realm as NonNullable<typeof realm>), foldForSearch: () => 'own' }
    installSearchCore(own)
    await searchReady()
    expect(installSearchCore(undefined)).toBe(own)
  })
})
