import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, it } from 'vitest'
import { page } from 'vitest/browser'
import { BrowserLocalIndexPage } from '../pages/BrowserLocalIndexPage.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import '../index.css'
import { resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/onboarding-chooser.png — the object chooser a fresh
// browser lands on, used by the getting-started tutorial.

afterEach(cleanup)

describe('docs snapshot: onboarding chooser', () => {
  it('captures the empty-workspace chooser', async () => {
    const store = new LocalStoreDouble()

    render(
      <MemoryRouter initialEntries={['/']}>
        <div style={{ height: '100vh', background: 'white' }}>
          <BrowserLocalIndexPage
            index={store.index}
            pointer={store.pointer}
            clock={store.clock}
            onOpenDocument={() => {}}
          />
        </div>
      </MemoryRouter>,
    )

    await waitFor(() => {
      if (!document.body.textContent?.includes('What will you make first?')) {
        throw new Error('chooser not settled')
      }
    })

    await page.screenshot({ path: resolveDocAssetPath('onboarding-chooser.png') })
  })
})
