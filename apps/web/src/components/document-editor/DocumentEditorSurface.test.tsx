/**
 * The kind switch every canvas page routes through. The contract under
 * test: a markdown-kind document NEVER falls through to the spatial slot
 * (the corruption path this component exists to close), and a page cannot
 * mount the surface without deciding what markdown looks like — `markdown`
 * is a required prop, which is the compile-time half of the same guard.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentEditorSurface } from './DocumentEditorSurface.js'

afterEach(cleanup)

describe('DocumentEditorSurface', () => {
  it('renders the spatial slot for a spatial document', () => {
    render(
      <DocumentEditorSurface
        kind="spatial"
        documentKey="doc-1"
        spatial={() => <div data-testid="spatial-slot" />}
        markdown={null}
      />,
    )
    expect(screen.getByTestId('spatial-slot')).toBeTruthy()
  })

  it('renders the markdown editor, not the spatial slot, for a markdown document', () => {
    render(
      <DocumentEditorSurface
        kind="markdown"
        documentKey="doc-1"
        spatial={() => <div data-testid="spatial-slot" />}
        markdown={{ body: '# From the surface', setBody: () => {} }}
      />,
    )
    expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy()
    expect(screen.queryByTestId('spatial-slot')).toBeNull()
  })

  it('renders nothing while a markdown body has not hydrated', () => {
    const { container } = render(
      <DocumentEditorSurface
        kind="markdown"
        documentKey="doc-1"
        spatial={() => <div data-testid="spatial-slot" />}
        markdown={{ body: null, setBody: () => {} }}
      />,
    )
    expect(container.textContent).toBe('')
    expect(screen.queryByTestId('spatial-slot')).toBeNull()
  })
})
