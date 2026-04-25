import { describe, it, expect } from 'vitest'
import { decomposeBoxWithLabel } from './box-with-label.js'
describe('decomposeBoxWithLabel - autoExpandedBy diagnostic', () => {
  it('case 14', () => {
    const [rect, , diag] = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 200,
      height: 40, // Expected to be too short for 5 lines
      text: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'],
      autoFit: true,
    })
    expect(rect.height).toBeGreaterThan(40) // The rect really expands
    expect((diag as { autoExpandedBy?: number }).autoExpandedBy ?? 0).toBeGreaterThan(0)
    expect(diag.overflow).toBe(false)
    expect((diag as { actualHeight?: number }).actualHeight).toBe(rect.height)
  })

  it('case 15', () => {
    const [, , diag] = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 200,
      height: 40,
      text: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'],
      autoFit: false,
    })
    expect((diag as { autoExpandedBy?: number }).autoExpandedBy ?? 0).toBe(0)
    expect(diag.overflow).toBe(true)
  })

  it('case 16', () => {
    const [, , diag] = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 400,
      height: 200,
      text: 'short line',
      autoFit: true,
    })
    expect((diag as { autoExpandedBy?: number }).autoExpandedBy ?? 0).toBe(0)
  })
})

describe('decomposeBoxWithLabel', () => {
  it('case 17', () => {
    const [rect] = decomposeBoxWithLabel({
      target: { x: 100, y: 200 },
      width: 300,
      height: 120,
      text: 'HELLO',
      color: '#1971c2',
    })
    expect(rect).toEqual({
      type: 'rectangle',
      target: { x: 100, y: 200 },
      width: 300,
      height: 120,
      color: '#1971c2',
    })
  })

  it('case 18', () => {
    const [, text] = decomposeBoxWithLabel({
      target: { x: 100, y: 200 },
      width: 300,
      height: 120,
      text: 'HELLO',
      color: '#1971c2',
    })
    expect(text).toEqual({
      type: 'text',
      target: { x: 100, y: 200 },
      text: 'HELLO',
      color: '#1971c2',
      width: 300,
      height: 120,
    })
  })

  it('case 19', () => {
    const [rect, text] = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 100,
      height: 40,
      text: 'X',
    })
    expect(rect.color).toBeUndefined()
    expect(text.color).toBeUndefined()
  })

  it('case 20', () => {
    const [, text] = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 400,
      height: 80,
      text: 'This is a very long label that should wrap inside the container',
      color: '#e03131',
    })
    expect(text).toMatchObject({
      target: { x: 0, y: 0 },
      width: 400,
      height: 80,
    })
  })

  it('case 21', () => {
    const result = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 100,
      height: 40,
      text: 'A',
    })
    expect(result).toHaveLength(3)
    expect(result[0].type).toBe('rectangle')
    expect(result[1].type).toBe('text')
    expect(result[2]).toMatchObject({ overflow: expect.any(Boolean) })
  })
  it('case 22', () => {
    const [, text] = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 200,
      height: 100,
      text: ['Title', 'subtitle'],
    })
    expect(text.text).toBe('Title\nsubtitle')
  })

  it('case 23', () => {
    const [, text] = decomposeBoxWithLabel({
      target: { x: 10, y: 20 },
      width: 200,
      height: 100,
      text: ['Title', 'subtitle'],
    })
    expect(text).toMatchObject({
      target: { x: 10, y: 20 },
      width: 200,
      height: 100,
    })
  })

  it('case 24', () => {
    const fromString = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 200,
      height: 100,
      text: 'ONLY',
    })
    const fromArray = decomposeBoxWithLabel({
      target: { x: 0, y: 0 },
      width: 200,
      height: 100,
      text: ['ONLY'],
    })
    expect(fromArray).toEqual(fromString)
  })
  describe('diagnostics', () => {
    it('case 25', () => {
      const [, , diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 300,
        height: 60,
        text: 'HELLO',
      })
      expect(diag.overflow).toBe(false)
      expect(diag.requiredWidth).toBeGreaterThan(0)
      expect(diag.requiredHeight).toBeGreaterThan(0)
    })

    it('case 26', () => {
      const [, , diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 50,
        height: 30,
        text: 'This is a very long single-line label that cannot fit',
        autoFit: false,
      })
      expect(diag.overflow).toBe(true)
      expect(diag.requiredHeight).toBeGreaterThan(20)
    })

    it('case 27', () => {
      const [, , ascii] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 80,
        height: 40,
        text: 'ABCDE',
      })
      const [, , cjk] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 80,
        height: 40,
        text: 'ＦＵＬＬＷＩＤＴＨ',
      })
      expect(cjk.requiredWidth).toBeGreaterThan(ascii.requiredWidth)
    })

    it('case 28', () => {
      const [, , diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 400,
        height: 30, // Only tall enough for one line
        text: ['Line 1', 'Line 2', 'Line 3', 'Line 4'],
        autoFit: false,
      })
      expect(diag.overflow).toBe(true)
      expect(diag.requiredHeight).toBeGreaterThan(20)
    })

    it('case 29', () => {
      const [, , diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 500,
        height: 200,
        text: ['short', 'a much longer second line'],
      })
      expect(diag.requiredWidth).toBeGreaterThan(11 * 10) // "short" < "a much longer..."
    })
  })
  describe('subText (default inside-bottom)', () => {
    it('case 30', () => {
      const result = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 80,
        text: 'MAIN',
      })
      expect(result[3]).toBeUndefined()
    })

    it('case 31', () => {
      const [, , , sub] = decomposeBoxWithLabel({
        target: { x: 100, y: 200 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
      })
      expect(sub).toBeDefined()
      expect(sub!.type).toBe('text')
      expect(sub!.text).toBe('caption')
    })

    it('case 32', () => {
      const [rect, , , sub] = decomposeBoxWithLabel({
        target: { x: 100, y: 200 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
      })
      expect(sub!.target.y).toBeGreaterThanOrEqual(rect.target.y)
      expect(sub!.target.y + sub!.height).toBeLessThanOrEqual(rect.target.y + rect.height)
      expect(sub!.target.y).toBeGreaterThan(rect.target.y + rect.height / 2)
    })

    it('case 33', () => {
      const [rect, , , sub] = decomposeBoxWithLabel({
        target: { x: 100, y: 200 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
      })
      expect(sub!.target.x).toBe(rect.target.x)
      expect(sub!.width).toBe(rect.width)
    })

    it('case 34', () => {
      const [rect, , , sub] = decomposeBoxWithLabel({
        target: { x: 0, y: 200 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
      })
      expect(sub!.height).toBeLessThan(rect.height)
      expect(sub!.height).toBeGreaterThan(0)
    })

    it('case 35', () => {
      const [, , , sub] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: ['line 1', 'line 2'],
      })
      expect(sub!.text).toBe('line 1\nline 2')
    })

    it('case 36', () => {
      const [rect, main, , sub] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
        color: '#1971c2',
      })
      expect(rect.color).toBe('#1971c2')
      expect(main.color).toBe('#1971c2')
      expect(sub!.color).toBe('#1971c2')
    })
  })

  describe('title + subText composition', () => {
    it('case 37', () => {
      const [, body, , , title] = decomposeBoxWithLabel({
        target: { x: 100, y: 200 },
        width: 240,
        height: 120,
        title: 'Option A',
        text: ['Use everyday wording', 'Keep changes minimal for clarity'],
      })
      expect(title).toBeDefined()
      expect(title!.type).toBe('text')
      expect(title!.text).toBe('Option A')
      expect(body.text).toContain('Use everyday wording')
    })

    it('case 38', () => {
      const [, body, , , title] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 240,
        height: 120,
        title: 'Option A',
        text: ['Use everyday wording', 'Keep changes minimal for clarity'],
      })
      expect(title!.target.y).toBeLessThan(body.target.y)
    })

    it('case 39', () => {
      const [, main, , sub, title] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
      })
      expect(main.text).toBe('MAIN')
      expect(sub).toBeDefined()
      expect(sub!.text).toBe('caption')
      expect(title).toBeUndefined()
    })

    it('case 40', () => {
      const [, body, , sub, title] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 240,
        height: 140,
        title: 'Option A',
        text: ['Use everyday wording', 'Keep changes minimal for clarity'],
        subText: 'Recommended',
      })
      expect(title!.text).toBe('Option A')
      expect(body.text).toContain('Use everyday wording')
      expect(sub!.text).toBe('Recommended')
    })
  })
  describe('subTextPosition: inside-bottom', () => {
    it('case 41', () => {
      const [rect, , , sub] = decomposeBoxWithLabel({
        target: { x: 100, y: 200 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
      })
      expect(sub!.target.y).toBeGreaterThanOrEqual(rect.target.y)
      expect(sub!.target.y + sub!.height).toBeLessThanOrEqual(rect.target.y + rect.height)
    })

    it('case 42', () => {
      const [rect, , , sub] = decomposeBoxWithLabel({
        target: { x: 100, y: 200 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
        subTextPosition: 'inside-bottom',
      })
      expect(sub!.target.y).toBeGreaterThanOrEqual(rect.target.y)
      expect(sub!.target.y + sub!.height).toBeLessThanOrEqual(rect.target.y + rect.height)
      expect(sub!.target.y).toBeGreaterThan(rect.target.y + rect.height / 2)
    })

    it('case 43', () => {
      const [rect, main] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
        subTextPosition: 'inside-bottom',
      })
      expect(main.height).toBeLessThan(rect.height)
      expect(main.target.y).toBe(rect.target.y)
    })

    it('case 44', () => {
      const [, main, , sub] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
        subTextPosition: 'inside-bottom',
      })
      expect(main.target.y + main.height).toBeLessThanOrEqual(sub!.target.y)
    })

    it('case 45', () => {
      const [rect, , , sub] = decomposeBoxWithLabel({
        target: { x: 100, y: 200 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
        subTextPosition: 'inside-bottom',
      })
      expect(sub!.target.x).toBe(rect.target.x)
      expect(sub!.width).toBe(rect.width)
    })

    it('case 46', () => {
      const [, , , sub] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: ['line 1', 'line 2'],
        subTextPosition: 'inside-bottom',
      })
      expect(sub!.text).toBe('line 1\nline 2')
    })

    it('case 47', () => {
      const [rect, , , sub] = decomposeBoxWithLabel({
        target: { x: 100, y: 200 },
        width: 200,
        height: 80,
        text: 'MAIN',
        subText: 'caption',
        subTextPosition: 'top',
      })
      expect(sub!.target.y).toBeLessThan(rect.target.y)
    })
  })
  describe('autoFit', () => {
    it('case 48', () => {
      const [rect, text, diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 30,
        text: 'This is a long text that will definitely wrap into many lines and overflow',
      })
      expect(rect.height).toBeGreaterThan(30)
      expect(rect.height).toBe(text.height)
      expect(diag.overflow).toBe(false)
    })

    it('case 49', () => {
      const [rect, text, diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 30,
        text: 'This is a long text that will definitely wrap into many lines and overflow',
        autoFit: false,
      })
      expect(rect.height).toBe(30)
      expect(text.height).toBe(30)
      expect(diag.overflow).toBe(true)
    })

    it('case 50', () => {
      const [rect, text, diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 30,
        text: 'This is a long text that will definitely wrap into many lines and overflow',
        autoFit: true,
      })
      expect(diag.overflow).toBe(false)
      expect(rect.height).toBe(text.height)
      expect(rect.height).toBeGreaterThan(30)
      expect(rect.height).toBeGreaterThanOrEqual(diag.requiredHeight + 10)
    })

    it('case 51', () => {
      const [rect, , diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 400,
        height: 100,
        text: 'short',
        autoFit: true,
      })
      expect(diag.overflow).toBe(false)
      expect(rect.height).toBe(100)
    })

    it('case 52', () => {
      const [rect, , diag, sub] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 30,
        text: 'This is a long text that will definitely wrap into many lines and overflow',
        subText: 'caption',
        subTextPosition: 'top',
        autoFit: true,
      })
      expect(diag.overflow).toBe(false)
      expect(rect.height).toBeGreaterThan(30)
      expect(sub!.target.y).toBeLessThan(rect.target.y)
    })

    it('case 53', () => {
      const [rect, main, diag, sub] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 200,
        height: 30,
        text: 'This is a long text that will definitely wrap into many lines and overflow',
        subText: 'caption',
        subTextPosition: 'inside-bottom',
        autoFit: true,
      })
      expect(diag.overflow).toBe(false)
      expect(rect.height).toBeGreaterThan(30)
      expect(main.target.y + main.height).toBeLessThanOrEqual(sub!.target.y)
      expect(sub!.target.y + sub!.height).toBeLessThanOrEqual(rect.target.y + rect.height)
    })
    it('case 54', () => {
      const [, text, diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 360,
        height: 120,
        text: ['@kamiazya/whiteboard-mcp', '(npmjs.com · bin: whiteboard-mcp)'],
      })
      const wrappedLines = text.text.split('\n')
      expect(wrappedLines.length).toBeGreaterThan(2)
      expect(diag.overflow).toBe(false)
    })

    it('case 55', () => {
      const [, text, diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 360,
        height: 120,
        text: ['@kamiazya/whiteboard-mcp', '(npmjs.com · bin: whiteboard-mcp)'],
        autoFit: false,
      })
      const lines = text.text.split('\n')
      expect(lines).toEqual([
        '@kamiazya/whiteboard-mcp',
        '(npmjs.com · bin: whiteboard-mcp)',
      ])
      expect(diag.overflow).toBe(true)
    })

    it('case 56', () => {
      const [, text, diag] = decomposeBoxWithLabel({
        target: { x: 0, y: 0 },
        width: 500,
        height: 120,
        text: ['short', 'also short'],
      })
      expect(text.text.split('\n')).toEqual(['short', 'also short'])
      expect(diag.overflow).toBe(false)
    })
  })
})
