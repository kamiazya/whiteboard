import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../index.css'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { setViewport } from '../../test-utils/viewport.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// Real browser at a phone's width: the subject is how the toolbar's row
// shares 390px between where you are and what you are looking for.

afterEach(async () => {
  cleanup()
  await setViewport(1280, 800)
})

async function renderInFolder() {
  await setViewport(390, 844)
  render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({
        listDocuments: async () => [
          {
            documentId: 'd1',
            path: 'site-visits/north/pumps/pump',
            name: 'Pump room',
            kind: 'markdown',
          },
        ],
        listFolderNames: async () => [
          { path: 'site-visits', name: 'Site visits' },
          { path: 'site-visits/north', name: 'North wing, second floor' },
          { path: 'site-visits/north/pumps', name: 'Pumps and valves' },
        ],
      })}
      initialFolder="site-visits/north/pumps"
      onOpenDocument={() => {}}
    />,
  )
  const trail = await screen.findByRole('navigation', { name: 'Folder path' })
  return {
    trail,
    current: await within(trail).findByRole('button', { name: 'Pumps and valves' }),
  }
}

describe('the home toolbar at 390px', () => {
  it('keeps the folder path on one unbroken row', async () => {
    const { trail, current } = await renderInFolder()
    const root = within(trail).getByRole('button', { name: 'Workspace' })
    expect(current.getBoundingClientRect().top).toBeCloseTo(root.getBoundingClientRect().top, 0)
    expect(current.getBoundingClientRect().height).toBeLessThan(30)
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth)
    expect(trail.getBoundingClientRect().right).toBeLessThanOrEqual(390)
    // The deepest folder is the one in view when the trail is longer than the row.
    expect(current.getBoundingClientRect().right).toBeLessThanOrEqual(
      trail.getBoundingClientRect().right + 1,
    )
  })

  it('gives the search box a row of its own', async () => {
    const { trail } = await renderInFolder()
    const search = screen.getByLabelText('Search documents')
    expect(search.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      trail.getBoundingClientRect().bottom,
    )
    expect(search.getBoundingClientRect().width).toBeGreaterThanOrEqual(200)
  })

  it('lets the search box span the row, sharing it with nothing', async () => {
    const { trail } = await renderInFolder()
    const search = screen.getByLabelText('Search documents').getBoundingClientRect()
    const row = trail.parentElement?.parentElement?.getBoundingClientRect()
    expect(search.width).toBeGreaterThanOrEqual((row?.width ?? 0) - 1)
    for (const name of ['New document', 'One column']) {
      const other = screen.getByRole('button', { name }).getBoundingClientRect()
      expect(other.top >= search.bottom || other.bottom <= search.top).toBe(true)
    }
  })
})
