// The dot end to end in a REAL browser: a real open writes a real baseline
// to real localStorage, and the next mount compares a real listing against
// it. jsdom covers the rendering; what only this proves is that the two
// halves meet through storage the panel actually writes to.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
// The real stylesheet, so computed colours are the app's and not the
// browser defaults — the same import manipulation-tokens.browser.test.tsx
// needs for the same reason.
import '../../index.css'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { STORAGE_KEY } from '../../lib/seen-documents.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

let rows: WorkspaceDocumentEntry[] = []

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY)
  rows = [
    { documentId: 'd1', path: 'roadmap', name: 'Roadmap', kind: 'markdown', contentDigest: 'v1' },
    { documentId: 'd2', path: 'tokens', name: 'Tokens', kind: 'markdown', contentDigest: 'v1' },
  ]
})
afterEach(() => {
  cleanup()
  localStorage.removeItem(STORAGE_KEY)
  document.documentElement.classList.remove('dark')
})

function renderPanel() {
  render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({ listDocuments: async () => rows })}
      workspace="space"
      onOpenDocument={() => {}}
    />,
  )
}

async function openCard(name: string) {
  const grid = await screen.findByTestId('folder-contents')
  const title = await within(grid).findByText(name)
  const card = title.closest('button')
  if (card === null) throw new Error(`no card for ${name}`)
  await userEvent.dblClick(card)
}

// Scoped to the GRID: once a document has been opened the recently-opened
// lane carries the same name, so an unscoped query is ambiguous exactly when
// the test has done its setup.
async function settle(name: string) {
  const grid = await screen.findByTestId('folder-contents')
  await within(grid).findByText(name)
}

/**
 * Whether a computed colour carries any hue at all.
 *
 * Both forms are handled because the browser echoes whichever the stylesheet
 * used: a `var(--primary)` background computes back as `oklch(0.205 0 0)`,
 * where the SECOND number is chroma. Reading that string with a bare `\d+`
 * match — as the first version of this guard did — parses `0.205 0 0` into
 * `[0, 205, 0]` and calls a pure grey chromatic, which is a guard that
 * passes for a reason unrelated to what it claims.
 */
function isChromatic(colour: string): boolean {
  const oklch = colour.match(/^oklch\(\s*[\d.]+\s+([\d.]+)/)
  if (oklch !== null) return Number(oklch[1]) > 0
  const rgb = (colour.match(/\d+/g) ?? []).slice(0, 3).map(Number)
  if (rgb.length < 3) throw new Error(`unrecognised colour: ${colour}`)
  return Math.max(...rgb) !== Math.min(...rgb)
}

const dotFor = (name: string) => {
  const title = screen.getAllByTestId('card-title').find((each) => each.textContent === name)
  const card = (title as HTMLElement).closest('button') as HTMLElement
  return within(card).queryByRole('img', { name: /changed since/i })
}

describe('changed since you last opened it', () => {
  it('says nothing about a document this device has never opened', async () => {
    renderPanel()
    await settle('Roadmap')

    expect(dotFor('Roadmap')).toBeNull()
  })

  it('stays silent when the content has not moved since the open', async () => {
    renderPanel()
    await openCard('Roadmap')
    cleanup()

    renderPanel()
    await settle('Roadmap')
    expect(dotFor('Roadmap')).toBeNull()
  })

  it('marks the document whose content moved while the person was elsewhere', async () => {
    renderPanel()
    await openCard('Roadmap')
    cleanup()

    // What an agent writing to the document looks like from here: the same
    // row comes back under a different content identity.
    rows = rows.map((row) => (row.path === 'roadmap' ? { ...row, contentDigest: 'v2' } : row))
    renderPanel()

    await waitFor(() => expect(dotFor('Roadmap')).not.toBeNull())
    // And only that one: the untouched neighbour was never opened, so it has
    // no baseline and must stay silent rather than read as changed.
    expect(dotFor('Tokens')).toBeNull()
  })

  it('is drawn in a hue rather than in ink, on both grounds', async () => {
    // `bg-primary` shipped first and this theme's `--primary` is
    // `oklch(0.205 0 0)` — chroma ZERO — so the dot came out black in light
    // mode and white in dark, reading as punctuation rather than as a
    // status.
    //
    // The colour is now the settings nudge's, which BRAND.md reserves as the
    // blue spark; that agreement is pinned by source in
    // `badge-colour-surface.test.ts`. What THIS test adds is the rendered
    // half: not grey, and unchanged by the theme, because a brand hue is
    // chosen to read on both grounds rather than swapped per mode.
    renderPanel()
    await openCard('Roadmap')
    cleanup()
    rows = rows.map((row) => (row.path === 'roadmap' ? { ...row, contentDigest: 'v2' } : row))

    renderPanel()
    await waitFor(() => expect(dotFor('Roadmap')).not.toBeNull())
    const light = getComputedStyle(dotFor('Roadmap') as HTMLElement).backgroundColor
    expect(isChromatic(light)).toBe(true)

    document.documentElement.classList.add('dark')
    expect(getComputedStyle(dotFor('Roadmap') as HTMLElement).backgroundColor).toBe(light)
  })

  it('clears once the person opens it again', async () => {
    renderPanel()
    await openCard('Roadmap')
    cleanup()
    rows = rows.map((row) => (row.path === 'roadmap' ? { ...row, contentDigest: 'v2' } : row))

    renderPanel()
    await waitFor(() => expect(dotFor('Roadmap')).not.toBeNull())
    await openCard('Roadmap')

    await waitFor(() => expect(dotFor('Roadmap')).toBeNull())
  })
})
