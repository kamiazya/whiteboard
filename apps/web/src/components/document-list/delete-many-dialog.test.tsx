// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { DeleteDocumentDialog } from './DeleteDocumentDialog.js'

// The bulk confirmation reuses the single one: same busy pinning, same error
// slot, same buttons. Only the SUBJECT differs — a count instead of a name —
// so a `count` on the pending object is the whole difference.

afterEach(cleanup)

const noop = () => {}

describe('the delete confirmation with a count', () => {
  it('names the count instead of a document, and drops the quotes with it', () => {
    render(
      <DeleteDocumentDialog
        pending={{ displayName: '', count: 3 }}
        busy={false}
        error={null}
        action="delete-documents-browser"
        onCancel={noop}
        onConfirm={noop}
      />,
    )

    expect(screen.getByRole('heading').textContent).toBe('Delete 3 documents?')
  })

  it('promises the trash in the plural, from the declared copy', () => {
    render(
      <DeleteDocumentDialog
        pending={{ displayName: '', count: 2 }}
        busy={false}
        error={null}
        action="delete-documents-browser"
        onCancel={noop}
        onConfirm={noop}
      />,
    )

    expect(
      screen.getByText(DESTRUCTIVE_COPY['delete-documents-browser']('documents'), { exact: false }),
    ).toBeTruthy()
  })

  it('still names the document when there is no count', () => {
    render(
      <DeleteDocumentDialog
        pending={{ displayName: 'Roadmap', kind: 'spatial' }}
        busy={false}
        error={null}
        action="delete-document-browser"
        onCancel={noop}
        onConfirm={noop}
      />,
    )

    expect(screen.getByRole('heading').textContent).toBe('Delete "Roadmap"?')
  })
})
