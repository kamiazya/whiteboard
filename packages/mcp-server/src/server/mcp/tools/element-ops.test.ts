import { LoroDoc, LoroMap } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyAssignToGroup,
  applyClear,
  applyDelete,
  applyDeleteGroup,
  applyDeleteMany,
  applyMove,
  applyReorder,
  applyUpdate,
  listElementsInGroup,
  listGroups,
} from './element-ops.js'
function seedElement(
  doc: LoroDoc,
  id: string,
  fields: Record<string, unknown> = { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
): void {
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(list.length, new LoroMap())
  map.set('id', id)
  for (const [k, v] of Object.entries(fields)) {
    map.set(k, v as never)
  }
}

function readElement(doc: LoroDoc, id: string): Record<string, unknown> | undefined {
  const list = doc.getMovableList('elements')
  const all = list.toJSON() as Array<Record<string, unknown>>
  return all.find((e) => e.id === id)
}

describe('applyUpdate', () => {
  let doc: LoroDoc
  beforeEach(() => {
    doc = new LoroDoc()
    seedElement(doc, 'r1', { type: 'rectangle', x: 10, y: 20, width: 100, height: 50, strokeColor: '#000' })
  })

  it('case 162', () => {
    applyUpdate(doc, 'r1', { x: 200 })
    expect(readElement(doc, 'r1')).toMatchObject({ x: 200, y: 20, width: 100 })
  })

  it('case 163', () => {
    applyUpdate(doc, 'r1', { x: 50, y: 60, strokeColor: '#ff0000' })
    const el = readElement(doc, 'r1')
    expect(el).toMatchObject({ x: 50, y: 60, strokeColor: '#ff0000', width: 100 })
  })

  it('case 164', () => {
    applyUpdate(doc, 'r1', { strokeColor: '#0000ff' })
    expect(readElement(doc, 'r1')).toMatchObject({
      x: 10, y: 20, width: 100, height: 50, strokeColor: '#0000ff',
    })
  })

  it('case 165', () => {
    expect(() => applyUpdate(doc, 'nonexistent', { x: 0 })).toThrow(/not found/)
  })

  it('case 166', () => {
    expect(() => applyUpdate(doc, 'r1', {})).not.toThrow()
    expect(readElement(doc, 'r1')).toMatchObject({ x: 10, y: 20 })
  })
})

describe('applyDelete', () => {
  let doc: LoroDoc
  beforeEach(() => {
    doc = new LoroDoc()
    seedElement(doc, 'r1')
  })

  it('case 167', () => {
    applyDelete(doc, 'r1')
    const el = readElement(doc, 'r1')
    expect(el?.isDeleted).toBe(true)
  })

  it('case 168', () => {
    const before = doc.getMovableList('elements').length
    applyDelete(doc, 'r1')
    expect(doc.getMovableList('elements').length).toBe(before)
  })

  it('case 169', () => {
    expect(() => applyDelete(doc, 'nonexistent')).toThrow(/not found/)
  })
})

describe('applyDeleteMany', () => {
  let doc: LoroDoc
  beforeEach(() => {
    doc = new LoroDoc()
    seedElement(doc, 'a')
    seedElement(doc, 'b')
    seedElement(doc, 'c')
  })

  it('case 170', () => {
    applyDeleteMany(doc, ['a', 'c'])
    expect(readElement(doc, 'a')?.isDeleted).toBe(true)
    expect(readElement(doc, 'b')?.isDeleted).not.toBe(true)
    expect(readElement(doc, 'c')?.isDeleted).toBe(true)
  })

  it('case 171', () => {
    const result = applyDeleteMany(doc, ['b', 'a'])
    expect(result.sort()).toEqual(['a', 'b'])
  })

  it('case 172', () => {
    expect(() => applyDeleteMany(doc, ['a', 'ghost', 'b'])).toThrow(/not found/)
    expect(readElement(doc, 'a')?.isDeleted).not.toBe(true)
    expect(readElement(doc, 'b')?.isDeleted).not.toBe(true)
  })

  it('case 173', () => {
    applyDelete(doc, 'a')
    expect(() => applyDeleteMany(doc, ['a', 'b'])).not.toThrow()
    expect(readElement(doc, 'a')?.isDeleted).toBe(true)
    expect(readElement(doc, 'b')?.isDeleted).toBe(true)
  })

  it('case 174', () => {
    expect(applyDeleteMany(doc, [])).toEqual([])
    expect(readElement(doc, 'a')?.isDeleted).not.toBe(true)
  })

  it('case 175', () => {
    const result = applyDeleteMany(doc, ['a', 'a', 'b'])
    expect(result.sort()).toEqual(['a', 'b'])
    expect(readElement(doc, 'a')?.isDeleted).toBe(true)
  })
})

describe('applyMove', () => {
  let doc: LoroDoc
  beforeEach(() => {
    doc = new LoroDoc()
    seedElement(doc, 'a', { type: 'rectangle', x: 10, y: 20, width: 100, height: 50 })
    seedElement(doc, 'b', { type: 'rectangle', x: 100, y: 200, width: 100, height: 50 })
  })

  it('case 176', () => {
    applyMove(doc, ['a'], 5, 10)
    expect(readElement(doc, 'a')).toMatchObject({ x: 15, y: 30 })
  })

  it('case 177', () => {
    applyMove(doc, ['a', 'b'], -5, 10)
    expect(readElement(doc, 'a')).toMatchObject({ x: 5, y: 30 })
    expect(readElement(doc, 'b')).toMatchObject({ x: 95, y: 210 })
  })

  it('case 178', () => {
    applyMove(doc, ['a'], 0, 0)
    expect(readElement(doc, 'a')).toMatchObject({ x: 10, y: 20 })
  })

  it('case 179', () => {
    applyMove(doc, ['a'], -10, -20)
    expect(readElement(doc, 'a')).toMatchObject({ x: 0, y: 0 })
  })

  it('case 180', () => {
    applyMove(doc, [], 100, 100)
    expect(readElement(doc, 'a')).toMatchObject({ x: 10, y: 20 })
    expect(readElement(doc, 'b')).toMatchObject({ x: 100, y: 200 })
  })

  it('case 181', () => {
    expect(() => applyMove(doc, ['a', 'missing'], 5, 5)).toThrow(/not found/)
    expect(readElement(doc, 'a')).toMatchObject({ x: 10, y: 20 })
  })

  it('case 182', () => {
    seedElement(doc, 'label', {
      type: 'text',
      x: 200,
      y: 100,
      width: 120,
      height: 24,
      boundElements: [{ id: 'arrow-1', type: 'arrow' }],
    })
    seedElement(doc, 'arrow-1', {
      type: 'arrow',
      x: 0,
      y: 112,
      points: [
        [0, 0],
        [200, 0],
      ],
      width: 200,
      height: 0,
      endBoxId: 'label',
    })

    applyMove(doc, ['label'], 40, 10)

    expect(readElement(doc, 'label')).toMatchObject({ x: 240, y: 110 })
    expect(readElement(doc, 'arrow-1')).toMatchObject({
      x: 0,
      y: 112,
      width: 240,
      height: 8,
    })
  })
})

describe('applyClear', () => {
  it('case 183', () => {
    const doc = new LoroDoc()
    seedElement(doc, 'a')
    seedElement(doc, 'b')
    seedElement(doc, 'c')

    const cleared = applyClear(doc)

    expect(cleared).toBe(3)
    expect(readElement(doc, 'a')?.isDeleted).toBe(true)
    expect(readElement(doc, 'b')?.isDeleted).toBe(true)
    expect(readElement(doc, 'c')?.isDeleted).toBe(true)
  })

  it('case 184', () => {
    const doc = new LoroDoc()
    seedElement(doc, 'a')
    seedElement(doc, 'b')
    const before = doc.getMovableList('elements').length
    applyClear(doc)
    expect(doc.getMovableList('elements').length).toBe(before)
  })

  it('case 185', () => {
    const doc = new LoroDoc()
    seedElement(doc, 'a')
    seedElement(doc, 'b', { type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true })
    const cleared = applyClear(doc)
    expect(cleared).toBe(1)
    expect(readElement(doc, 'a')?.isDeleted).toBe(true)
    expect(readElement(doc, 'b')?.isDeleted).toBe(true)
  })

  it('case 186', () => {
    const doc = new LoroDoc()
    expect(applyClear(doc)).toBe(0)
  })

  it('case 187', () => {
    const doc = new LoroDoc()
    seedElement(doc, 'a')
    expect(applyClear(doc)).toBe(1)
    expect(applyClear(doc)).toBe(0)
  })
})

describe('applyReorder', () => {
  let doc: LoroDoc
  beforeEach(() => {
    doc = new LoroDoc()
    seedElement(doc, 'a')
    seedElement(doc, 'b')
    seedElement(doc, 'c')
    seedElement(doc, 'd')
  })

  const idsInOrder = (): string[] => {
    const list = doc.getMovableList('elements')
    const out: string[] = []
    for (let i = 0; i < list.length; i++) {
      const item = list.get(i) as LoroMap
      out.push(item.get('id') as string)
    }
    return out
  }

  it('case 188', () => {
    applyReorder(doc, ['b', 'd'], 'front')
    expect(idsInOrder()).toEqual(['a', 'c', 'b', 'd'])
  })

  it('case 189', () => {
    applyReorder(doc, ['b', 'c'], 'back')
    expect(idsInOrder()).toEqual(['b', 'c', 'a', 'd'])
  })

  it('case 190', () => {
    applyReorder(doc, ['d'], 'front')
    expect(idsInOrder()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('case 191', () => {
    expect(() => applyReorder(doc, ['b', 'nonexistent'], 'front')).toThrow(/not found/)
    expect(idsInOrder()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('case 192', () => {
    applyReorder(doc, [], 'front')
    expect(idsInOrder()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('group ops (logical grouping for bulk delete)', () => {
  let doc: LoroDoc
  beforeEach(() => {
    doc = new LoroDoc()
    seedElement(doc, 'a')
    seedElement(doc, 'b')
    seedElement(doc, 'c')
  })

  describe('applyAssignToGroup', () => {
    it('case 193', () => {
      applyAssignToGroup(doc, 'sec-11', ['a', 'b'])
      expect(readElement(doc, 'a')?.groupIds).toEqual(['sec-11'])
      expect(readElement(doc, 'b')?.groupIds).toEqual(['sec-11'])
      expect(readElement(doc, 'c')?.groupIds).toBeUndefined()
    })

    it('case 194', () => {
      applyAssignToGroup(doc, 'sec-11', ['a'])
      applyAssignToGroup(doc, 'sec-11-before', ['a'])
      expect(readElement(doc, 'a')?.groupIds).toEqual(['sec-11', 'sec-11-before'])
    })

    it('case 195', () => {
      applyAssignToGroup(doc, 'sec-11', ['a'])
      applyAssignToGroup(doc, 'sec-11', ['a', 'b'])
      expect(readElement(doc, 'a')?.groupIds).toEqual(['sec-11'])
      expect(readElement(doc, 'b')?.groupIds).toEqual(['sec-11'])
    })

    it('case 196', () => {
      expect(() => applyAssignToGroup(doc, 'sec-11', ['a', 'ghost'])).toThrow(/not found/)
      expect(readElement(doc, 'a')?.groupIds).toBeUndefined()
    })
  })

  describe('listElementsInGroup / listGroups', () => {
    it('case 197', () => {
      applyAssignToGroup(doc, 'sec-11', ['a', 'b'])
      expect(listElementsInGroup(doc, 'sec-11').sort()).toEqual(['a', 'b'])
      expect(listElementsInGroup(doc, 'sec-99')).toEqual([])
    })

    it('case 198', () => {
      applyAssignToGroup(doc, 'sec-11', ['a', 'b'])
      applyAssignToGroup(doc, 'sec-12', ['b', 'c'])
      const groups = listGroups(doc)
      const map = new Map(groups.map((g) => [g.groupId, g.memberIds.sort()]))
      expect(map.get('sec-11')).toEqual(['a', 'b'])
      expect(map.get('sec-12')).toEqual(['b', 'c'])
    })

    it('case 199', () => {
      applyAssignToGroup(doc, 'sec-11', ['a', 'b'])
      applyDelete(doc, 'a')
      expect(listElementsInGroup(doc, 'sec-11')).toEqual(['b'])
      const g = listGroups(doc).find((x) => x.groupId === 'sec-11')
      expect(g?.memberIds).toEqual(['b'])
    })
  })

  describe('applyDeleteGroup', () => {
    it('case 200', () => {
      applyAssignToGroup(doc, 'sec-11', ['a', 'b'])
      const deleted = applyDeleteGroup(doc, 'sec-11')
      expect(deleted.sort()).toEqual(['a', 'b'])
      expect(readElement(doc, 'a')?.isDeleted).toBe(true)
      expect(readElement(doc, 'b')?.isDeleted).toBe(true)
      expect(readElement(doc, 'c')?.isDeleted).not.toBe(true)
    })

    it('case 201', () => {
      expect(applyDeleteGroup(doc, 'no-such-group')).toEqual([])
    })

    it('case 202', () => {
      applyAssignToGroup(doc, 'sec-11', ['a', 'b'])
      applyAssignToGroup(doc, 'sec-12', ['b', 'c'])
      const deleted = applyDeleteGroup(doc, 'sec-11')
      expect(deleted.sort()).toEqual(['a', 'b']) // b is also deleted as a member of sec-11
      expect(readElement(doc, 'c')?.isDeleted).not.toBe(true)
    })

    it('case 203', () => {
      applyAssignToGroup(doc, 'sec-11', ['a', 'b'])
      applyDelete(doc, 'a')
      const deleted = applyDeleteGroup(doc, 'sec-11')
      expect(deleted).toEqual(['b']) // a was already tombstoned, so it is skipped
    })
  })
})
