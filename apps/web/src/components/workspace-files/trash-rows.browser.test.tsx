import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import { TrashSection } from './TrashSection.js'

// Real browser: the subject is where each row's Restore lands.

afterEach(cleanup)

describe('trash rows', () => {
  it('line their Restore buttons up in one column', async () => {
    render(
      <div style={{ width: 600 }}>
        <TrashSection
          listTrash={async () => [
            { documentId: 'a', path: 'org/untitled-11', name: 'Org chart', deletedAt: 1_700_000 },
            { documentId: 'b', path: 'x', name: 'A much longer name for a plan', deletedAt: 1 },
            { documentId: 'c', path: 'y', deletedAt: 2 },
          ]}
          restoreFromTrash={vi.fn(async () => undefined)}
          onRestored={() => {}}
        />
      </div>,
    )
    await userEvent.click(await screen.findByText('Trash (3)'))
    const lefts = screen
      .getAllByRole('button', { name: 'Restore' })
      .map((each) => Math.round(each.getBoundingClientRect().left))
    expect(lefts).toHaveLength(3)
    expect(new Set(lefts).size).toBe(1)
  })
})
