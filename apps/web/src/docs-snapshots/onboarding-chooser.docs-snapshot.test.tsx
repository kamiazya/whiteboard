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

    // The welcome mark draws itself over 1.1s (wb-scribble); a screenshot
    // mid-stroke is a different image every run. Suppress animation so the
    // capture lands on the finished stroke — exactly what reduced-motion
    // users see.
    const still = document.createElement('style')
    still.textContent = '* { animation: none !important; transition: none !important; }'
    document.head.appendChild(still)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

    await page.screenshot({ path: resolveDocAssetPath('onboarding-chooser.png') })
  })
})
