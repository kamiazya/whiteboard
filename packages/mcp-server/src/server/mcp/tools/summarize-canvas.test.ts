import { describe, it, expect } from 'vitest'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { summarizeCanvas } from './summarize-canvas.js'
function appendElement(doc: LoroDoc, fields: Record<string, unknown>): void {
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(list.length, new LoroMap())
  for (const [k, v] of Object.entries(fields)) {
    map.set(k, v as any)
  }
}

describe('suite 12', () => {
  it('case 354', () => {
    const doc = new LoroDoc()
    const summary = summarizeCanvas(doc)
    expect(summary.elementCount).toBe(0)
    expect(summary.elements).toEqual([])
  })
})

describe('suite 13', () => {
  it('case 355', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'el-image-1',
      type: 'image',
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      fileId: 'file-abc',
      status: 'loaded',
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elementCount).toBe(1)
    expect(summary.elements[0]).toMatchObject({
      id: 'el-image-1',
      type: 'image',
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      fileId: 'file-abc',
    })
  })

  it('case 356', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'el-text-1',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: 'Hello whiteboard',
      strokeColor: '#1e1e2e',
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]).toMatchObject({
      id: 'el-text-1',
      type: 'text',
      text: 'Hello whiteboard',
      strokeColor: '#1e1e2e',
    })
  })

  it('case 357', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'el-arrow-1',
      type: 'arrow',
      x: 50,
      y: 60,
      width: 120,
      height: 0,
      strokeColor: '#e03131',
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]).toMatchObject({
      id: 'el-arrow-1',
      type: 'arrow',
      strokeColor: '#e03131',
    })
  })
})

describe('suite 14', () => {
  it('case 358', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'el-alive',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })
    appendElement(doc, {
      id: 'el-dead',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      isDeleted: true,
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elementCount).toBe(1)
    expect(summary.elements).toHaveLength(2)
    const dead = summary.elements.find((e) => e.id === 'el-dead')
    expect(dead?.isDeleted).toBe(true)
  })
})

describe('suite 15', () => {
  it('case 359', () => {
    const doc = new LoroDoc()
    appendElement(doc, { id: 'first', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 })
    appendElement(doc, { id: 'second', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 })
    appendElement(doc, { id: 'third', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 })
    const summary = summarizeCanvas(doc)
    expect(summary.elements.map((e) => e.id)).toEqual(['first', 'second', 'third'])
  })
})

describe('suite 17', () => {
  it('includes the frame name so a caller can identify a frame without re-deriving it from geometry', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'frame-1',
      type: 'frame',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      name: 'WAVE 0 Onboarding',
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]!.name).toBe('WAVE 0 Onboarding')
  })

  it('omits name for element types that never set it', () => {
    const doc = new LoroDoc()
    appendElement(doc, { id: 'rect-1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]!.name).toBeUndefined()
  })
})

describe('suite 16', () => {
  const LIMIT = 80

  it('case 360', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'short',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: 'short text',
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]!.text).toBe('short text')
  })

  it('case 361', () => {
    const exact = 'a'.repeat(LIMIT)
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'exact',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: exact,
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]!.text).toBe(exact)
  })

  it('case 362', () => {
    const long = 'a'.repeat(LIMIT + 20)
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'long',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: long,
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]!.text).toBe(`${'a'.repeat(LIMIT)}…`)
  })

  it('case 363', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'multiline',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: 'line 1\nline 2\nline 3',
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]!.text).toBe('line 1 line 2 line 3')
  })

  it('case 364', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'empty',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: '',
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]!.text).toBe('')
  })

  it('case 365', () => {
    const doc = new LoroDoc()
    appendElement(doc, {
      id: 'no-text',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })
    const summary = summarizeCanvas(doc)
    expect(summary.elements[0]!.text).toBeUndefined()
  })
})
