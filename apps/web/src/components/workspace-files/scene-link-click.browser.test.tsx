// A wiki link in a drawn document is an `<a href="<documentId>">` — a bare
// id the browser resolves against the page URL. Followed, it reloads the tab
// onto a route naming no document (`/w/<documentId>` reads as a WORKSPACE).
// So every surface that draws a document on the workspace index answers the
// click itself: the preview opens the target in place, and a card's picture
// never navigates, since a click on a card means the card.
//
// The click is dispatched rather than performed: a trusted click on an
// unguarded anchor navigates the test page itself, and the document-level
// listener below both records whether the surface prevented it and keeps a
// regression from taking the runner down with it.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { STORAGE_KEY } from '../../lib/recent-documents.js'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { DocumentThumbnail } from './DocumentThumbnail.js'
import { createRowRenderLoader } from './load-row-render.js'
import { RecentLane } from './RecentLane.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const PLAN = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const LINKER = '01ARZ3NDEKTSV4RRFFQ69G5FB3'
// The Recent lane shows only when there are more documents than one grid row
// holds, so the fixture carries enough to outnumber any column count.
const FILLERS: WorkspaceDocumentEntry[] = Array.from({ length: 24 }, (_, i) => ({
  documentId: `01ARZ3NDEKTSV4RRFFQ69G6${String(i).padStart(3, '0')}`,
  path: `filler-${i}`,
  kind: 'markdown' as const,
}))
const docs: WorkspaceDocumentEntry[] = [
  { documentId: PLAN, path: 'plan', kind: 'markdown' },
  { documentId: LINKER, path: 'linker', kind: 'markdown' },
  ...FILLERS,
]
const bodies: Record<string, string> = {
  [PLAN]: '# Plan',
  [LINKER]: '# Linker\n\nsee [[plan]] here',
}
const source = () =>
  fakeFilesSource({
    listDocuments: async () => docs,
    loadMarkdown: async (entry) => ({ body: bodies[entry.documentId] ?? '' }),
  })

afterEach(() => {
  cleanup()
  localStorage.removeItem(STORAGE_KEY)
})

async function anchorIn(selector: string): Promise<Element> {
  return vi.waitFor(
    () => {
      const anchor = document.querySelector(`${selector} a[href]`)
      if (anchor === null) throw new Error(`no anchor under ${selector} yet`)
      return anchor
    },
    { timeout: 20_000 },
  )
}

/** The drawn link's ink in a card picture, once the picture has landed. */
async function linkInkIn(selector: string): Promise<Element> {
  return vi.waitFor(
    () => {
      const ink = [...document.querySelectorAll(`${selector} svg text`)].find((text) =>
        text.textContent?.includes('plan'),
      )
      if (ink === undefined) throw new Error(`no drawn link under ${selector} yet`)
      return ink
    },
    { timeout: 20_000 },
  )
}

/** Dispatches a click on `anchor`; answers whether the surface prevented it. */
function clickAnchor(anchor: Element): boolean {
  let prevented: boolean | undefined
  const record = (event: MouseEvent) => {
    prevented = event.defaultPrevented
    event.preventDefault()
  }
  document.addEventListener('click', record)
  try {
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  } finally {
    document.removeEventListener('click', record)
  }
  if (prevented === undefined) throw new Error('the click never reached the document')
  return prevented
}

it('a wiki link in the preview opens its target in place', async () => {
  const onOpenDocument = vi.fn()
  render(<WorkspaceFilesPanel source={source()} onOpenDocument={onOpenDocument} />)
  const card = await screen.findByRole('button', { name: /linker/i })
  await userEvent.click(card)
  const anchor = await anchorIn('[data-testid="preview-render"]')
  expect(anchor.getAttribute('href')).toBe(PLAN)

  expect(clickAnchor(anchor)).toBe(true)
  await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('plan'))
  expect(onOpenDocument).toHaveBeenCalledTimes(1)
})

it('a document opened through a preview link joins the Recent lane', async () => {
  localStorage.removeItem(STORAGE_KEY)
  render(<WorkspaceFilesPanel source={source()} memoryScope="links" onOpenDocument={() => {}} />)
  await userEvent.click(await screen.findByRole('button', { name: /linker/i }))
  const anchor = await anchorIn('[data-testid="preview-render"]')

  clickAnchor(anchor)
  const lane = await screen.findByTestId('recent-lane')
  await waitFor(() =>
    expect(
      within(lane)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['plan']),
  )
})

it('a link inside a card picture opens the card, not the link', async () => {
  const opened: string[] = []
  const load = createRowRenderLoader({
    theme: 'light',
    broker: createInTabRenderBroker(),
    documents: () => docs,
    source: source(),
  })
  render(
    <RecentLane
      documents={docs}
      recentIds={[LINKER]}
      onSelect={(entry) => opened.push(entry.path)}
      onOpen={() => {}}
      renderThumbnail={(entry) => (
        <DocumentThumbnail document={entry} loadRender={load} className="size-full" />
      )}
    />,
  )
  const ink = await linkInkIn('[data-testid="document-thumbnail"]')

  // A picture draws the link as ink, not as an anchor, so there is nothing
  // to follow and the click is the card's.
  expect(ink.closest('a')).toBeNull()
  ink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  expect(opened).toEqual(['linker'])
})

it('nothing drawn in a card picture takes keyboard focus', async () => {
  const load = createRowRenderLoader({
    theme: 'light',
    broker: createInTabRenderBroker(),
    documents: () => docs,
    source: source(),
  })
  render(
    <RecentLane
      documents={docs}
      recentIds={[LINKER]}
      onSelect={() => {}}
      onOpen={() => {}}
      renderThumbnail={(entry) => (
        <DocumentThumbnail document={entry} loadRender={load} className="size-full" />
      )}
    />,
  )
  await linkInkIn('[data-testid="document-thumbnail"]')
  const picture = document.querySelector('[data-testid="document-thumbnail"]') as HTMLElement
  const card = screen.getByRole('button', { name: /linker/i })

  // No anchor and no tabindex at all — an audit reports a focusable link in
  // an aria-hidden picture whether or not the browser honours `inert` — and
  // a Tab from the card does not land inside the picture either.
  expect(picture.querySelectorAll('a, [tabindex]')).toHaveLength(0)
  card.focus()
  await userEvent.tab()
  expect(picture.contains(document.activeElement)).toBe(false)
})
