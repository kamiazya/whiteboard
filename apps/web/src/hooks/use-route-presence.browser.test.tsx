/**
 * Where focus lands when a document opens, in a real browser: the page's
 * parts arrive at different times (the header after the editor, the canvas
 * surface after its lazy chunk), and a focus attempted before its target
 * exists left focus on <body>.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { noteListDeparture, settleListDeparture } from '../lib/list-departure.js'
import { announceRoute } from '../lib/route-announcer.js'
import { useDocumentRoutePresence, useListRoutePresence } from './use-route-presence.js'

afterEach(() => {
  cleanup()
  announceRoute('')
})

const BOARD: SpatialCanvas = {
  nodes: [
    {
      id: 'n1',
      x: 0,
      y: 0,
      width: 120,
      height: 60,
      resource: { mimeType: 'text/markdown', content: 'Hello' },
    },
  ],
  edges: [],
}

function Page({
  kind,
  heading = true,
  surface = true,
  hydrating = false,
}: {
  kind: 'markdown' | 'spatial'
  heading?: boolean
  surface?: boolean
  hydrating?: boolean
}) {
  const headingRef = useDocumentRoutePresence(
    {
      scopeKey: 'doc-1',
      srTitle: 'Plan',
      // The browser keeper's page always offers its editor autofocus; the
      // editor takes it only for an empty body.
      markdown: { autoFocus: true, hydrating, body: hydrating ? null : 'Some text' },
      sync: { loaded: true, canvas: BOARD },
    },
    kind,
  )
  return (
    <main>
      {heading && (
        <h1 ref={headingRef} tabIndex={-1}>
          Plan
        </h1>
      )}
      {surface && kind === 'spatial' && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: stands in for the canvas surface
        <div role="application" aria-label="Canvas" tabIndex={0} />
      )}
    </main>
  )
}

describe('focus when a document opens', () => {
  it('puts a canvas with content on its surface', () => {
    render(<Page kind="spatial" />)
    expect(document.activeElement).toBe(screen.getByRole('application'))
  })

  it('puts a canvas on its surface when the surface mounts after arrival', () => {
    const { rerender } = render(<Page kind="spatial" surface={false} />)
    rerender(<Page kind="spatial" />)
    expect(document.activeElement).toBe(screen.getByRole('application'))
  })

  it('puts a note on its heading when the heading mounts after arrival', () => {
    const { rerender } = render(<Page kind="markdown" heading={false} />)
    expect(document.activeElement).toBe(document.body)
    rerender(<Page kind="markdown" />)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('puts a note on its heading once its body arrives after arrival', () => {
    const { rerender } = render(<Page kind="markdown" hydrating />)
    expect(document.activeElement).toBe(document.body)
    rerender(<Page kind="markdown" />)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('leaves focus where the person moved it before the canvas mounted', () => {
    const { rerender } = render(
      <>
        <button type="button">Elsewhere</button>
        <Page kind="spatial" surface={false} />
      </>,
    )
    screen.getByRole('button', { name: 'Elsewhere' }).focus()
    rerender(
      <>
        <button type="button">Elsewhere</button>
        <Page kind="spatial" />
      </>,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Elsewhere' }))
  })
})

function ListPage() {
  const headingRef = useListRoutePresence()
  return (
    <main>
      <h1 ref={headingRef} tabIndex={-1}>
        Documents
      </h1>
      <button type="button" data-recent-path="plan">
        Plan (recent)
      </button>
      <button type="button" data-doc-path="plan">
        Plan (card)
      </button>
    </main>
  )
}

describe('focus when Back returns to the list', () => {
  afterEach(() => settleListDeparture('plan'))

  it('goes to the Recent tile a document was opened from', () => {
    noteListDeparture('plan', 'recent')
    render(<ListPage />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Plan (recent)' }))
  })

  it('goes to the card when the document was opened from the grid', () => {
    noteListDeparture('plan')
    render(<ListPage />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Plan (card)' }))
  })
})
