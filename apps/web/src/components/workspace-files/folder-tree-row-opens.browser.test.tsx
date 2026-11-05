import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import { WorkspaceFolderTree } from './WorkspaceFolderTree.js'

// Real browser: the subject is WHERE a press lands. A folder's row in the
// sidebar is wider than its name, and a press beside the name used to land on
// the row's empty remainder, which did nothing.

afterEach(cleanup)

const documents = [
  { documentId: 'd1', path: 'ops/rota', name: 'Rota', kind: 'markdown' as const },
  { documentId: 'd2', path: 'ops/team/plan', name: 'Plan', kind: 'markdown' as const },
]

describe('a folder row in the sidebar tree', () => {
  it('opens the folder from anywhere on its row, and only the chevron collapses it', async () => {
    const onSelectFolder = vi.fn()
    render(
      <div style={{ width: 224 }}>
        <WorkspaceFolderTree documents={documents} onSelectFolder={onSelectFolder} />
      </div>,
    )
    const tree = screen.getByRole('tree', { name: 'Workspace folders' })
    const label = within(tree).getByRole('button', { name: 'Open folder ops' })
    const row = label.parentElement as HTMLElement
    const box = row.getBoundingClientRect()
    const name = within(label).getByText('ops').getBoundingClientRect()
    expect(box.right - name.right).toBeGreaterThan(80)

    await userEvent.click(row, { position: { x: box.width - 8, y: box.height / 2 } })
    expect(onSelectFolder).toHaveBeenCalledWith('ops')

    await userEvent.dblClick(label)
    expect(within(tree).getByRole('button', { name: 'Open folder team' })).toBeTruthy()
    await userEvent.click(within(tree).getByRole('button', { name: 'Collapse ops' }))
    expect(within(tree).queryByRole('button', { name: 'Open folder team' })).toBeNull()
  })
})
