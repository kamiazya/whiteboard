import { describe, it, expect } from 'vitest'
import { buildAnnotationFields } from './annotation-fields.js'

const BASE = {
  elementId: 'el-1',
  x: 100,
  y: 200,
  strokeColor: '#e03131',
  now: 1_700_000_000_000,
  seed: 123,
  versionNonce: 456,
}

describe('suite 6', () => {
  it('case 204', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'rectangle' })
    expect(fields).toMatchObject({
      id: 'el-1',
      groupIds: [],
      boundElements: null,
      frameId: null,
      link: null,
      locked: false,
      isDeleted: false,
      updated: BASE.now,
      seed: BASE.seed,
      versionNonce: BASE.versionNonce,
      version: 1,
    })
  })
})

describe('buildAnnotationFields - arrow', () => {
  it('case 205', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'arrow' })
    expect(fields).toMatchObject({
      type: 'arrow',
      x: 100,
      y: 200,
      width: 100,
      height: 0,
      strokeColor: '#e03131',
      backgroundColor: 'transparent',
      points: [
        [0, 0],
        [100, 0],
      ],
      startArrowhead: null,
      endArrowhead: 'arrow',
      startBinding: null,
      endBinding: null,
    })
  })

  it('case 206', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'arrow', text: 'hi' })
    expect(fields.label).toEqual({ text: 'hi' })
  })

  it('case 207', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'arrow' })
    expect('label' in fields).toBe(false)
  })
})

describe('buildAnnotationFields - text', () => {
  it('case 208', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'text', text: 'hello' })
    expect(fields).toMatchObject({
      type: 'text',
      text: 'hello',
      originalText: 'hello',
      fontSize: 20,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      lineHeight: 1.2,
      containerId: null,
    })
  })

  it('case 209', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'text' })
    expect(fields.text).toBe('')
    expect(fields.originalText).toBe('')
  })

  it('case 210', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'Section Title',
      fontSize: 28,
    })
    expect(fields.fontSize).toBe(28)
  })

  it('case 211', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'rectangle',
      fontSize: 28,
    })
    expect('fontSize' in fields).toBe(false)
  })
})

describe('buildAnnotationFields - rectangle', () => {
  it('case 212', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'rectangle' })
    expect(fields).toMatchObject({
      type: 'rectangle',
      width: 120,
      height: 80,
      opacity: 100,
      fillStyle: 'hachure',
      backgroundColor: 'transparent',
      strokeColor: '#e03131',
    })
  })
})

describe('buildAnnotationFields - highlight', () => {
  it('case 213', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'highlight', strokeColor: '#f08c00' })
    expect(fields).toMatchObject({
      type: 'rectangle',
      opacity: 30,
      fillStyle: 'solid',
      backgroundColor: '#f08c00',
      strokeColor: '#f08c00',
    })
  })
})

describe('buildAnnotationFields - width/height override', () => {
  it('case 214', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'rectangle',
      width: 400,
      height: 120,
    })
    expect(fields.width).toBe(400)
    expect(fields.height).toBe(120)
  })

  it('case 215', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'rectangle' })
    expect(fields.width).toBe(120)
    expect(fields.height).toBe(80)
  })

  it('case 216', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'highlight',
      width: 300,
      height: 200,
    })
    expect(fields.width).toBe(300)
    expect(fields.height).toBe(200)
  })

  it('case 217', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'multi\nline',
      width: 500,
      height: 80,
    })
    expect(fields.width).toBe(500)
    expect(fields.height).toBe(80)
  })
  it('case 218', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'text', text: 'hi' })
    expect(fields.width).toBeGreaterThan(0)
    expect(fields.width).toBeLessThan(60)
    expect(fields.height).toBe(26)
  })

  it('case 219', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'line1\nline2\nline3',
    })
    expect(fields.height).toBe(78)
    expect(fields.width).toBeGreaterThanOrEqual(55)
  })

  it('case 220', () => {
    const a = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'LoroDoc.fromSnapshot()\n→ updateScene()',
    })
    const b = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: ['LoroDoc.fromSnapshot()', '→ updateScene()'].join('\n'),
    })
    expect(a.height).toBe(b.height)
    expect(a.width).toBe(b.width)
    expect(a.height).toBe(52)
  })

  it('case 221', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'text', text: '' })
    expect(fields.height).toBe(26)
    expect(fields.width).toBe(20) // Lower bound
  })

  it('case 222', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'short',
      width: 400,
      height: 120,
    })
    expect(fields.width).toBe(400)
    expect(fields.height).toBe(120)
  })

  it('case 223', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'This is a long sentence that should wrap when width is constrained',
      width: 120,
    })
    expect(fields.text).toContain('\n')
    expect(fields.width).toBe(120)
    expect(fields.height).toBeGreaterThan(26)
  })

  it('case 224', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'line 1\nline 2',
      width: 120,
      preserveLineBreaks: true,
    })
    expect(fields.text).toBe('line 1\nline 2')
  })
  it('case 225', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'text', text: 'hi' })
    expect(fields.fontFamily).toBe(5)
  })

  it('case 226', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: '~/.excalidraw/{workspaceId}/',
      fontFamily: 8,
    })
    expect(fields.fontFamily).toBe(8)
  })

  it('case 227', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'legacy note',
      fontFamily: 1,
    })
    expect(fields.fontFamily).toBe(1)
  })

  it('case 228', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'text',
      text: 'section header',
      fontFamily: 6,
    })
    expect(fields.fontFamily).toBe(6)
  })

})

