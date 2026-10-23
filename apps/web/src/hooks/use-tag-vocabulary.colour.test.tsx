import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkspaceFilesSource } from '../lib/files-source.js'
import { useTagVocabulary } from './use-tag-vocabulary.js'

function sourceHolding(initial: TagLibrary, writable = true) {
  let held = initial
  const writes: TagLibrary[] = []
  const source = {
    listTagsInUse: () =>
      Promise.resolve([
        {
          tag: 'kind:service',
          key: 'kind',
          value: 'service',
          documents: 0,
          boards: 0,
          nodes: 1,
          edges: 0,
        },
        {
          tag: 'kind:database',
          key: 'kind',
          value: 'database',
          documents: 0,
          boards: 0,
          nodes: 1,
          edges: 0,
        },
      ]),
    readTagLibrary: () => Promise.resolve(held),
    ...(writable
      ? {
          writeTagLibrary: (next: TagLibrary) => {
            writes.push(next)
            held = next
            return Promise.resolve()
          },
        }
      : {}),
  } as unknown as WorkspaceFilesSource
  return { source, writes }
}

describe('useTagVocabulary setTagColour', () => {
  it('writes the library with the colour and then serves the re-read library', async () => {
    const { source, writes } = sourceHolding({})
    const { result } = renderHook(() => useTagVocabulary(source))
    await waitFor(() => expect(result.current?.setTagColour).toBeDefined())
    await act(async () => {
      await result.current?.setTagColour?.('kind:service', '5')
    })
    expect(writes).toEqual([{ kind: { values: { service: { color: '5' }, database: {} } } }])
    expect(result.current?.library).toEqual(writes[0])
  })

  it('offers no writer when the keeper cannot write the library', async () => {
    const { source } = sourceHolding({}, false)
    const { result } = renderHook(() => useTagVocabulary(source))
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.setTagColour).toBeUndefined()
  })

  it('refuses to colour a plain tag', async () => {
    const { source, writes } = sourceHolding({})
    const { result } = renderHook(() => useTagVocabulary(source))
    await waitFor(() => expect(result.current?.setTagColour).toBeDefined())
    await expect(result.current?.setTagColour?.('draft', '5')).rejects.toThrow(/key:value/)
    expect(writes).toEqual([])
  })
})
