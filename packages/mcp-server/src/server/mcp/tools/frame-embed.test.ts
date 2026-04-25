import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LoroDoc, LoroMap } from 'loro-crdt'
import {
  createEmbedTool,
  createFrameTool,
  updateFrameMembersTool,
} from './frame-embed.js'

const client = {
  port: 9999,
  baseUrl: 'http://localhost:9999',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:9999'), init),
  touch: async () => undefined,
}

interface SnapshotState {
  doc: LoroDoc
}

function installFetchMock(state: SnapshotState) {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = url.toString()
    if (u.endsWith('/palette')) {
      return new Response(JSON.stringify({ palette: {} }), { status: 200 })
    }
    if (u.endsWith('/snapshot')) {
      return new Response(state.doc.export({ mode: 'snapshot' }), { status: 200 })
    }
    if (u.endsWith('/update') && init?.method === 'POST') {
      const bytes = new Uint8Array(init.body as ArrayBuffer)
      state.doc.import(bytes)
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch: ${u}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  return { restore: () => (globalThis.fetch = originalFetch), fetchMock }
}

describe('create_frame', () => {
  let state: SnapshotState
  let restore: () => void

  beforeEach(() => {
    state = { doc: new LoroDoc() }
    restore = installFetchMock(state).restore
  })

  afterEach(() => {
    restore()
  })

  it('case 1', async () => {
    const tool = createFrameTool()
    const res = await tool.execute(
      { canvasId: 'sid/slug', x: 10, y: 20, width: 300, height: 200, name: 'Section A' },
      client,
    )
    expect(res.bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(res.assignedMembers).toEqual([])

    const elements = state.doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    expect(elements).toHaveLength(1)
    expect(elements[0].type).toBe('frame')
    expect(elements[0].name).toBe('Section A')
    expect(elements[0].id).toBe(res.elementId)
  })

  it('case 2', async () => {
    const list = state.doc.getMovableList('elements')
    const a = list.insertContainer(0, new LoroMap())
    a.set('id', 'el-a')
    a.set('type', 'rectangle')
    a.set('x', 100); a.set('y', 100); a.set('width', 100); a.set('height', 50)
    a.set('frameId', null); a.set('isDeleted', false)
    const b = list.insertContainer(1, new LoroMap())
    b.set('id', 'el-b')
    b.set('type', 'rectangle')
    b.set('x', 300); b.set('y', 200); b.set('width', 80); b.set('height', 40)
    b.set('frameId', null); b.set('isDeleted', false)
    state.doc.commit()

    const tool = createFrameTool()
    const res = await tool.execute(
      { canvasId: 'sid/slug', memberIds: ['el-a', 'el-b'], padding: 10 },
      client,
    )
    expect(res.bounds).toEqual({ x: 90, y: 90, width: 300, height: 160 })
    expect(res.assignedMembers.sort()).toEqual(['el-a', 'el-b'])

    const elements = state.doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    expect(elements.find((e) => e.id === 'el-a')?.frameId).toBe(res.elementId)
    expect(elements.find((e) => e.id === 'el-b')?.frameId).toBe(res.elementId)
    expect(elements.find((e) => e.id === res.elementId)?.type).toBe('frame')
  })
})

describe('create_embed', () => {
  let state: SnapshotState
  let restore: () => void

  beforeEach(() => {
    state = { doc: new LoroDoc() }
    restore = installFetchMock(state).restore
  })

  afterEach(() => {
    restore()
  })

  it('case 3', async () => {
    const tool = createEmbedTool()
    await expect(
      tool.execute({ canvasId: 'sid/slug', url: 'javascript:alert(1)' }, client),
    ).rejects.toThrow(/must start with http/)
    await expect(
      tool.execute({ canvasId: 'sid/slug', url: 'ftp://x.example' }, client),
    ).rejects.toThrow(/must start with http/)
  })

  it('case 4', async () => {
    const tool = createEmbedTool()
    const res = await tool.execute(
      { canvasId: 'sid/slug', url: 'https://youtu.be/dQw4w9WgXcQ', x: 50, y: 60 },
      client,
    )
    expect(res.url).toBe('https://youtu.be/dQw4w9WgXcQ')

    const elements = state.doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    expect(elements).toHaveLength(1)
    expect(elements[0].type).toBe('embeddable')
    expect(elements[0].link).toBe('https://youtu.be/dQw4w9WgXcQ')
    expect(elements[0].x).toBe(50)
    expect(elements[0].y).toBe(60)
    expect(elements[0].width).toBe(640)
    expect(elements[0].height).toBe(400)
  })
})

describe('update_frame_members', () => {
  let state: SnapshotState
  let restore: () => void
  const seedFrame = (id: string, x: number, y: number, w: number, h: number): void => {
    const list = state.doc.getMovableList('elements')
    const m = list.insertContainer(list.length, new LoroMap())
    m.set('id', id)
    m.set('type', 'frame')
    m.set('x', x); m.set('y', y); m.set('width', w); m.set('height', h)
    m.set('isDeleted', false)
  }
  const seedEl = (id: string, x: number, y: number, w: number, h: number, frameId: string | null = null): void => {
    const list = state.doc.getMovableList('elements')
    const m = list.insertContainer(list.length, new LoroMap())
    m.set('id', id)
    m.set('type', 'rectangle')
    m.set('x', x); m.set('y', y); m.set('width', w); m.set('height', h)
    m.set('isDeleted', false)
    m.set('frameId', frameId)
  }
  const readEl = (id: string): Record<string, unknown> | undefined => {
    const snap = state.doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
    return snap.find((e) => e.id === id)
  }

  beforeEach(() => {
    state = { doc: new LoroDoc() }
    const r = installFetchMock(state)
    restore = r.restore
  })
  afterEach(() => restore())

  it('case 5', async () => {
    seedFrame('F', 0, 0, 100, 100)
    seedEl('a', 200, 100, 50, 50)
    seedEl('b', 260, 100, 50, 50)
    state.doc.commit()

    const tool = updateFrameMembersTool()
    await tool.execute(
      { canvasId: 'sess/canvas', frameId: 'F', add: ['a', 'b'] },
      client,
    )

    expect(readEl('a')?.frameId).toBe('F')
    expect(readEl('b')?.frameId).toBe('F')
  })

  it('case 6', async () => {
    seedFrame('F', 0, 0, 100, 100)
    seedEl('a', 200, 100, 50, 50, 'F') // Already belongs to F
    seedEl('b', 260, 200, 40, 30)      // Will be added now
    state.doc.commit()

    const tool = updateFrameMembersTool()
    await tool.execute(
      { canvasId: 'sess/canvas', frameId: 'F', add: ['b'], padding: 10 },
      client,
    )

    const f = readEl('F')
    expect(f?.x).toBe(200 - 10)
    expect(f?.y).toBe(100 - 10)
    expect(f?.width).toBe(100 + 20) // (300-200) + pad*2
    expect(f?.height).toBe(130 + 20)
  })

  it('case 7', async () => {
    seedFrame('F', 0, 0, 500, 500)
    seedEl('a', 100, 100, 50, 50, 'F')
    seedEl('b', 200, 100, 50, 50, 'F')
    state.doc.commit()

    const tool = updateFrameMembersTool()
    await tool.execute(
      { canvasId: 'sess/canvas', frameId: 'F', remove: ['a'] },
      client,
    )

    expect(readEl('a')?.frameId).toBeNull()
    expect(readEl('b')?.frameId).toBe('F')
  })

  it('case 8', async () => {
    seedFrame('F', 0, 0, 500, 500)
    seedEl('a', 100, 100, 50, 50, 'F')
    seedEl('b', 600, 600, 50, 50)
    state.doc.commit()

    const tool = updateFrameMembersTool()
    await tool.execute(
      { canvasId: 'sess/canvas', frameId: 'F', add: ['b'], remove: ['a'] },
      client,
    )

    expect(readEl('a')?.frameId).toBeNull()
    expect(readEl('b')?.frameId).toBe('F')
  })

  it('case 9', async () => {
    seedFrame('F', 0, 0, 500, 500)
    seedEl('a', 100, 100, 50, 50, 'F')
    state.doc.commit()

    const tool = updateFrameMembersTool()
    await expect(
      tool.execute({ canvasId: 'sess/canvas', frameId: 'F', add: ['a'] }, client),
    ).resolves.toBeDefined()
    expect(readEl('a')?.frameId).toBe('F')
  })

  it('case 10', async () => {
    seedEl('a', 100, 100, 50, 50)
    state.doc.commit()
    const tool = updateFrameMembersTool()
    await expect(
      tool.execute({ canvasId: 'sess/canvas', frameId: 'ghost', add: ['a'] }, client),
    ).rejects.toThrow(/not found/i)
  })

  it('case 11', async () => {
    seedFrame('F', 0, 0, 500, 500)
    seedEl('a', 100, 100, 50, 50)
    state.doc.commit()
    const tool = updateFrameMembersTool()
    await expect(
      tool.execute(
        { canvasId: 'sess/canvas', frameId: 'F', add: ['a', 'ghost'] },
        client,
      ),
    ).rejects.toThrow(/not found/i)
    expect(readEl('a')?.frameId).toBeNull()
  })

  it('case 12', async () => {
    seedFrame('F', 0, 0, 500, 500)
    seedEl('a', 100, 100, 50, 50, 'F')
    seedEl('b', 200, 200, 50, 50)
    state.doc.commit()
    const tool = updateFrameMembersTool()
    const result = await tool.execute(
      { canvasId: 'sess/canvas', frameId: 'F', add: ['b'], remove: ['a'] },
      client,
    )
    expect(result.frameId).toBe('F')
    expect(result.addedMembers).toEqual(['b'])
    expect(result.removedMembers).toEqual(['a'])
    expect(result.bounds).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    })
  })

  it('case 13', async () => {
    seedFrame('F', 0, 0, 500, 500)
    seedEl('a', 100, 100, 50, 50, 'F')
    state.doc.commit()
    const tool = updateFrameMembersTool()
    const result = await tool.execute(
      { canvasId: 'sess/canvas', frameId: 'F' },
      client,
    )
    expect(result.addedMembers).toEqual([])
    expect(result.removedMembers).toEqual([])
    expect(readEl('a')?.frameId).toBe('F')
  })
})
