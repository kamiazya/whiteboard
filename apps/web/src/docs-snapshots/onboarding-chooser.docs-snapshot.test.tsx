import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, it } from 'vitest'
import { page } from 'vitest/browser'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { BrowserIndexPage } from '../pages/BrowserIndexPage.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import '../index.css'
import { resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/onboarding-chooser.png — the object chooser a fresh
// browser lands on, used by the getting-started tutorial.

afterEach(cleanup)

describe('docs snapshot: onboarding chooser', () => {
  it('captures the empty-workspace chooser', async () => {
    const store = new LocalStoreDouble()
    // Named so the page's h1 (visible since #1129) reads as a workspace a
    // person named, not the raw ULID the seeded double falls back to.
    await store.index.renameWorkspace({
      workspaceId: getBrowserWorkspaceId(),
      displayName: 'Main workspace',
    })

    render(
      <MemoryRouter initialEntries={['/']}>
        <div style={{ height: '100vh', background: 'white' }}>
          <BrowserIndexPage
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
      if (document.querySelector('h1')?.textContent !== 'Main workspace') {
        throw new Error('workspace name not yet rendered')
      }
    })

    // The hero <img> plays the boot-splash story; the config's
    // reducedMotion: 'reduce' context collapses it to the static drawn
    // logo, so this capture is deterministic without reaching inside the
    // image's own SVG document.
    await new Promise((resolve) => setTimeout(resolve, 300))

    await page.screenshot({ path: resolveDocAssetPath('onboarding-chooser.png') })
  })
})
