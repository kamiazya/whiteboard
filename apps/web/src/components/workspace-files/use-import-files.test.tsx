import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ImportedDocument } from '../../lib/document-import.js'
import { useImportFiles } from './use-import-files.js'

function setup(
  overrides: { importDocument?: (path: string, d: ImportedDocument) => Promise<void> } = {},
) {
  const importDocument = vi.fn(overrides.importDocument ?? (async () => {}))
  const refreshAndSelect = vi.fn(async (path: string) => ({ path, documentId: `id-${path}` }))
  const openPath = vi.fn()
  const hook = renderHook(() =>
    useImportFiles({
      source: { importDocument },
      folder: 'design',
      documents: [{ path: 'design/trip' }],
      refreshAndSelect: refreshAndSelect as never,
      openPath: openPath as never,
    }),
  )
  return { hook, importDocument, refreshAndSelect, openPath }
}

const note = (name: string, text: string) => new File([text], name, { type: 'text/markdown' })

describe('useImportFiles', () => {
  it('imports one file into the open folder past a taken name, then opens it', async () => {
    const { hook, importDocument, openPath } = setup()
    await act(async () => {
      await hook.result.current.importFiles?.([
        note('trip.md', '---\ntype: note\ntitle: Trip\n---\nbody'),
      ])
    })
    expect(importDocument).toHaveBeenCalledOnce()
    expect(importDocument.mock.calls[0]?.[0]).toBe('design/trip-2')
    expect(importDocument.mock.calls[0]?.[1]).toMatchObject({
      kind: 'markdown',
      name: 'Trip',
      body: 'body',
    })
    expect(openPath).toHaveBeenCalledWith('design/trip-2', expect.anything())
    expect(hook.result.current.report).toMatchObject({ tone: 'info' })
  })

  it('does not open anything when several files came in, but selects the last', async () => {
    const { hook, openPath, refreshAndSelect } = setup()
    await act(async () => {
      await hook.result.current.importFiles?.([note('a.md', 'a'), note('b.md', 'b')])
    })
    expect(openPath).not.toHaveBeenCalled()
    expect(refreshAndSelect).toHaveBeenCalledWith('design/b')
  })

  it('names a refused file and what is accepted, and writes nothing for it', async () => {
    const { hook, importDocument } = setup()
    await act(async () => {
      await hook.result.current.importFiles?.([new File(['x'], 'photo.png')])
    })
    expect(importDocument).not.toHaveBeenCalled()
    const report = hook.result.current.report
    expect(report?.tone).toBe('error')
    expect(report?.messages.join(' ')).toMatch(/photo\.png.*\.md.*\.canvas/)
  })

  it('reports the keeper refusal for a file and still imports the others', async () => {
    const { hook, importDocument } = setup({
      importDocument: async (path) => {
        if (path.endsWith('/a')) throw new Error('markdown is too long')
      },
    })
    await act(async () => {
      await hook.result.current.importFiles?.([note('a.md', 'a'), note('b.md', 'b')])
    })
    expect(importDocument).toHaveBeenCalledTimes(2)
    expect(hook.result.current.report?.tone).toBe('error')
    expect(hook.result.current.report?.messages.join(' ')).toContain('markdown is too long')
  })

  it('is absent when the keeper cannot write a file', () => {
    const hook = renderHook(() =>
      useImportFiles({
        source: {},
        folder: '',
        documents: [],
        refreshAndSelect: vi.fn() as never,
        openPath: vi.fn() as never,
      }),
    )
    expect(hook.result.current.importFiles).toBeUndefined()
  })
})
