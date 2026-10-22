import type { LoadedReference } from '@kamiazya/whiteboard-canvas-render'
import type { WorkspaceId } from '@kamiazya/whiteboard-model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLogSink } from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { loadReferenceGraph } from './reference-graph.js'
import { createReferencedDocumentLoader } from './resolve-file-references.js'

const load = vi.fn<(target: string) => Promise<LoadedReference | null>>()
vi.mock('./resolve-file-references.js', () => ({ createReferencedDocumentLoader: vi.fn() }))
vi.mocked(createReferencedDocumentLoader).mockReturnValue(load)
const deps = {} as ServerDeps
const workspaceId = 'ws' as WorkspaceId

afterEach(() => {
  load.mockReset()
  setLogSink(() => {})
})

describe('loadReferenceGraph', () => {
  it('asks the store for documents only, transitively', async () => {
    const bodies: Record<string, string> = { a: '![[b]] ![[asset:inner]]', b: 'leaf' }
    load.mockImplementation(async (target): Promise<LoadedReference | null> => {
      const body = bodies[target]
      return body === undefined ? null : { documentId: target, body }
    })
    const { graph } = await loadReferenceGraph(deps, workspaceId, {
      bodies: ['![[asset:pic]] ![[a]]'],
    })
    expect([...graph.keys()]).toEqual(['a', 'b'])
    expect(load.mock.calls.map(([target]) => target)).toEqual(['a', 'b'])
  })

  it('draws a reference whose read failed as unresolved, and says so', async () => {
    const records: { msg: string; data?: Record<string, unknown> }[] = []
    setLogSink((record) => records.push(record))
    load.mockImplementation(async (target) => {
      if (target === 'bad') throw new Error('index unavailable')
      return { documentId: target, body: '' }
    })
    const { graph, seams } = await loadReferenceGraph(deps, workspaceId, {
      bodies: ['[[bad]] [[good]]'],
    })
    expect(graph.get('bad')).toBeNull()
    expect(graph.get('good')).toEqual({ documentId: 'good', body: '' })
    expect(seams.resolveAlias('good')).toBe('good')
    expect(records).toEqual([
      expect.objectContaining({
        msg: 'reference did not load; rendering it unresolved',
        data: expect.objectContaining({ workspaceId, target: 'bad' }),
      }),
    ])
  })
})
