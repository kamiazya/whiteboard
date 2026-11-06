import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PEN, readPen, writePen } from './pen-style.js'

afterEach(() => sessionStorage.removeItem('wb.pen'))

describe('the pen a tab remembers', () => {
  it('starts as the default pen', () => {
    expect(readPen()).toEqual(DEFAULT_PEN)
  })

  it('reads back the pen last written', () => {
    writePen({ color: '#1a2b3c', width: 'medium' })
    expect(readPen()).toEqual({ color: '#1a2b3c', width: 'medium' })
  })

  it('falls back to the default for a payload it cannot read', () => {
    sessionStorage.setItem('wb.pen', '{"width":"enormous"}')
    expect(readPen()).toEqual(DEFAULT_PEN)
    sessionStorage.setItem('wb.pen', 'not json')
    expect(readPen()).toEqual(DEFAULT_PEN)
  })
})