describe('buildAnnotationFields - arrow endTarget', () => {
  it('case 229', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'arrow',
      endTarget: { x: 300, y: 250 },
    })
    expect(fields.points).toEqual([
      [0, 0],
      [200, 50],
    ])
    expect(fields.width).toBe(200)
    expect(fields.height).toBe(50)
  })

  it('case 230', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'arrow',
      endTarget: { x: 50, y: 150 },
    })
    expect(fields.points).toEqual([
      [0, 0],
      [-50, -50],
    ])
    expect(fields.width).toBe(50)
    expect(fields.height).toBe(50)
  })

  it('case 231', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'arrow' })
    expect(fields.points).toEqual([
      [0, 0],
      [100, 0],
    ])
    expect(fields.width).toBe(100)
    expect(fields.height).toBe(0)
  })
})
describe('suite 7', () => {
  it('case 232', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'rectangle',
      backgroundColor: '#fff3bf',
    })
    expect(fields.backgroundColor).toBe('#fff3bf')
    expect(fields.fillStyle).toBe('hachure')
  })

  it('case 233', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'rectangle',
      backgroundColor: '#d0bfff',
      fillStyle: 'solid',
    })
    expect(fields.backgroundColor).toBe('#d0bfff')
    expect(fields.fillStyle).toBe('solid')
  })

  it('case 234', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'rectangle',
      strokeWidth: 4,
    })
    expect(fields.strokeWidth).toBe(4)
  })

  it('case 235', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'arrow',
      strokeWidth: 3,
    })
    expect(fields.strokeWidth).toBe(3)
  })

  it('case 236', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'highlight',
    })
    expect(fields.backgroundColor).toBe('#e03131')
    expect(fields.fillStyle).toBe('solid')
  })

  it('case 237', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'highlight',
      backgroundColor: '#ffd8a8',
    })
    expect(fields.backgroundColor).toBe('#ffd8a8')
    expect(fields.fillStyle).toBe('solid')
  })

  it('case 238', () => {
    const rectFields = buildAnnotationFields({ ...BASE, type: 'rectangle' })
    expect(rectFields.backgroundColor).toBe('transparent')
    expect(rectFields.fillStyle).toBe('hachure')
    expect(typeof rectFields.strokeWidth).toBe('number')
  })
})
describe('buildAnnotationFields - templateInstanceId', () => {
  it('case 239', () => {
    const fields = buildAnnotationFields({
      ...BASE,
      type: 'rectangle',
      templateInstanceId: 'tpl-abc123',
    })
    expect(fields.templateInstanceId).toBe('tpl-abc123')
  })

  it('case 240', () => {
    for (const t of ['arrow', 'text', 'highlight'] as const) {
      const fields = buildAnnotationFields({
        ...BASE,
        type: t,
        templateInstanceId: 'tpl-xyz',
      })
      expect(fields.templateInstanceId).toBe('tpl-xyz')
    }
  })

  it('case 241', () => {
    const fields = buildAnnotationFields({ ...BASE, type: 'rectangle' })
    expect(fields.templateInstanceId).toBeUndefined()
  })
})
