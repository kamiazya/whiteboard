import { describe, expect, it, vi } from 'vitest'
import { loroRawElementSchema, validateLoroRawElements } from './loro-raw-element.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Schema acceptance/rejection tests ────────────────────────────────────────

describe('loroRawElementSchema', () => {
  it('rejects a row missing id', () => {
    const result = loroRawElementSchema.safeParse({ x: 0, y: 0, width: 10, height: 10 })
    expect(result.success).toBe(false)
  })

  it('rejects a row whose x is a string', () => {
    const result = loroRawElementSchema.safeParse({ id: 'a', x: 'left', y: 0, width: 10, height: 10 })
    expect(result.success).toBe(false)
  })

  it('rejects a row whose width is null', () => {
    const result = loroRawElementSchema.safeParse({ id: 'a', x: 0, y: 0, width: null, height: 10 })
    expect(result.success).toBe(false)
  })

  it('rejects a row whose height is a string', () => {
    const result = loroRawElementSchema.safeParse({ id: 'a', x: 0, y: 0, width: 10, height: 'tall' })
    expect(result.success).toBe(false)
  })

  it('accepts a fully-valid row and preserves arbitrary extra Excalidraw fields', () => {
    const input = {
      id: 'rect-1',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      type: 'rectangle',
      fileId: null,
      strokeColor: '#000000',
      angle: 0,
      boundElements: [],
    }
    const result = loroRawElementSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('rectangle')
      expect(result.data.strokeColor).toBe('#000000')
      expect(result.data.angle).toBe(0)
      expect(result.data.boundElements).toEqual([])
    }
  })

  it('accepts well-typed optional parentId/relX/relY/isDeleted', () => {
    const input = {
      id: 'ann-1',
      x: 5,
      y: 5,
      width: 20,
      height: 20,
      parentId: 'rect-1',
      relX: 0.5,
      relY: 0.5,
      isDeleted: false,
    }
    const result = loroRawElementSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('rejects relX when present but wrong-typed', () => {
    const result = loroRawElementSchema.safeParse({
      id: 'a',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      relX: 'mid',
    })
    expect(result.success).toBe(false)
  })

  it('rejects isDeleted when present but wrong-typed', () => {
    const result = loroRawElementSchema.safeParse({
      id: 'a',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      isDeleted: 'yes',
    })
    expect(result.success).toBe(false)
  })
})

// ── Helper behaviour tests ────────────────────────────────────────────────────

describe('validateLoroRawElements', () => {
  const validRect = { id: 'r1', x: 0, y: 0, width: 10, height: 10 }
  const corruptRow = { x: 0, y: 0, width: 10, height: 10 } // missing id

  it('returns only valid rows from a mixed array in original order', () => {
    const valid2 = { id: 'r2', x: 1, y: 1, width: 5, height: 5 }
    const result = validateLoroRawElements([validRect, corruptRow, valid2])
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('r1')
    expect(result[1].id).toBe('r2')
  })

  it('calls onDropped exactly once per dropped row with the correct index', () => {
    const onDropped = vi.fn()
    validateLoroRawElements([validRect, corruptRow, corruptRow], onDropped)
    expect(onDropped).toHaveBeenCalledTimes(2)
    expect(onDropped.mock.calls[0][0].index).toBe(1)
    expect(onDropped.mock.calls[1][0].index).toBe(2)
  })

  it('is a structural pass-through on an all-valid array and never calls onDropped', () => {
    const onDropped = vi.fn()
    const input = [
      { id: 'r1', x: 0, y: 0, width: 10, height: 10 },
      { id: 'r2', x: 1, y: 1, width: 5, height: 5 },
    ]
    const result = validateLoroRawElements(input, onDropped)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject(input[0])
    expect(result[1]).toMatchObject(input[1])
    expect(onDropped).not.toHaveBeenCalled()
  })

  it('returns empty array for empty input', () => {
    expect(validateLoroRawElements([])).toEqual([])
  })

  it('passes onDropped the ZodError and raw value', () => {
    const onDropped = vi.fn()
    validateLoroRawElements([corruptRow], onDropped)
    expect(onDropped).toHaveBeenCalledTimes(1)
    const info = onDropped.mock.calls[0][0]
    expect(info.index).toBe(0)
    expect(info.error).toBeDefined()
    expect(info.raw).toBe(corruptRow)
  })
})

// ── Dependency-purity guard ───────────────────────────────────────────────────
// loro-raw-element.ts must import ONLY zod (plus an optional type-only
// ParentedElement). It must NOT import getLogger or any server-side module,
// because it is bundled into the browser via useWhiteboardSync.

describe('loro-raw-element dependency purity', () => {
  it('does not import getLogger or any server path', () => {
    const filePath = fileURLToPath(new URL('./loro-raw-element.ts', import.meta.url))
    const source = readFileSync(filePath, 'utf-8')
    expect(source).not.toMatch(/getLogger/)
    expect(source).not.toMatch(/['"].*\/server\//)
    expect(source).not.toMatch(/from ['"].*server/)
  })
})
