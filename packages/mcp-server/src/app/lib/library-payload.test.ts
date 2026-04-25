import { describe, it, expect } from 'vitest'
import { normalizeLibraryPayload } from './library-payload.js'

describe('normalizeLibraryPayload', () => {
  it('v1 library items use stable ids across repeated imports', () => {
    const payload = {
      type: 'excalidrawlib',
      version: 1,
      library: [
        [{ id: 'rect-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }],
        [{ id: 'text-1', type: 'text', x: 10, y: 10, text: 'hello', fontSize: 16 }],
      ],
    }

    const first = normalizeLibraryPayload(payload) as Array<{ id: string }>
    const second = normalizeLibraryPayload(payload) as Array<{ id: string }>

    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id))
  })

  it('v1 library items derive different ids for different element payloads', () => {
    const a = normalizeLibraryPayload({
      type: 'excalidrawlib',
      version: 1,
      library: [[{ id: 'rect-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }]],
    }) as Array<{ id: string }>
    const b = normalizeLibraryPayload({
      type: 'excalidrawlib',
      version: 1,
      library: [[{ id: 'rect-2', type: 'rectangle', x: 50, y: 50, width: 100, height: 100 }]],
    }) as Array<{ id: string }>

    expect(a[0]?.id).not.toBe(b[0]?.id)
  })
})
