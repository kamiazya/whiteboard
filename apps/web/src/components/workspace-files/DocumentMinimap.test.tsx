import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentMinimap } from './DocumentMinimap.js'

afterEach(cleanup)

const doc = { documentId: 'c1', path: 'a/b', name: 'Diagram', kind: 'spatial' as const }
const rects = [
  { x: 0, y: 0, w: 200, h: 120, color: '#909090' },
  { x: 240, y: 0, w: 160, h: 90, color: '#909090' },
]

function installObserver() {
  const instances: { fire: () => void }[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        instances.push({ fire: () => cb([{ isIntersecting: true }]) })
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  return instances
}

describe('DocumentMinimap', () => {
  // The whole reason for the visibility gate: a tree lists more rows than
  // fit, and each miniature costs a fetch of that document's bytes.
  it('does not read a document nobody has scrolled to', () => {
    installObserver()
    const loadOutline = vi.fn(async () => rects)
    render(<DocumentMinimap document={doc} loadOutline={loadOutline} />)
    expect(loadOutline).not.toHaveBeenCalled()
  })

  it('draws the document’s shape once the row is seen', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap document={doc} loadOutline={async () => rects} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelectorAll('span').length).toBe(rects.length),
    )
  })

  // A miniature is a convenience. A document that cannot be read, or has
  // nothing in it, keeps the icon that says what kind it is.
  it('keeps the kind icon when the shape cannot be read', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap document={doc} loadOutline={async () => null} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelector('[data-kind]')).not.toBeNull(),
    )
  })

  it('keeps the kind icon when the read fails outright', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap
        document={doc}
        loadOutline={async () => {
          throw new Error('offline')
        }}
      />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelector('[data-kind]')).not.toBeNull(),
    )
  })

  it('keeps the kind icon for an empty document rather than an empty box', async () => {
    const observers = installObserver()
    const { getByTestId } = render(<DocumentMinimap document={doc} loadOutline={async () => []} />)
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelector('[data-kind]')).not.toBeNull(),
    )
  })

  it('is hidden from assistive technology — the row’s name already says which document it is', () => {
    installObserver()
    const { getByTestId } = render(
      <DocumentMinimap document={doc} loadOutline={async () => rects} />,
    )
    expect(getByTestId('document-minimap').getAttribute('aria-hidden')).toBe('true')
  })
})
