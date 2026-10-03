import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkspaceFilesSource } from '../lib/files-source.js'
import { useStencilRegistry } from './use-stencil-library.js'

const lakehouse = { lakehouse: { displayName: 'Lakehouse', color: '3' } }
const sourceOf = (read?: WorkspaceFilesSource['readStencilLibrary']) =>
  (read === undefined ? {} : { readStencilLibrary: read }) as WorkspaceFilesSource

describe('useStencilRegistry', () => {
  it('composes the library the keeper declares onto the deployment registry', async () => {
    const source = sourceOf(() => Promise.resolve(lakehouse))
    const { result } = renderHook(() => useStencilRegistry(source))
    await waitFor(() =>
      expect(result.current.assetIds('stencils')).toContain('workspace.lakehouse'),
    )
    expect(result.current.assetIds('stencils')).toContain('visual.datastore')
  })

  it('stays the bundled registry for a source that cannot say, one that declares nothing, and no source', async () => {
    const silent = sourceOf()
    const empty = sourceOf(() => Promise.resolve({}))
    for (const source of [silent, empty, null]) {
      const { result } = renderHook(() => useStencilRegistry(source))
      await Promise.resolve()
      expect(result.current).toBe(bundledFacetRegistry)
    }
  })

  it('falls back to the bundled registry when the read fails', async () => {
    const source = sourceOf(() => Promise.reject(new Error('down')))
    const { result } = renderHook(() => useStencilRegistry(source))
    await Promise.resolve()
    expect(result.current).toBe(bundledFacetRegistry)
  })
})
